import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type Conversation, type ConversationId, createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it, vi } from "vitest";
import { currentThread, archiveThread, forkThread, nameThread, newThread, noteDone, noteMessage, renameThread, selectThread, Threads } from "./threads";

const AGENT = { model: { provider: "faux", modelId: "script" } };

async function open() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "script" }] });
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage(fauxText("OK"))));
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	const list = async () => (await harness.snapshot(Threads, context))!;
	return { harness, list, faux, models };
}

async function say(conversation: Conversation, text: string) {
	const submission = await conversation.submit({ type: "input", content: text }, context);
	await submission.wait(context);
}

describe("threads", () => {
	it("makes the chat of Phase 1 (the root conversation) the first thread", async () => {
		const { harness, list } = await open();
		const root = await harness.root(context, { agent: AGENT });
		const thread = await currentThread(harness, AGENT);
		expect(thread.id).toBe(root.id);
		expect(await list()).toEqual({ threads: [{ id: root.id, title: "", updatedAt: expect.any(Number) }], current: root.id });
	});

	it("adds the root conversation once when two starts run at the same time", async () => {
		const { harness, list } = await open();
		const [first, second] = await Promise.all([currentThread(harness, AGENT), currentThread(harness, AGENT)]);
		expect(first.id).toBe(second.id);
		expect((await list()).threads).toHaveLength(1);
	});

	it("puts a new thread first and keeps it as the current thread", async () => {
		const { harness, list } = await open();
		const root = await currentThread(harness, AGENT);
		const thread = await newThread(harness, AGENT);
		expect((await currentThread(harness, AGENT)).id).toBe(thread.id);
		expect((await list()).threads.map((info) => info.id)).toEqual([thread.id, root.id]);
	});

	it("names a thread after its first message, and moves it to the top on each message", async () => {
		const { harness, list } = await open();
		const first = await currentThread(harness, AGENT);
		await newThread(harness, AGENT);
		expect(await noteMessage(harness, first.id, "Make a card with auto layout\nand a title")).toBe(true);
		expect(await noteMessage(harness, first.id, "Now make it blue")).toBe(false);
		expect((await list()).threads[0]).toMatchObject({ id: first.id, title: "Make a card with auto layout" });
		await renameThread(harness, first.id, "Card");
		expect((await list()).threads[0]!.title).toBe("Card");
	});

	describe("AI names", () => {
		const QUESTION = "can you check this [Card]";
		const ANSWER = "The padding of the card is 12 px, not 16 px.";
		/**
		 * The first message is sent, and its answer runs. A request for a name (its system prompt) gets the next of
		 * `names`; `requests` has the messages of each. `answer` gives the answers of the chat, by default ANSWER.
		 */
		async function sent(names: FauxResponseStep[], { text = QUESTION, answer }: { text?: string; answer?: FauxResponseStep } = {}) {
			const opened = await open();
			const thread = await currentThread(opened.harness, AGENT);
			const requests: string[] = [];
			const step: FauxResponseStep = (request, ...rest) => {
				const messages = JSON.stringify(request.messages);
				const naming = messages.includes("Name this chat");
				if (naming) requests.push(messages);
				const next = naming ? names.shift() : (answer ?? fauxAssistantMessage(fauxText(ANSWER)));
				return typeof next === "function" ? next(request, ...rest) : next!;
			};
			opened.faux.setResponses(Array.from({ length: 6 }, () => step));
			await noteMessage(opened.harness, thread.id, text);
			const submission = await thread.submit({ type: "input", content: text || "(image)" }, context);
			const model = opened.models.getModel("faux", "script")!;
			const name = (thinking: ModelThinkingLevel = "off") =>
				nameThread(opened.harness, submission, text, { models: opened.models, model, thinking });
			return { ...opened, thread, submission, requests, name };
		}

		// User request: the name comes after the first message, not after the first answer.
		it("after the first message, a short name from the message replaces the first line, before the answer", async () => {
			let release: (() => void) | undefined;
			const answer: FauxResponseStep = () => new Promise((resolve) => (release = () => resolve(fauxAssistantMessage(fauxText(ANSWER)))));
			const { list, requests, name, submission } = await sent([fauxAssistantMessage(fauxText('"Card padding check."\nMore text'))], { answer });
			await name();
			expect(requests[0]).toContain(QUESTION);
			// The first line, without quotes and the full stop.
			expect((await list()).threads[0]!.title).toBe("Card padding check");
			expect((await submission.status(context)).status).not.toBe("done");
			await vi.waitFor(() => expect(release).toBeDefined());
			release!();
			await submission.wait(context);
		});

		it("asks with the thinking level of the setting; without thinking, for at most 40 tokens", async () => {
			const options: unknown[] = [];
			const step: FauxResponseStep = (_request, given) => {
				options.push({ reasoning: given?.reasoning, maxTokens: given?.maxTokens });
				return fauxAssistantMessage(fauxText("Name"));
			};
			await (await sent([step])).name();
			await (await sent([step])).name("low");
			expect(options).toEqual([
				{ reasoning: undefined, maxTokens: 40 },
				{ reasoning: "low", maxTokens: undefined },
			]);
		});

		it("cuts a long message", async () => {
			const { requests, name } = await sent([fauxAssistantMessage(fauxText("Name"))], { text: `Check ${"x".repeat(5000)}` });
			await name();
			expect(requests[0]!.length).toBeLessThan(2000);
		});

		// A message with only attachments has no text: the answer of the first message says what the chat is about.
		it("names a chat whose first message has only attachments from its answer, once", async () => {
			const { harness, list, thread, requests, name } = await sent([fauxAssistantMessage(fauxText("Image check"))], { text: "" });
			expect((await list()).threads[0]!.title).toBe("New chat");
			await name();
			expect(requests[0]).toContain(ANSWER);
			expect((await list()).threads[0]!.title).toBe("Image check");
			expect(await noteMessage(harness, thread.id, "")).toBe(false);
		});

		it("uses the answer of the first message, also when a follow-up waits", async () => {
			const answers = [fauxAssistantMessage(fauxText(ANSWER)), fauxAssistantMessage(fauxText("Second answer"))];
			const { thread, requests, name } = await sent([fauxAssistantMessage(fauxText("Name"))], { text: "", answer: () => answers.shift()! });
			await thread.submit({ type: "input", content: "And the title?", whenBusy: "followUp" }, context);
			await name();
			expect(requests[0]).toContain(ANSWER);
			expect(requests[0]).not.toContain("Second answer");
		});

		it("keeps the first line when the answer to only attachments stopped", async () => {
			const { list, thread, requests, name } = await sent([fauxAssistantMessage(fauxText("Name"))], { text: "" });
			await thread.abort(context);
			await name();
			expect(requests).toEqual([]);
			expect((await list()).threads[0]!.title).toBe("New chat");
		});

		it("keeps a name that the user gave before, without a request", async () => {
			const { harness, list, thread, requests, name } = await sent([fauxAssistantMessage(fauxText("Card padding check"))]);
			await renameThread(harness, thread.id, "Mine");
			await name();
			expect(requests).toEqual([]);
			expect((await list()).threads[0]!.title).toBe("Mine");
		});

		it("keeps a name that the user gave while the name was made", async () => {
			const { harness, list, thread, name } = await sent([fauxAssistantMessage(fauxText("Card padding check"))]);
			const naming = name();
			await renameThread(harness, thread.id, "Mine");
			await naming;
			expect((await list()).threads[0]!.title).toBe("Mine");
		});

		it("keeps the first line when the model fails", async () => {
			const { list, name } = await sent([fauxAssistantMessage([], { stopReason: "error", errorMessage: "Overloaded" })]);
			await name();
			expect((await list()).threads[0]!.title).toBe(QUESTION);
		});
	});

	// User request: a dot in the chat list for chats that are done and not read.
	it("marks a thread unread when its work ends while another thread is open, until it opens", async () => {
		const { harness, list } = await open();
		const first = await currentThread(harness, AGENT);
		await say(first, "Make a card");
		await noteDone(harness, first.id);
		expect((await list()).threads[0]!.unread).toBeUndefined();

		const working = first.submit({ type: "input", content: "Make it blue" }, context);
		const second = await newThread(harness, AGENT);
		await (await working).wait(context);
		await noteDone(harness, first.id);
		const info = (id: ConversationId) => list().then((value) => value.threads.find((thread) => thread.id === id)!);
		expect((await info(first.id)).unread).toBe(true);
		expect((await info(second.id)).unread).toBeUndefined();

		await selectThread(harness, first.id);
		expect((await info(first.id)).unread).toBeUndefined();
	});

	it("forks a thread: the fork has the history up to the entry, and becomes current", async () => {
		const { harness, list } = await open();
		const thread = await currentThread(harness, AGENT);
		await say(thread, "One");
		const { entries } = (await thread.viewState(context)).value;
		const firstAnswer = entries.at(-1)!.id;
		await say(thread, "Two");

		const fork = await forkThread(thread, firstAnswer, "Numbers");
		const forkEntries = (await fork.viewState(context)).value.entries;
		expect(forkEntries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
		expect((await list()).threads[0]).toMatchObject({ id: fork.id, title: "Numbers (fork)" });
		expect((await list()).current).toBe(fork.id);
	});

	it("archives a thread: it leaves the list, and opens the newest other thread", async () => {
		const { harness, list } = await open();
		const first = await currentThread(harness, AGENT);
		const second = await newThread(harness, AGENT);
		const next = await archiveThread(harness, second.id, AGENT);
		expect(next.id).toBe(first.id);
		expect(await list()).toMatchObject({ threads: [{ id: first.id }], current: first.id });
		// Without a thread, a new one opens.
		const last = await archiveThread(harness, first.id, AGENT);
		expect((await list()).threads.map((info) => info.id)).toEqual([last.id]);
		expect((await selectThread(harness, last.id)).id).toBe(last.id);
	});

	it("keeps the open thread when another thread is archived", async () => {
		const { harness, list } = await open();
		const first = await currentThread(harness, AGENT);
		const second = await newThread(harness, AGENT);
		const third = await newThread(harness, AGENT);
		await selectThread(harness, second.id);
		// The open thread (second) is not the first in the list (third).
		const opened = await archiveThread(harness, first.id, AGENT);
		expect(opened.id).toBe(second.id);
		expect(await list()).toMatchObject({ threads: [{ id: third.id }, { id: second.id }], current: second.id });
	});
});
