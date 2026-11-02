import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { folders } from "./files.ts";
import { type Helper, startHelper } from "./server.ts";

const UI = "https://figpal.example";
let helper: Helper | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	await helper?.close();
	helper = undefined;
});

/** A fake FigPal UI: it connects with an origin, and keeps the messages that it gets. */
async function connect(port: number, origin = UI) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
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

const ports = [9390, 9391, 9392];

describe("local helper", () => {
	it("accepts only FigPal's origins, and says hello with the shared folders", async () => {
		const root = mkdtempSync(join(tmpdir(), "figpal-helper-"));
		helper = await startHelper({ folders: folders([root]), origins: [UI], ports, agent: false });
		await expect(connect(helper.port, "https://evil.example")).rejects.toThrow();
		const ui = await connect(helper.port);
		expect(await ui.next()).toEqual({ kind: "hello", folders: [root.split("/").at(-1)], agent: false });
	});

	it("answers file requests", async () => {
		const root = mkdtempSync(join(tmpdir(), "figpal-helper-"));
		writeFileSync(join(root, "a.txt"), "hello");
		helper = await startHelper({ folders: folders([root]), origins: [UI], ports, agent: false });
		const ui = await connect(helper.port);
		await ui.next();
		ui.send({ kind: "files", id: "1", request: { op: "read", path: `${root.split("/").at(-1)}/a.txt` } });
		expect(await ui.next()).toEqual({ kind: "response", id: "1", ok: true, result: "hello" });
		ui.send({ kind: "files", id: "2", request: { op: "read", path: "nothing/a.txt" } });
		expect(await ui.next()).toMatchObject({ kind: "response", id: "2", ok: false, error: expect.stringContaining("No shared folder") });
	});

	it("sends the requests of an outside agent to FigPal, and gives its answer", async () => {
		helper = await startHelper({ folders: [], origins: [UI], ports, agent: true });
		await expect(helper.request("execute", { code: "return 1" })).rejects.toThrow("FigPal is not connected");
		const ui = await connect(helper.port);
		await ui.next();
		const answer = helper.request("execute", { code: "return 1" });
		const request = await ui.next();
		expect(request).toMatchObject({ kind: "request", type: "execute", params: { code: "return 1" } });
		ui.send({ kind: "response", id: request.id, ok: true, result: { value: "1" }, attachments: [] });
		expect(await answer).toEqual({ result: { value: "1" }, attachments: [] });
	});

	it("takes the next port when one is in use", async () => {
		const busy = createServer().listen(ports[0], "127.0.0.1");
		await new Promise((resolve) => busy.once("listening", resolve));
		helper = await startHelper({ folders: [], origins: [UI], ports, agent: false });
		expect(helper.port).toBe(ports[1]);
		busy.close();
	});
});
