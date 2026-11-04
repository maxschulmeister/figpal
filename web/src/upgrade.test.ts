// The chats that users saved with an earlier pi-durable open with this one. fixtures/pi-durable-1.4.0.json has the
// IndexedDB stores of FigPal's agent on pi-durable 1.4.0 (made at commit 849198b with FigPal's startAgent and a scripted
// model): a chat with a tool call, a fork of it, and a chat whose model request was in progress, as when the user closes
// FigPal during a run.
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { LiveDoc, type TranscriptView } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import type { FileInfo } from "@figpal/shared";
import { expect, it } from "vitest";
import { startAgent, userInput } from "./agent";
import type { Bridge } from "./bridge";
import { Threads } from "./threads";
import { toThread, watchTranscript } from "./transcript";

const NAME = "figpal:file:KEY1";
const FILE: FileInfo = { fileId: "KEY1", fileKey: "KEY1", fileName: "Test file", page: { id: "0:1", name: "Page 1", type: "PAGE" }, selection: [], selectionCount: 0 };
const fixture = JSON.parse(readFileSync(new URL("fixtures/pi-durable-1.4.0.json", import.meta.url), "utf8")) as {
	version: number;
	stores: Record<string, unknown[]>;
};

/** Writes the stores of the fixture into the database, after pi-durable made its tables. */
async function restore() {
	await (await IndexedDbStorage.open(NAME)).close(context);
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(NAME, fixture.version);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	const transaction = database.transaction(Object.keys(fixture.stores), "readwrite");
	for (const [store, values] of Object.entries(fixture.stores)) for (const value of values) transaction.objectStore(store).put(value);
	await new Promise((resolve, reject) => {
		transaction.oncomplete = resolve;
		transaction.onerror = () => reject(transaction.error);
	});
	database.close();
}

/** The texts of the chat as it shows them: the messages and their parts. */
async function texts(harness: Awaited<ReturnType<typeof startAgent>>, id: number) {
	const conversation = await harness.conversation(id as never, context);
	let view!: TranscriptView;
	await (await watchTranscript(conversation!, (value) => (view = value), context)).stop();
	return toThread(view).messages.map((message) =>
		(message.content as unknown as { type: string; text?: string; toolName?: string }[]).map((part) => part.text ?? part.toolName ?? part.type).join(" | "),
	);
}

it("opens the chats of pi-durable 1.4.0: the list, the messages, a fork, and a run that was in progress", async () => {
	await restore();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "script", input: ["text", "image"] }] });
	const answer: FauxResponseFactory = (request) => {
		const text = JSON.stringify(request.messages);
		return fauxAssistantMessage(fauxText(text.includes("Make it blue") ? "It is blue." : "The colors are fine."));
	};
	faux.setResponses([answer, answer]);
	const models = createModels();
	models.setProvider(faux.provider);
	const bridge = { request: async () => ({ result: "", attachments: [] }) } as unknown as Pick<Bridge, "request">;
	const harness = await startAgent(await IndexedDbStorage.open(NAME), { models, bridge, credentials: { read: async () => undefined }, fileKey: "KEY1", subagentModels: () => [] });

	expect(await harness.snapshot(Threads, context)).toMatchObject({
		threads: [{ id: 23, title: "Check the colors" }, { id: 17, title: "Card (fork)" }, { id: 1, title: "Make a card" }],
		current: 23,
	});
	const card = ["Make a card", "figma_execute | The card is done."];
	expect(await texts(harness, 1)).toEqual(card);
	expect(await texts(harness, 17)).toEqual(card);

	// The model request of 1.4.0 ended with the page. pi-durable 1.5 tries it again, with the run in pi.live version 3.
	const colors = (await harness.conversation(23 as never, context))!;
	await colors.waitForIdle(context);
	expect(await texts(harness, 23)).toEqual(["Check the colors", "The colors are fine."]);

	// A new message in an old chat.
	const settled = await (await (await harness.conversation(1 as never, context))!.submit(userInput("Make it blue", FILE), context)).wait(context);
	expect(settled.status).toBe("done");
	expect((await texts(harness, 1)).at(-1)).toBe("It is blue.");
	expect((await harness.snapshot(LiveDoc, 1 as never, context))?.run).toBeUndefined();
	await harness.close(context);
}, 20_000);
