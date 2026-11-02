import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type Conversation, createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { currentThread, archiveThread, forkThread, nameThread, newThread, noteMessage, renameThread, selectThread, Threads } from "./threads";

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
		 * The first message is sent, and its answer runs. `steps` answer the next requests: the name, or a follow-up.
		 * `requests` has the user content of each request after the first answer.
		 */
		async function answered(steps: FauxResponseStep[], text = QUESTION) {
			const opened = await open();
			const thread = await currentThread(opened.harness, AGENT);
			const requests: string[] = [];
			const record = (step: FauxResponseStep): FauxResponseStep => (request, ...rest) => {
				requests.push(JSON.stringify(request.messages));
				return typeof step === "function" ? step(request, ...rest) : step;
			};
			opened.faux.setResponses([fauxAssistantMessage(fauxText(ANSWER)), ...steps.map(record)]);
			await noteMessage(opened.harness, thread.id, text);
			const submission = await thread.submit({ type: "input", content: text || "(image)" }, context);
			const model = opened.models.getModel("faux", "script")!;
			const name = (thinking: ModelThinkingLevel = "off") =>
				nameThread(opened.harness, submission, text, { models: opened.models, model, thinking });
			return { ...opened, thread, submission, requests, name };
		}

		it("after the first answer, a short name from the question and the answer replaces the first line", async () => {
			const { list, requests, name } = await answered([fauxAssistantMessage(fauxText('"Card padding check."\nMore text'))]);
			await name();
			expect(requests[0]).toContain(QUESTION);
			expect(requests[0]).toContain(ANSWER);
			// The first line, without quotes and the full stop.
			expect((await list()).threads[0]!.title).toBe("Card padding check");
		});

		it("asks with the thinking level of the setting; without thinking, for at most 40 tokens", async () => {
			const options: unknown[] = [];
			const step: FauxResponseStep = (_request, given) => {
				options.push({ reasoning: given?.reasoning, maxTokens: given?.maxTokens });
				return fauxAssistantMessage(fauxText("Name"));
			};
			const off = await answered([step]);
			await off.name();
			const low = await answered([step]);
			await low.name("low");
			expect(options).toEqual([
				{ reasoning: undefined, maxTokens: 40 },
				{ reasoning: "low", maxTokens: undefined },
			]);
		});

		it("uses the answer of the first message, also when a follow-up waits", async () => {
			const { thread, requests, name } = await answered([fauxAssistantMessage(fauxText("Second answer")), fauxAssistantMessage(fauxText("Name"))]);
			await thread.submit({ type: "input", content: "And the title?", whenBusy: "followUp" }, context);
			await name();
			const naming = requests.find((request) => request.includes("Message: "))!;
			expect(naming).toContain(ANSWER);
			expect(naming).not.toContain("Second answer");
		});

		it("cuts a long message", async () => {
			const { requests, name } = await answered([fauxAssistantMessage(fauxText("Name"))], `Check ${"x".repeat(5000)}`);
			await name();
			expect(requests[0]!.length).toBeLessThan(2000);
		});

		it("names a chat whose first message has only attachments, once", async () => {
			const { harness, list, thread, name } = await answered([fauxAssistantMessage(fauxText("Image check"))], "");
			expect((await list()).threads[0]!.title).toBe("New chat");
			await name();
			expect((await list()).threads[0]!.title).toBe("Image check");
			expect(await noteMessage(harness, thread.id, "")).toBe(false);
		});

		it("keeps a name that the user gave, without a request when the user gave it during the answer", async () => {
			const { harness, list, thread, requests, name } = await answered([fauxAssistantMessage(fauxText("Card padding check"))]);
			await renameThread(harness, thread.id, "Mine");
			await name();
			expect(requests).toEqual([]);
			expect((await list()).threads[0]!.title).toBe("Mine");
		});

		it("keeps a name that the user gave while the name was made", async () => {
			const { harness, list, thread, name } = await answered([fauxAssistantMessage(fauxText("Card padding check"))]);
			const naming = name();
			await renameThread(harness, thread.id, "Mine");
			await naming;
			expect((await list()).threads[0]!.title).toBe("Mine");
		});

		it("keeps the first line when the answer stopped", async () => {
			const { list, thread, requests, name } = await answered([fauxAssistantMessage(fauxText("Name"))]);
			await thread.abort(context);
			await name();
			expect(requests).toEqual([]);
			expect((await list()).threads[0]!.title).toBe(QUESTION);
		});

		it("keeps the first line when the model fails", async () => {
			const { list, name } = await answered([fauxAssistantMessage([], { stopReason: "error", errorMessage: "Overloaded" })]);
			await name();
			expect((await list()).threads[0]!.title).toBe(QUESTION);
		});
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
