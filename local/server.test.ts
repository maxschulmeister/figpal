import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { saveConfig } from "./files.ts";
import { AGENT_PATH, type Helper, startHelper } from "./server.ts";

const UI = "https://figpal.example";
let helper: Helper | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	await helper?.close();
	helper = undefined;
});

/** A fake FigPal UI: it connects with an origin, and keeps the messages that it gets. */
async function connect(port: number, { origin = UI, path = "" }: { origin?: string | null; path?: string } = {}) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin === null ? {} : { origin });
	sockets.push(socket);
	const messages: Record<string, unknown>[] = [];
	socket.on("message", (data) => messages.push(JSON.parse(String(data))));
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	const next = async () => {
		await expect.poll(() => messages.length).toBeGreaterThan(0);
		return messages.shift()!;
	};
	return { socket, next, send: (message: object) => socket.send(JSON.stringify(message)) };
}

/** A fake MCP process of an outside agent: Node sends no origin. */
const AGENT = { origin: null, path: AGENT_PATH };

const ports = [9390, 9391, 9392];

/** The helper that starts at login, with a config file in a new folder, and a folder picker that gives `picked`. */
async function folderHelper(paths: string[] = [], picked: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), "figpal-helper-"));
	const home = join(root, "home");
	mkdirSync(home);
	const config = join(root, "local.json");
	await saveConfig(config, { folders: paths, home: false });
	helper = await startHelper({ origins: [UI], ports, folders: { config, home, pick: async () => picked } });
	return { root, home, config, helper };
}

const folder = (name: string) => {
	const path = join(mkdtempSync(join(tmpdir(), "figpal-shared-")), name);
	mkdirSync(path);
	return path;
};

describe("local helper", () => {
	it("accepts only FigPal's origins, and says hello with the shared folders", async () => {
		const project = folder("project");
		const { helper } = await folderHelper([project]);
		await expect(connect(helper.port, { origin: "https://evil.example" })).rejects.toThrow();
		const ui = await connect(helper.port);
		expect(await ui.next()).toEqual({ kind: "hello", folders: ["project"], agent: false, manage: true, home: false });
	});

	it("answers file requests", async () => {
		const project = folder("project");
		writeFileSync(join(project, "a.txt"), "hello");
		const { helper } = await folderHelper([project]);
		const ui = await connect(helper.port);
		await ui.next();
		ui.send({ kind: "files", id: "1", request: { op: "read", path: "project/a.txt" } });
		expect(await ui.next()).toEqual({ kind: "response", id: "1", ok: true, result: "hello" });
		ui.send({ kind: "files", id: "2", request: { op: "read", path: "nothing/a.txt" } });
		expect(await ui.next()).toMatchObject({ kind: "response", id: "2", ok: false, error: expect.stringContaining("No shared folder") });
	});

	it("adds folders from the folder picker, removes them, and shares the home folder: it saves each change and says hello again", async () => {
		const [design, code] = [folder("design"), folder("code")];
		const { helper, config, home } = await folderHelper([], [design, code]);
		const ui = await connect(helper.port);
		const other = await connect(helper.port);
		await ui.next();
		await other.next();
		ui.send({ kind: "folders", id: "1", change: { op: "add" } });
		expect(await ui.next()).toMatchObject({ kind: "response", id: "1", ok: true });
		expect(await ui.next()).toMatchObject({ kind: "hello", folders: ["design", "code"] });
		// All windows get the new folders.
		expect(await other.next()).toMatchObject({ kind: "hello", folders: ["design", "code"] });
		ui.send({ kind: "folders", id: "2", change: { op: "remove", name: "design" } });
		await ui.next();
		expect(await ui.next()).toMatchObject({ kind: "hello", folders: ["code"] });
		ui.send({ kind: "folders", id: "3", change: { op: "home", on: true } });
		await ui.next();
		expect(await ui.next()).toMatchObject({ kind: "hello", folders: ["code", basename(home)], home: true });
		expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ folders: [code], home: true });
		// The home folder is in the list too: its Remove turns the setting off.
		ui.send({ kind: "folders", id: "4", change: { op: "remove", name: basename(home) } });
		await ui.next();
		expect(await ui.next()).toMatchObject({ kind: "hello", folders: ["code"], home: false });
	});

	// The agent names files by the folder name: two folders with one name would be the same.
	it("refuses a second folder with the same name", async () => {
		const { helper, config } = await folderHelper([folder("project")], [folder("project")]);
		const ui = await connect(helper.port);
		await ui.next();
		ui.send({ kind: "folders", id: "1", change: { op: "add" } });
		expect(await ui.next()).toMatchObject({ kind: "response", id: "1", ok: false, error: expect.stringContaining('Two shared folders are named "project"') });
		expect(JSON.parse(readFileSync(config, "utf8")).folders).toHaveLength(1);
	});

	// FigPal opens once for each file: with several files, the agent must name one.
	it("sends a request to the window of the file that the agent names", async () => {
		const { helper } = await folderHelper();
		await expect(helper.request("execute", { code: "1" })).rejects.toThrow("FigPal is not open");
		const [cards, icons] = [await connect(helper.port), await connect(helper.port)];
		await cards.next();
		await icons.next();
		cards.send({ kind: "window", file: "Cards" });
		icons.send({ kind: "window", file: "Icons" });
		await expect.poll(() => helper!.request("execute", { code: "1" }).catch((error: Error) => error.message)).toBe(
			'FigPal is open in several files: "Cards", "Icons". Give the file.',
		);
		await expect(helper.request("execute", { code: "1" }, "Logos")).rejects.toThrow('FigPal is not open in "Logos". Open files: "Cards", "Icons".');
		// A window that connects counts once it names its file: until then, the agent's request goes to the others.
		const opening = await connect(helper.port);
		await opening.next();
		await expect(helper.request("execute", { code: "1" }, "Logos")).rejects.toThrow('Open files: "Cards", "Icons".');
		helper.request("execute", { code: "1" }, "Icons").catch(() => {});
		expect(await icons.next()).toMatchObject({ kind: "request", params: { code: "1" } });
	});

	// One helper for all agents: each agent's MCP process connects to it, without an origin.
	it("sends the requests of an agent's MCP process to FigPal, and gives the answer back", async () => {
		const { helper } = await folderHelper();
		const ui = await connect(helper.port);
		await ui.next();
		ui.send({ kind: "window", file: "Cards" });
		const agent = await connect(helper.port, AGENT);
		agent.send({ kind: "request", id: "a1", type: "execute", params: { code: "return 1" } });
		const request = await ui.next();
		expect(request).toMatchObject({ kind: "request", type: "execute", params: { code: "return 1" } });
		ui.send({ kind: "response", id: request.id, ok: true, result: { value: "1" }, attachments: [] });
		expect(await agent.next()).toEqual({ kind: "response", id: "a1", ok: true, result: { value: "1" }, attachments: [] });
		agent.send({ kind: "request", id: "a2", type: "execute", params: { code: "return 1" }, file: "Logos" });
		expect(await agent.next()).toMatchObject({ kind: "response", id: "a2", ok: false, error: expect.stringContaining('Open files: "Cards"') });
	});

	it("a web page cannot connect as an agent", async () => {
		const { helper } = await folderHelper();
		await expect(connect(helper.port, { path: AGENT_PATH })).rejects.toThrow("401");
	});

	// Two bridges can run: FigPal must not show the folders twice.
	it("the bridge of an agent's MCP process keeps no folders", async () => {
		helper = await startHelper({ origins: [UI], ports });
		const ui = await connect(helper.port);
		expect(await ui.next()).toEqual({ kind: "hello", folders: [], agent: false, manage: false, home: false });
		ui.send({ kind: "folders", id: "1", change: { op: "add" } });
		expect(await ui.next()).toMatchObject({ kind: "response", id: "1", ok: false });
	});

	it("answers an agent's request that it does not know: the agent must not wait forever", async () => {
		const { helper } = await folderHelper();
		const agent = await connect(helper.port, AGENT);
		agent.send({ kind: "request", id: "a1", type: "teleport", params: {} });
		expect(await agent.next()).toMatchObject({ kind: "response", id: "a1", ok: false, error: expect.stringContaining("does not know") });
	});

	it("takes the next port when one is in use", async () => {
		const busy = createServer().listen(ports[0], "127.0.0.1");
		await new Promise((resolve) => busy.once("listening", resolve));
		const { helper } = await folderHelper();
		expect(helper.port).toBe(ports[1]);
		busy.close();
	});
});
