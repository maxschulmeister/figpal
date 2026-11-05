import "fake-indexeddb/auto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ConversationId, TranscriptView } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import type { FileInfo } from "@figpal/shared";
import { expect, it } from "vitest";
import { startAgent, userInput } from "./agent";
import { applyStagedImport, checkBackup, exportData, importData, stageImport } from "./backup";
import type { Bridge } from "./bridge";
import { listSkills, saveSkill, type Skill, skillFiles } from "./skills/store";
import { currentThread, Threads } from "./threads";
import { toThread, watchTranscript } from "./transcript";

const FILE: FileInfo = { fileId: "KEY1", fileKey: "KEY1", fileName: "Test file", page: { id: "0:1", name: "Page 1", type: "PAGE" }, selection: [], selectionCount: 0 };
const NAME = "figpal:file:KEY1";
const skill = (name: string): Skill => ({ name, description: `Use ${name}.`, source: { kind: "skills.sh", id: `owner/repo/${name}` }, hash: "h1", enabled: true });

/** FigPal's agent on the storage of the file, with a scripted model. */
async function agent() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "script", input: ["text", "image"] }] });
	faux.setResponses([fauxAssistantMessage(fauxText("The card is done."))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const bridge = { request: async () => ({ result: "", attachments: [] }) } as unknown as Pick<Bridge, "request">;
	return startAgent(await IndexedDbStorage.open(NAME), { models, bridge, credentials: { read: async () => undefined }, fileKey: "KEY1", subagentModels: () => [] });
}

/** The texts of a chat as it shows them. */
async function texts(harness: Awaited<ReturnType<typeof agent>>, id: ConversationId) {
	let view!: TranscriptView;
	await (await watchTranscript((await harness.conversation(id, context))!, (value) => (view = value), context)).stop();
	return toThread(view).messages.map((message) => (message.content as unknown as { text?: string }[]).map((part) => part.text).join(""));
}

/** All FigPal databases go, as on a new origin. */
async function newOrigin() {
	for (const { name } of await indexedDB.databases())
		await new Promise((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name!);
			request.onsuccess = resolve;
			request.onerror = () => reject(request.error);
		});
}

it("moves the chats and the skills to an empty origin through a backup file", async () => {
	const before = await agent();
	const thread = await currentThread(before, { model: { provider: "faux", modelId: "script" }, thinkingLevel: "off" });
	expect((await (await thread.submit(userInput("Make a card", FILE), context)).wait(context)).status).toBe("done");
	await before.close(context);
	await saveSkill(skill("figma-use"), [{ path: "SKILL.md", contents: "# Figma use" }]);

	const backup = await exportData();
	await newOrigin();
	// A new origin installs the default skills at the first start: the import replaces them.
	await saveSkill(skill("other"), [{ path: "SKILL.md", contents: "# Other" }]);
	expect(await checkBackup(backup)).toEqual({ files: 1, skills: true });
	await importData(backup);

	const after = await agent();
	expect(await after.snapshot(Threads, context)).toMatchObject({ threads: [{ id: thread.id }] });
	expect(await texts(after, thread.id)).toEqual(["Make a card", "The card is done."]);
	await after.close(context);
	expect((await listSkills()).map((item) => item.name)).toEqual(["figma-use"]);
	expect(await skillFiles("figma-use")).toEqual([{ path: "SKILL.md", contents: "# Figma use" }]);
}, 20_000);

it("refuses a file that is not a backup, and names the damaged line of a backup", async () => {
	await expect(checkBackup(new Blob(["<html>"]))).rejects.toThrow("This file is not a FigPal backup.");
	await expect(checkBackup(new Blob([]))).rejects.toThrow("This file is not a FigPal backup.");
	await newOrigin();
	await saveSkill(skill("figma-use"), [{ path: "SKILL.md", contents: "# Figma use" }]);
	const text = await (await exportData()).text();
	await expect(checkBackup(new Blob([`${text}{"store":"skills"}\n`]))).rejects.toThrow(`The backup is damaged (line ${text.split("\n").length}).`);
});

// A record without its key fails in IndexedDB. Before, the import deleted the old database first, so it lost the data.
it("refuses a record without its key, and an import that fails keeps the old data", async () => {
	await newOrigin();
	await saveSkill(skill("figma-use"), [{ path: "SKILL.md", contents: "# Figma use" }]);
	const text = await (await exportData()).text();
	const damaged = new Blob([`${text}{"store":"skills","value":{"description":"no name"}}\n`]);
	await expect(checkBackup(damaged)).rejects.toThrow(`The backup is damaged (line ${text.split("\n").length}).`);

	await saveSkill(skill("mine"), [{ path: "SKILL.md", contents: "# Mine" }]);
	await expect(importData(damaged)).rejects.toThrow();
	expect((await listSkills()).map((item) => item.name)).toEqual(["figma-use", "mine"]);
	expect((await indexedDB.databases()).map(({ name }) => name)).toEqual(["figpal:global"]);
});

it("imports a staged file at the next start, once, and deletes it also when it is damaged", async () => {
	await newOrigin();
	await saveSkill(skill("figma-use"), [{ path: "SKILL.md", contents: "# Figma use" }]);
	const backup = await exportData();
	await newOrigin();

	await stageImport(backup);
	let started = 0;
	expect(await applyStagedImport({ onStart: () => started++ })).toBe(true);
	expect(started).toBe(1);
	expect((await listSkills()).map((item) => item.name)).toEqual(["figma-use"]);
	expect(await applyStagedImport()).toBe(false);

	await stageImport(new Blob(["damaged"]));
	await expect(applyStagedImport()).rejects.toThrow("This file is not a FigPal backup.");
	expect(await applyStagedImport()).toBe(false);
});

it("stops an export with a value that JSON would change", async () => {
	await newOrigin();
	await saveSkill(skill("binary"), [{ path: "SKILL.md", contents: new Uint8Array([1]) as unknown as string }]);
	await expect(exportData()).rejects.toThrow("FigPal cannot put a Uint8Array in a backup.");
});
