import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type Conversation, createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { currentThread, deleteThread, forkThread, newThread, noteMessage, renameThread, selectThread, Threads } from "./threads";

const AGENT = { model: { provider: "faux", modelId: "script" } };

async function open() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "script" }] });
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage(fauxText("OK"))));
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	const list = async () => (await harness.snapshot(Threads, context))!;
	return { harness, list };
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
		await noteMessage(harness, first.id, "Make a card with auto layout\nand a title");
		await noteMessage(harness, first.id, "Now make it blue");
		expect((await list()).threads[0]).toMatchObject({ id: first.id, title: "Make a card with auto layout" });
		await renameThread(harness, first.id, "Card");
		expect((await list()).threads[0]!.title).toBe("Card");
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

	it("deletes a thread from the list and opens the newest other thread", async () => {
		const { harness, list } = await open();
		const first = await currentThread(harness, AGENT);
		const second = await newThread(harness, AGENT);
		const next = await deleteThread(harness, second.id, AGENT);
		expect(next.id).toBe(first.id);
		expect(await list()).toMatchObject({ threads: [{ id: first.id }], current: first.id });
		// Without a thread, a new one opens.
		const last = await deleteThread(harness, first.id, AGENT);
		expect((await list()).threads.map((info) => info.id)).toEqual([last.id]);
		expect((await selectThread(harness, last.id)).id).toBe(last.id);
	});

	it("keeps the open thread when another thread is deleted", async () => {
		const { harness, list } = await open();
		const first = await currentThread(harness, AGENT);
		const second = await newThread(harness, AGENT);
		const third = await newThread(harness, AGENT);
		await selectThread(harness, second.id);
		// The open thread (second) is not the first in the list (third).
		const opened = await deleteThread(harness, first.id, AGENT);
		expect(opened.id).toBe(second.id);
		expect(await list()).toMatchObject({ threads: [{ id: third.id }, { id: second.id }], current: second.id });
	});
});
