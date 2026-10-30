// Turns the pi-durable view of a conversation into assistant-ui messages.

import type { ThreadMessageLike } from "@assistant-ui/react";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type AgentState,
	type ConversationView,
	defineEntry,
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
};

/**
 * One user message for each user entry, and one assistant message for each answer to it: all model responses and
 * tool calls of the run. Tool results go into their tool-call part.
 */
export function toThread(view: ConversationView): Thread {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of view.entries)
		for (const message of entry.model ?? []) if (message.role === "toolResult") results.set(message.toolCallId, message);

	const messages: ThreadMessageLike[] = [];
	let userId = "start";
	/** `entryId` is absent for the streamed part of the running answer. */
	const answer = (response: AssistantMessage, entryId?: number) => {
		const last = messages.at(-1);
		const parts = assistantParts(response, results);
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
		for (const message of entry.model ?? []) if (message.role === "assistant") answer(message, entry.id);
	}

	const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
	if (live?.generation?.message) answer(live.generation.message as AssistantMessage);
	const isRunning = live?.run !== undefined;
	const last = messages.at(-1);
	if (isRunning && last?.role === "assistant") messages[messages.length - 1] = { ...last, status: { type: "running" } };
	const agent = view.docs[AgentDoc.definition.kind] as AgentState | undefined;
	return { messages, isRunning, retry: live?.generation?.retry, agent };
}

function assistantParts(response: AssistantMessage, results: Map<string, ToolResultMessage>): Part[] {
	return response.content.flatMap((block): Part[] => {
		if (block.type === "text") return [{ type: "text", text: block.text }];
		if (block.type === "thinking") return [{ type: "reasoning", text: block.thinking }];
		if (block.type === "toolCall") {
			const result = results.get(block.id);
			return [
				{
					type: "tool-call",
					toolCallId: block.id,
					toolName: block.name,
					args: block.arguments,
					...(result && { result: result.content, isError: result.isError }),
				},
			];
		}
		return [];
	});
}

function responseStatus(response: AssistantMessage): ThreadMessageLike["status"] {
	if (response.stopReason === "error") return { type: "incomplete", reason: "error", error: response.errorMessage ?? "Error" };
	if (response.stopReason === "aborted") return { type: "incomplete", reason: "cancelled" };
	return { type: "complete", reason: "stop" };
}
