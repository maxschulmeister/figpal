import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type TranscriptView } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { toThread, UserText, watchTranscript } from "./transcript";

// Entry shapes as pi-durable 1.4.0 commits them (checked with a scripted model). 1.5.0 commits the same shapes.
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

/** The transcript of the chat (pi-durable's ConversationTranscript): the entries that it has, oldest first. */
function view(entries: unknown[], live: object = {}, agent?: object, inbox?: object): TranscriptView {
	const items = entries.map((entry) => ({ kind: "entry", entry }));
	return { conversation: { id: 1 }, items, docs: { "pi.live": live, "pi.agent": agent, "pi.inbox": inbox } } as unknown as TranscriptView;
}

describe("toThread", () => {
	// Messages that the user sent while the agent works wait in pi-durable's inbox: steers join the running work,
	// follow-ups start the next run. The chat shows the typed text, without the <figma> block.
	it("gives the waiting messages by lane, with the typed text", () => {
		const queued = (id: string, mode: string, text: string) => ({
			id,
			mode,
			content: `<figma>\nFile: F\n</figma>\n\n${text}`,
			entry: { kind: "figpal.user", data: { text } },
		});
		const inbox = { items: [queued("s1", "steer", "Use 8 px"), queued("f1", "followUp", "Then check it"), { id: "w1", mode: "write", entry: {} }] };
		// The input as stored: "Send now" sends it again, with its attachments.
		const input = (item: ReturnType<typeof queued>) => ({ content: item.content, entry: item.entry });
		expect(toThread(view([userEntry(1, "Hi")], {}, undefined, inbox)).queue).toEqual({
			steer: [{ id: "s1", text: "Use 8 px", input: input(inbox.items[0] as ReturnType<typeof queued>) }],
			followUp: [{ id: "f1", text: "Then check it", input: input(inbox.items[1] as ReturnType<typeof queued>) }],
		});
		expect(toThread(view([userEntry(1, "Hi")])).queue).toEqual({ steer: [], followUp: [] });
	});

	// The size of the last request, as the provider reports it: what the conversation fills of the context window.
	it("gives the context size of the newest answer with usage", () => {
		const sized = (id: number, totalTokens: number) => {
			const entry = assistant(id, [{ type: "text", text: "Done." }]);
			entry.model[0]!.usage = totalTokens ? { ...usage, totalTokens } : { ...usage, input: 0, output: 0, totalTokens };
			return entry;
		};
		expect(toThread(view([userEntry(1, "Hi")])).contextTokens).toBeUndefined();
		// An answer that stopped before the provider counted has no tokens.
		const thread = toThread(view([userEntry(1, "Hi"), sized(2, 1200), userEntry(3, "More"), sized(4, 4500), sized(5, 0)]));
		expect(thread.contextTokens).toBe(4500);
	});

	// After a compaction, the kept answers measured the long context before it, as pi-durable's estimate knows. The
	// summaries are in the transcript in the order of their IDs, after the entries that they keep.
	it("gives no context size from answers before the newest compaction", () => {
		const sized = (id: number, totalTokens: number) => {
			const entry = assistant(id, [{ type: "text", text: "Done." }]);
			entry.model[0]!.usage = { ...usage, totalTokens };
			return entry;
		};
		const summary = (id: number, head: number) => ({ id, conversationId: 1, kind: "pi.summary", head, model: [{ role: "user", content: "Summary", timestamp: 1 }] });
		const kept = [userEntry(1, "Hi"), sized(2, 900_000), summary(3, 2), userEntry(5, "Hi"), sized(6, 970_000), summary(10, 5)];
		expect(toThread(view(kept)).contextTokens).toBeUndefined();
		expect(toThread(view([...kept, userEntry(11, "More"), sized(12, 30_000)])).contextTokens).toBe(30_000);
	});

	// A long chat opens with its newest entries; "Load earlier" gets the ones before them. The part of an answer before
	// the first user message shows with that message after "Load earlier": each message keeps its ID, so the chat keeps
	// its scroll position (assistant-ui).
	it("says when the transcript has earlier entries, and starts at a user message then", () => {
		const loaded = view([assistant(60, [{ type: "text", text: "Done." }]), userEntry(61, "Next"), assistant(62, [{ type: "text", text: "OK." }])]);
		const all = toThread(loaded);
		expect(all.hasEarlier).toBe(false);
		expect(all.messages.map((message) => message.id)).toEqual(["after-start", "61", "after-61"]);
		const window = toThread({ ...loaded, items: [{ kind: "earlier" }, ...loaded.items] });
		expect(window.hasEarlier).toBe(true);
		expect(window.messages.map((message) => message.id)).toEqual(["61", "after-61"]);
	});

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
				assistant(3, [], "error", "Expected an Anthropic request object"),
				userEntry(4, "Two"),
				assistant(5, [{ type: "text", text: "Par" }], "aborted"),
			]),
		);
		expect(messages.map((message) => message.status)).toEqual([
			undefined,
			{ type: "incomplete", reason: "error", error: "Expected an Anthropic request object" },
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

	it("joins adjacent text blocks: Claude splits a cited answer in the middle of a sentence", () => {
		const { messages } = toThread(
			view([
				userEntry(1, "Who makes Figma?"),
				assistant(2, [
					{ type: "text", text: "Based on the search results, " },
					{ type: "text", text: "Figma, Inc. makes Figma." },
					{ type: "toolCall", id: "call-1", name: "figma_execute", arguments: { code: "return 1" } },
					{ type: "text", text: "Done." },
				]),
			]),
		);
		expect((messages[1]!.content as { type: string; text?: string }[]).map((part) => part.text ?? part.type)).toEqual([
			"Based on the search results, Figma, Inc. makes Figma.",
			"tool-call",
			"Done.",
		]);
	});
});

describe("watchTranscript", () => {
	/** A conversation with FigPal user messages and answers ("steps"), written without a model. */
	async function open() {
		const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
		const conversation = await harness.root(context);
		const write = async (entry: object) => (await conversation.submit({ type: "write", entry } as never, context)).wait(context);
		const user = (text: string) => write({ kind: UserText.kind, data: { text } });
		const steps = async (from: number, count: number) => {
			for (let i = from; i < from + count; i++) await write({ kind: "figpal.test", model: assistant(0, [{ type: "text", text: `Step ${i}` }]).model });
		};
		return { harness, conversation, user, steps };
	}
	/** The text of each message; an answer joins the texts of its steps. */
	const texts = (thread: ReturnType<typeof toThread>) =>
		thread.messages.map((message) => (message.content as unknown as { text: string }[]).map((part) => part.text).join(","));
	const range = (from: number, count: number, text = "Step") => Array.from({ length: count }, (_, i) => `${text} ${from + i}`);

	// pi-durable gives a window of the newest 50 entries. The chat keeps all entries that it got, and loads the earlier
	// ones on request.
	it("shows the newest messages of a long chat, the new ones, and the earlier ones on request", async () => {
		const { harness, conversation, user } = await open();
		for (let i = 0; i < 60; i++) await user(`Message ${i}`);
		let thread!: ReturnType<typeof toThread>;
		const watch = await watchTranscript(conversation, (view) => (thread = toThread(view)), context);
		expect(texts(thread)).toEqual(range(10, 50, "Message"));
		expect(thread.hasEarlier).toBe(true);

		await user("Message 60");
		await expect.poll(() => texts(thread).at(-1)).toBe("Message 60");

		await watch.loadEarlier();
		expect(texts(thread)).toEqual(range(0, 61, "Message"));
		expect(thread.hasEarlier).toBe(false);
		await watch.stop();
		await harness.close(context);
	});

	// One answer can have more entries than the window: the chat loads earlier entries until its user message shows.
	it("loads earlier entries until a user message shows", async () => {
		const { harness, conversation, user, steps } = await open();
		for (let i = 0; i < 60; i++) await user(`Message ${i}`);
		await steps(0, 60);
		let thread!: ReturnType<typeof toThread>;
		const watch = await watchTranscript(conversation, (view) => (thread = toThread(view)), context);
		expect(texts(thread).slice(-2)).toEqual(["Message 59", range(0, 60).join(",")]);
		expect(thread.hasEarlier).toBe(true);
		await watch.stop();
		await harness.close(context);
	});

	// The answer before the first message that shows can also have more entries than a page.
	it("loads earlier entries until an earlier user message shows", async () => {
		const { harness, conversation, user, steps } = await open();
		await user("First");
		await steps(0, 120);
		await user("Second");
		await steps(120, 10);
		let thread!: ReturnType<typeof toThread>;
		const watch = await watchTranscript(conversation, (view) => (thread = toThread(view)), context);
		expect(texts(thread)).toEqual(["Second", range(120, 10).join(",")]);
		await watch.loadEarlier();
		expect(texts(thread)).toEqual(["First", range(0, 120).join(","), "Second", range(120, 10).join(",")]);
		await watch.stop();
		await harness.close(context);
	});

	// Entries that come while the first pages load can be more than the window: the watch then skips some (a gap).
	it("loads the entries that the watch skipped", async () => {
		const { harness, conversation, user, steps } = await open();
		await user("First");
		await steps(0, 60);
		let release = () => {};
		const loading = new Promise<void>((resolve) => (release = resolve));
		let loads = 0;
		const slow = {
			watch: (ctx: typeof context) => conversation.watch(ctx),
			entries: async (...args: Parameters<typeof conversation.entries>) => {
				loads++;
				await loading;
				return conversation.entries(...args);
			},
		} as unknown as typeof conversation;
		let thread!: ReturnType<typeof toThread>;
		const watching = watchTranscript(slow, (view) => (thread = toThread(view)), context);
		await expect.poll(() => loads).toBe(1);
		await steps(60, 60);
		release();
		const watch = await watching;
		await expect.poll(() => texts(thread)).toEqual(["First", range(0, 120).join(",")]);
		await watch.stop();
		await harness.close(context);
	});

	it("stops the watch when the first pages do not load", async () => {
		const { harness, conversation, user, steps } = await open();
		await user("First");
		await steps(0, 60);
		let acquired: Awaited<ReturnType<typeof conversation.watch>> | undefined;
		const failing = {
			watch: async (ctx: typeof context) => {
				acquired = await conversation.watch(ctx);
				return acquired;
			},
			entries: () => Promise.reject(new Error("The storage failed")),
		} as unknown as typeof conversation;
		await expect(watchTranscript(failing, () => {}, context)).rejects.toThrow("The storage failed");
		expect(await acquired!.closed).toEqual({ kind: "stopped" });
		await harness.close(context);
	});
});
