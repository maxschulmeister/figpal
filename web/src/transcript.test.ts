import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { toThread } from "./transcript";

// Entry shapes as pi-durable 1.4.0 commits them (checked with a scripted model).
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id: number, content: unknown[], stopReason = "stop", errorMessage?: string) => ({
	id,
	conversationId: 1,
	kind: "pi.assistant",
	model: [{ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", usage, stopReason, errorMessage, timestamp: 1 }],
});
const userEntry = (id: number, text: string) => ({
	id,
	conversationId: 1,
	kind: "figpal.user",
	data: { text },
	model: [{ role: "user", content: `<figma>\nFile: Test\n</figma>\n\n${text}`, timestamp: 1 }],
});
const toolResult = (id: number, toolCallId: string, content: unknown[], isError = false) => ({
	id,
	conversationId: 1,
	kind: "pi.tool-result",
	model: [{ role: "toolResult", toolCallId, toolName: "figma_execute", content, isError, timestamp: 1 }],
});
const system = { id: 2, conversationId: 1, kind: "pi.system", model: [{ role: "system", content: "", toolsAdded: [], timestamp: 1 }] };

function view(entries: unknown[], live: object = {}, agent?: object): ConversationView {
	return { conversation: { id: 1 }, entries, docs: { "pi.live": live, "pi.agent": agent } } as unknown as ConversationView;
}

describe("toThread", () => {
	it("shows the typed text of a user message and one assistant turn with its tool results", () => {
		const { messages } = toThread(
			view([
				userEntry(1, "Make a card"),
				system,
				assistant(3, [
					{ type: "thinking", thinking: "A frame with auto layout." },
					{ type: "text", text: "I make it." },
					{ type: "toolCall", id: "call-1", name: "figma_execute", arguments: { code: "return 1" } },
				], "toolUse"),
				toolResult(4, "call-1", [{ type: "text", text: "1" }]),
				assistant(5, [{ type: "text", text: "Done." }]),
			]),
		);
		expect(messages).toEqual([
			{ id: "1", role: "user", content: [{ type: "text", text: "Make a card" }] },
			{
				id: "after-1",
				role: "assistant",
				status: { type: "complete", reason: "stop" },
				// A fork from this message keeps the history up to its last entry.
				metadata: { custom: { lastEntryId: 5 } },
				content: [
					{ type: "reasoning", text: "A frame with auto layout." },
					{ type: "text", text: "I make it." },
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "figma_execute",
						args: { code: "return 1" },
						result: [{ type: "text", text: "1" }],
						isError: false,
					},
					{ type: "text", text: "Done." },
				],
			},
		]);
	});

	it("shows why an answer stopped: an error or an abort", () => {
		const { messages } = toThread(
			view([
				userEntry(1, "One"),
				assistant(3, [], "error", "Pi Black OAuth request has an invalid billing block"),
				userEntry(4, "Two"),
				assistant(5, [{ type: "text", text: "Par" }], "aborted"),
			]),
		);
		expect(messages.map((message) => message.status)).toEqual([
			undefined,
			{ type: "incomplete", reason: "error", error: "Pi Black OAuth request has an invalid billing block" },
			undefined,
			{ type: "incomplete", reason: "cancelled" },
		]);
	});

	it("adds the streamed part of the running answer, with tool calls that wait for a result", () => {
		const partial = {
			role: "assistant",
			content: [
				{ type: "text", text: "Now the screenshot." },
				{ type: "toolCall", id: "call-2", name: "figma_screenshot", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const live = { run: { taskId: 9, inputs: [1] }, generation: { attempt: 1, message: partial } };
		const running = toThread(view([userEntry(1, "Check it"), assistant(3, [{ type: "text", text: "Hm." }], "toolUse")], live));
		expect(running.isRunning).toBe(true);
		expect(running.messages).toEqual([
			{ id: "1", role: "user", content: [{ type: "text", text: "Check it" }] },
			{
				id: "after-1",
				role: "assistant",
				status: { type: "running" },
				metadata: { custom: { lastEntryId: 3 } },
				content: [
					{ type: "text", text: "Hm." },
					{ type: "text", text: "Now the screenshot." },
					{ type: "tool-call", toolCallId: "call-2", toolName: "figma_screenshot", args: {} },
				],
			},
		]);
		// The first answer of a run starts the assistant message, with the same ID that the committed answer gets.
		const first = toThread(view([userEntry(1, "Check it")], live)).messages;
		expect(first[1]).toMatchObject({ id: "after-1", status: { type: "running" } });
	});

	it("gives the model and thinking level of the thread", () => {
		const agent = { model: { provider: "anthropic", modelId: "claude-opus-5-5" }, thinkingLevel: "high" };
		expect(toThread(view([], {}, agent)).agent).toEqual(agent);
	});

	it("gives a tool call the details of its call: from the live state while it runs, then from its result", () => {
		const call = assistant(3, [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { tasks: [] } }], "toolUse");
		const toolPart = (thread: ReturnType<typeof toThread>) => (thread.messages[1]!.content as unknown as { type: string }[])[0];
		const running = toThread(
			view([userEntry(1, "Go"), call], {
				run: {},
				tools: [{ callId: "call-1", name: "subagent", status: "running", details: { children: [{ conversationId: 7 }] } }],
			}),
		);
		expect(toolPart(running)).toMatchObject({ toolCallId: "call-1", artifact: { children: [{ conversationId: 7 }] } });
		const result = toolResult(4, "call-1", [{ type: "text", text: "Done" }]);
		const details = { children: [{ conversationId: 7, title: "Task 1" }] };
		const done = toThread(view([userEntry(1, "Go"), call, { ...result, model: [{ ...result.model[0], details }] }]));
		expect(toolPart(done)).toMatchObject({ toolCallId: "call-1", artifact: details, result: [{ type: "text", text: "Done" }] });
	});
});
