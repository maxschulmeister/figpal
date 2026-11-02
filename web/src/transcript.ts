// Turns the pi-durable view of a conversation into assistant-ui messages.

import type { ThreadMessageLike } from "@assistant-ui/react";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	AgentDoc,
	type AgentState,
	type ConversationView,
	defineEntry,
	InboxDoc,
	type InboxState,
	LiveDoc,
	type LiveState,
} from "@earendil-works/pi-durable";

/** A user message from FigPal. `data.text` is what the user typed, without the Figma context block. */
export const UserText = defineEntry<{ text: string }>("figpal.user");

type Part = Exclude<ThreadMessageLike["content"], string>[number];

export type Thread = {
	messages: ThreadMessageLike[];
	isRunning: boolean;
	/** The model call failed and runs again at `at`. */
	retry?: { at: number; error: string };
	/** The model and thinking level of the thread. pi-durable uses thinking level "off" when it has none. */
	agent?: AgentState;
	/** The size of the newest request, as its provider reported it. Undefined before the first answer. */
	contextTokens?: number;
	/** The messages that wait in the inbox: steers join the running work, follow-ups start the next run. */
	queue: { steer: QueuedMessage[]; followUp: QueuedMessage[] };
};

/** A waiting message: its submission ID and the typed text. */
export type QueuedMessage = { id: string; text: string };

/**
 * One user message for each user entry, and one assistant message for each answer to it: all model responses and
 * tool calls of the run. Tool results go into their tool-call part.
 */
export function toThread(view: ConversationView): Thread {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of view.entries)
		for (const message of entry.model ?? []) if (message.role === "toolResult") results.set(message.toolCallId, message);
	const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
	// The details of a running call. The subagent call names its children here.
	const running = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot.details]));

	const messages: ThreadMessageLike[] = [];
	let userId = "start";
	let contextTokens: number | undefined;
	// After a compaction, the kept answers measured the context before it (pi-durable's estimateContext does the same).
	const compacted = view.entries.find((entry) => entry.head !== undefined)?.id ?? Number.NEGATIVE_INFINITY;
	/** `entryId` is absent for the streamed part of the running answer. */
	const answer = (response: AssistantMessage, entryId?: number) => {
		const last = messages.at(-1);
		const parts = assistantParts(response, results, running);
		const status = responseStatus(response);
		// A fork from this message keeps the history up to its last entry.
		const metadata = entryId === undefined ? last?.metadata : { custom: { lastEntryId: entryId } };
		if (last?.role === "assistant")
			messages[messages.length - 1] = { ...last, content: [...(last.content as Part[]), ...parts], status, metadata };
		else messages.push({ id: `after-${userId}`, role: "assistant", status, metadata, content: parts });
	};

	for (const entry of view.entries) {
		if (UserText.is(entry)) {
			userId = String(entry.id);
			messages.push({ id: userId, role: "user", content: [{ type: "text", text: entry.data.text }] });
			continue;
		}
		for (const message of entry.model ?? []) {
			if (message.role !== "assistant") continue;
			answer(message, entry.id);
			// An answer that stopped before the provider counted has no tokens.
			if (entry.id > compacted) contextTokens = calculateContextTokens(message.usage) || contextTokens;
		}
	}

	if (live?.generation?.message) answer(live.generation.message as AssistantMessage);
	const isRunning = live?.run !== undefined;
	const last = messages.at(-1);
	if (isRunning && last?.role === "assistant") messages[messages.length - 1] = { ...last, status: { type: "running" } };
	const agent = view.docs[AgentDoc.definition.kind] as AgentState | undefined;
	const inbox = (view.docs[InboxDoc.definition.kind] as InboxState | undefined)?.items ?? [];
	// The entry of a waiting input is a draft, not an entry record: its kind and text, checked here.
	const textOf = (entry: { kind: string; data?: unknown } | undefined) => {
		const text = entry?.kind === UserText.kind && (entry.data as { text?: unknown } | undefined)?.text;
		return typeof text === "string" ? text : undefined;
	};
	const queued = (mode: "steer" | "followUp") =>
		inbox.flatMap((item) => {
			const text = item.mode === mode ? textOf(item.entry) : undefined;
			return text === undefined ? [] : [{ id: String(item.id), text }];
		});
	const queue = { steer: queued("steer"), followUp: queued("followUp") };
	return { messages, isRunning, retry: live?.generation?.retry, agent, contextTokens, queue };
}

function assistantParts(
	response: AssistantMessage,
	results: Map<string, ToolResultMessage>,
	running: Map<string, unknown>,
): Part[] {
	const parts = response.content.flatMap((block): Part[] => {
		if (block.type === "text") return [{ type: "text", text: block.text }];
		if (block.type === "thinking") return [{ type: "reasoning", text: block.thinking }];
		if (block.type === "toolCall") {
			const result = results.get(block.id);
			const details = result ? result.details : running.get(block.id);
			return [
				{
					type: "tool-call",
					toolCallId: block.id,
					toolName: block.name,
					args: block.arguments,
					...(result && { result: result.content, isError: result.isError }),
					...(details !== undefined && { artifact: details }),
				},
			];
		}
		return [];
	});
	// Claude splits a cited answer into text blocks, also in the middle of a sentence: one part each would show as
	// paragraphs.
	return parts.reduce<Part[]>((joined, part) => {
		const last = joined.at(-1);
		if (part.type === "text" && last?.type === "text") joined[joined.length - 1] = { type: "text", text: last.text + part.text };
		else joined.push(part);
		return joined;
	}, []);
}

function responseStatus(response: AssistantMessage): ThreadMessageLike["status"] {
	if (response.stopReason === "error") return { type: "incomplete", reason: "error", error: response.errorMessage ?? "Error" };
	if (response.stopReason === "aborted") return { type: "incomplete", reason: "cancelled" };
	return { type: "complete", reason: "stop" };
}
