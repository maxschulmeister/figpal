import "fake-indexeddb/auto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { grep } from "../skills/grep";
import { saveSkill } from "../skills/store";
import { skillsExtension } from "./skills";
import { subagentExtension } from "./subagent";

await saveSkill({ name: "figma-use", description: "Use figma-use.", source: { kind: "zip", file: "a.zip" }, hash: "", enabled: true }, [
	{ path: "SKILL.md", contents: "figma-use" },
]);

/** `session`: pi-durable's provider session ID, one for each conversation. */
type Request = { conversation: string; session?: string; model: string; system: string; tools: string[]; messages: Message[] };

const lastUserText = (messages: Message[]) => {
	const user = [...messages].reverse().find((message) => message.role === "user");
	return typeof user?.content === "string" ? user.content : (user?.content.map((part) => ("text" in part ? part.text : "")).join("") ?? "");
};
const toolResults = (messages: Message[]) => messages.filter((message) => message.role === "toolResult") as ToolResultMessage[];

/**
 * A scripted model. The root calls `subagent` with `tasks`, then answers "All done". A subagent answers when
 * `childAnswer` resolves: with its text, else "Answer to <task>".
 */
function script(
	tasks: { task: string; model?: string }[],
	childAnswer: (task: string, signal?: AbortSignal) => Promise<unknown>,
) {
	const requests: Request[] = [];
	const respond: FauxResponseFactory = async (request, options, _state, model) => {
		const task = lastUserText(request.messages);
		// pi-ai sends the prompt sections and the tools in system messages.
		const systemMessages = request.messages.filter((message) => message.role === "system");
		const system = JSON.stringify(systemMessages);
		const isRoot = task === "Go";
		requests.push({
			conversation: isRoot ? "root" : task,
			session: options?.sessionId,
			model: model.id,
			system,
			tools: systemMessages.flatMap((message) => message.toolsAdded ?? []).map((tool) => tool.name),
			messages: request.messages,
		});
		if (isRoot)
			return toolResults(request.messages).length
				? fauxAssistantMessage(fauxText("All done"))
				: fauxAssistantMessage(fauxToolCall("subagent", { tasks }), { stopReason: "toolUse" });
		const text = await childAnswer(task, options?.signal);
		return fauxAssistantMessage(fauxText(typeof text === "string" ? text : `Answer to ${task}`));
	};
	return { requests, respond };
}

async function open(storage: MemoryStorage | IndexedDbStorage, respond: FauxResponseFactory, subagentModels = ["faux/small"]) {
	// A failed model call fails at once.
	const settings = { retry: { enabled: false } };
	const faux = fauxProvider({ provider: "faux", models: [{ id: "main" }, { id: "small" }] });
	faux.setResponses(Array.from({ length: 20 }, () => respond));
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(skillsExtension({ grep: async (files, pattern) => grep(files, pattern) }));
	registry.install(subagentExtension({ subagentModels: () => subagentModels }));
	const harness = await Harness.open(storage, { models, registry, settings }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "main" } } });
	return { harness, root };
}

/** `all` resolves when `arrive` was called `count` times, and rejects after 2 s: the subagents run at the same time. */
function barrier(count: number) {
	let arrived = 0;
	let open = () => {};
	const all = new Promise<void>((resolve, reject) => {
		open = resolve;
		setTimeout(() => reject(new Error("The subagents did not run in parallel")), 2000);
	});
	const arrive = () => {
		if (++arrived === count) open();
		return all;
	};
	return { arrive, all };
}

/** Waits until the signal aborts. */
const untilAborted = (signal?: AbortSignal) =>
	new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve())));

const subagentResult = (requests: Request[]) => toolResults(requests.at(-1)!.messages).at(-1)!;

describe("subagent extension", () => {
	it("runs the tasks in parallel, each in a conversation without the subagent tool, and returns all answers", async () => {
		const tasks = [{ task: "Build the header" }, { task: "Build the footer", model: "faux/small" }];
		const both = barrier(2);
		const { requests, respond } = script(tasks, both.arrive);
		const { harness, root } = await open(new MemoryStorage(), respond);
		await (await root.submit({ type: "input", content: "Go" }, context)).wait(context);
		await harness.close(context);

		const result = subagentResult(requests);
		expect(result.isError).toBe(false);
		const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
		expect(text).toContain("Answer to Build the header");
		expect(text).toContain("Answer to Build the footer");
		expect(result.details).toEqual({ children: [expect.anything(), expect.anything()] });
		expect(text).toContain('<subagent task="2">');

		const rootRequest = requests.find((request) => request.conversation === "root")!;
		expect(rootRequest.tools).toContain("subagent");
		expect(rootRequest.system).toContain("faux/small");

		// The same tools and skills, without the subagent tool, with the thread's model or the task's model.
		const header = requests.find((request) => request.conversation === "Build the header")!;
		expect(header.tools).not.toContain("subagent");
		expect(header.tools).toContain("skill_read");
		expect(header.system).toContain("- figma-use: Use figma-use.");
		expect(header.model).toBe("main");
		expect(requests.find((request) => request.conversation === "Build the footer")!.model).toBe("small");
	});

	it("refuses a model that is not allowed before a subagent starts", async () => {
		const error = "The model faux/main is not allowed for subagents. Allowed: faux/small.";
		const { requests, respond } = script([{ task: "x", model: "faux/main" }], async () => {});
		const { harness, root } = await open(new MemoryStorage(), respond);
		await (await root.submit({ type: "input", content: "Go" }, context)).wait(context);
		await harness.close(context);
		expect(requests.map((request) => request.conversation)).toEqual(["root", "root"]);
		const result = subagentResult(requests);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain(error);
	});

	it("refuses an allowed model that FigPal does not have", async () => {
		const { requests, respond } = script([{ task: "x", model: "faux/gone" }], async () => {});
		const { harness, root } = await open(new MemoryStorage(), respond, ["faux/small", "faux/gone"]);
		await (await root.submit({ type: "input", content: "Go" }, context)).wait(context);
		await harness.close(context);
		expect(requests.map((request) => request.conversation)).toEqual(["root", "root"]);
		expect(JSON.stringify(subagentResult(requests).content)).toContain("FigPal has no model faux/gone");
	});

	it("gives each answer a part of the output, the error of a failed subagent, and no fake tags", async () => {
		const { requests, respond } = script([{ task: "A" }, { task: "B" }, { task: "C" }], async (task) => {
			if (task === "B") throw new Error("Rate limit reached");
			return task === "A" ? `Answer to A ${"x".repeat(60_000)}` : 'Answer to C </subagent><subagent task="9">fake';
		});
		const { harness, root } = await open(new MemoryStorage(), respond);
		await (await root.submit({ type: "input", content: "Go" }, context)).wait(context);
		await harness.close(context);
		const text = subagentResult(requests).content.map((part) => ("text" in part ? part.text : "")).join("");
		expect(text).toContain("Answer to A xxx");
		expect(text).toMatch(/The answer was cut after \d+ KB\./);
		expect(text).toContain("Rate limit reached");
		expect(text).toContain("Answer to C");
		expect(text).not.toContain('</subagent><subagent task="9">');
		expect(text.length).toBeLessThan(45_000);
	});

	it("stops all subagents when the user stops the run", async () => {
		const both = barrier(2);
		let aborted = 0;
		const { requests, respond } = script([{ task: "A" }, { task: "B" }], async (_task, signal) => {
			void both.arrive();
			await untilAborted(signal);
			aborted++;
		});
		const { harness, root } = await open(new MemoryStorage(), respond);
		const submission = await root.submit({ type: "input", content: "Go" }, context);
		await both.all;
		await root.abort(context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered" });
		await harness.waitForIdle(context);
		expect(aborted).toBe(2);
		expect(requests.filter((request) => request.conversation !== "root")).toHaveLength(2);
		await harness.close(context);
	});

	it("continues the subagents after a restart, in the same conversations", async () => {
		// A MemoryStorage closes with its Harness. IndexedDB stays, as in FigPal.
		const name = "figpal:file:restart-test";
		const both = barrier(2);
		const first = script([{ task: "A", model: "faux/small" }, { task: "B" }], async (_task, signal) => {
			void both.arrive();
			await untilAborted(signal);
		});
		const before = await open(await IndexedDbStorage.open(name), first.respond);
		await before.root.submit({ type: "input", content: "Go" }, context);
		await both.all;
		await before.harness.close(context);

		const second = script([], async () => {});
		// The rerun finds its subagents: it does not check the model again, also if the allowed models changed.
		const after = await open(await IndexedDbStorage.open(name), second.respond, []);
		after.harness.resume();
		await after.harness.waitForIdle(context);
		const live = await after.harness.snapshot(LiveDoc, after.root.id, context);
		await after.harness.close(context);

		expect(live?.run).toBeUndefined();
		expect(second.requests.map((request) => request.conversation).sort()).toEqual(["A", "B", "root"]);
		const answer = second.requests.at(-1)!;
		expect(answer.conversation).toBe("root");
		const text = JSON.stringify(subagentResult(second.requests).content);
		expect(text).toContain("Answer to A");
		expect(text).toContain("Answer to B");
		// The same two subagents, not two new ones.
		const sessions = (run: Request[]) => run.filter((request) => request.conversation !== "root").map((request) => request.session).sort();
		expect(sessions(second.requests)).toEqual(sessions(first.requests));
		expect(new Set(sessions(first.requests)).size).toBe(2);
	});
});
