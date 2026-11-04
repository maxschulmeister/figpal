// The `subagent` extension: the main agent runs independent tasks in parallel, each in a child conversation that the
// tool call owns (pi-durable example 21). Stopping the call stops the children, and after a restart the call finds
// the same children and submissions. A child has the same tools without `subagent`, and it starts without history.

import type { Context } from "@earendil-works/chord";
import { boundOutput } from "@earendil-works/chord/output";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineExtension,
	defineTool,
	type Extension,
	type ModelRef,
	section,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { parseModelRef } from "../settings";

const MAX_TASKS = 8;
/** All answers together stay below pi-durable's tool output limits (50 KB, 2000 lines): each gets an equal part. */
const ANSWERS_BYTES = 40_000;
const ANSWERS_LINES = 1800;

/** The tool details: the children in task order. The UI shows the transcript of each under the call. */
export type SubagentDetails = { children: ConversationId[] };

type Options = {
	/** "provider/modelId" that the main agent can give to a task. From the settings in memory: no code.js call. */
	subagentModels(): string[];
};

/** The model of each task, checked before any child starts. Undefined: the thread's model. */
function taskModels(tasks: { model?: string }[], allowed: string[], models: Models): (ModelRef | undefined)[] {
	return tasks.map(({ model }) => {
		if (model === undefined) return undefined;
		if (!allowed.includes(model))
			throw new Error(`The model ${model} is not allowed for subagents. Allowed: ${allowed.join(", ") || "none"}.`);
		const ref = parseModelRef(model);
		if (!ref || !models.getModel(ref.provider, ref.modelId)) throw new Error(`FigPal has no model ${model}.`);
		return ref;
	});
}

/** The answer within its part of the output. A tag in the answer cannot end its <subagent> block. */
function boundAnswer(answer: string, share: number): string {
	const slice = boundOutput(answer, { maxBytes: Math.floor(ANSWERS_BYTES / share), maxLines: Math.floor(ANSWERS_LINES / share), retain: "head" });
	const cut = slice.droppedBytes ? `\n… The answer was cut after ${Math.round(slice.bytes / 1000)} KB.` : "";
	return (slice.text + cut).replaceAll("</subagent", "<\\/subagent");
}

export function subagentExtension(options: Options): Extension {
	const extension: Extension = defineExtension({
		name: "subagent",
		sections: [
			section("subagents", () => {
				const models = options.subagentModels();
				return [
					"Use the subagent tool for independent tasks that can run at the same time, for example one section of a page each. On the canvas, give each subagent its own frame or section.",
					...(models.length ? [`Models for subagents (the model field): ${models.join(", ")}. Without a model, a subagent uses yours.`] : []),
				].join("\n");
			}),
		],
		tools: [
			defineTool({
				name: "subagent",
				description: `Runs 1 to ${MAX_TASKS} tasks at the same time, each in a subagent: a new conversation with your other tools and without your history. Returns the last answer of each subagent.`,
				parameters: obj(
					{
						tasks: arr(
							obj(
								{
									task: str({ description: "All that the subagent must know: the goal, node IDs, what to return." }),
									model: opt(str({ description: "A model from the subagents section." })),
								},
								{ open: true },
							),
							{ minItems: 1, maxItems: MAX_TASKS },
						),
					},
					{ open: true },
				),
				// A rerun after a restart finds the children and the submissions that it made before.
				replay: "safe",
				execute: async ({ tasks }, api, context) => {
					// One commit makes all children, so a rerun after a restart finds all or none, in this order. It does
					// not check the models again: the allowed models can be different now.
					let children = await api.commit(
						async (tx) => (await tx.scanConversations({ ownerTaskId: api.taskId }, tasks.length)).items.map((item) => item.id),
						context,
					);
					if (!children.length) {
						const models = taskModels(tasks, options.subagentModels(), api.models);
						children = await api.commit(async (tx) => {
							const ids: ConversationId[] = [];
							for (const model of models) {
								// A child starts as a copy of this conversation's agent.
								const { id } = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
								await configure(tx, id, { extensions: { remove: [extension] }, ...(model && { model }) });
								ids.push(id);
							}
							return ids;
						}, context);
					}
					const details: SubagentDetails = { children };
					await api.details(details, context);

					const answers = await Promise.all(children.map((id, index) => run(api, id, tasks[index]!.task, context)));
					const text = answers
						.map((answer, index) => `<subagent task="${index + 1}">\n${boundAnswer(answer, answers.length)}\n</subagent>`)
						.join("\n\n");
					return { output: [{ type: "text", text }], details };
				},
			}),
		],
	});
	return extension;
}

/** Submits the task to the child (once, also after a restart) and gives its last answer. */
async function run(api: ToolExecutionApi, child: ConversationId, task: string, context: Context): Promise<string> {
	const conversation = await api.conversation(child, context);
	if (!conversation) throw new Error(`The subagent conversation ${child} does not exist`);
	const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
	const settled = await (await conversation.submit(request, context)).wait(context);
	if (settled.status === "unanswered") {
		// The detail has the cause, for example a rate limit: the main agent can try again or use another model.
		const { reason, detail } = settled;
		const cause = detail === undefined ? "" : `: ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 1000)}`;
		return `The subagent stopped (${reason})${cause}`;
	}
	if (settled.type !== "input") return `The subagent stopped (${settled.status}).`;
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return (message && contentText(message.content, "")) || "(The subagent gave no text.)";
}
