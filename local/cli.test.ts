import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UI_ORIGINS } from "@figpal/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { saveConfig } from "./files.ts";
import { type Helper, startHelper } from "./server.ts";

/** The process of `figpal`, a bridge in this process, the agents, and the FigPal windows: all stop after each test. */
let helper: ChildProcess | undefined;
let bridge: Helper | undefined;
const agents: Client[] = [];
const windows: WebSocket[] = [];
afterEach(async () => {
	helper?.kill();
	for (const socket of windows.splice(0)) socket.close();
	for (const agent of agents.splice(0)) await agent.close();
	await bridge?.close();
	[helper, bridge] = [undefined, undefined];
});

const CLI = new URL("cli.ts", import.meta.url).pathname;
const UI = "https://figpal.example";

/** Starts the helper with the arguments, and gives its port. */
async function start(args: string[]): Promise<number> {
	const config = join(mkdtempSync(join(tmpdir(), "figpal-cli-")), "local.json");
	helper = spawn("node", [CLI, "--config", config, ...args]);
	let log = "";
	helper.stderr!.on("data", (data) => (log += String(data)));
	await expect.poll(() => log, { timeout: 10_000 }).toMatch(/port \d+/);
	return Number(/port (\d+)/.exec(log)![1]);
}

/** A fake FigPal window of the file "Cards": it runs each request, and keeps the hellos. */
function fakeWindow(port: number) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: UI });
	windows.push(socket);
	const hellos: Record<string, unknown>[] = [];
	socket.on("error", () => {});
	socket.on("message", (data) => {
		const message = JSON.parse(String(data));
		if (message.kind === "hello") {
			hellos.push(message);
			socket.send(JSON.stringify({ kind: "window", file: "Cards" }));
		}
		if (message.kind === "request")
			socket.send(JSON.stringify({ kind: "response", id: message.id, ok: true, result: { value: `ran ${message.params.code}` }, attachments: [] }));
	});
	return { socket, hellos };
}

/** An outside agent with `figpal mcp`. */
async function startAgent(args: string[]): Promise<Client> {
	const agent = new Client({ name: "test", version: "1" });
	agents.push(agent);
	await agent.connect(new StdioClientTransport({ command: "node", args: [CLI, "mcp", ...args], stderr: "ignore" }));
	return agent;
}

const run = (agent: Client) => agent.callTool({ name: "figma_execute", arguments: { code: "return 1" } }).then((result) => JSON.stringify(result.content));
const RAN = JSON.stringify([{ type: "text", text: "ran return 1" }]);

const opens = (port: number, origin: string) =>
	new Promise<boolean>((resolve) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
		socket.once("open", () => {
			resolve(true);
			socket.close();
		});
		socket.once("error", () => resolve(false));
	});

describe("the helper command", () => {
	// A test helper must not answer the user's real FigPal: its folders and its picker are not the user's.
	it("accepts only the origins of --origin, when it has them", async () => {
		const port = await start(["--origin", "http://localhost:5199"]);
		expect([await opens(port, "http://localhost:5199"), await opens(port, UI_ORIGINS.remote)]).toEqual([true, false]);
	});

	// One bridge for all agents: `figpal mcp` uses the bridge of `figpal`, and is no bridge itself.
	it("mcp sends the agent's requests through the running bridge", async () => {
		const config = join(mkdtempSync(join(tmpdir(), "figpal-cli-")), "local.json");
		await saveConfig(config, { folders: [], home: false });
		bridge = await startHelper({ origins: [UI], ports: [9395], folders: { config, home: tmpdir(), pick: async () => [] } });
		const window = fakeWindow(9395);
		const agent = await startAgent(["--port", "9395", "--origin", UI]);
		await expect.poll(() => run(agent), { timeout: 10_000 }).toBe(RAN);
		expect(window.hellos.at(-1)).toMatchObject({ agent: true, manage: true });
	});

	// As figma-console-mcp: the command works alone. The first agent is the bridge, the others use it, and one of them
	// takes over when the first stops.
	it("mcp works without a running bridge: the agents share one bridge", { timeout: 30_000 }, async () => {
		const args = ["--port", "9396", "--origin", UI];
		const first = await startAgent(args);
		const second = await startAgent(args);
		const window = fakeWindow(9396);
		await expect.poll(() => run(second), { timeout: 10_000 }).toBe(RAN);
		expect(await run(first)).toBe(RAN);
		// The first agent stops: the other becomes the bridge, and FigPal finds it again.
		const closed = new Promise((resolve) => window.socket.once("close", resolve));
		await first.close();
		await closed;
		// FigPal looks for bridges again: here, until it finds the new one.
		let again = fakeWindow(9396);
		await expect
			.poll(
				() => {
					if (again.socket.readyState === WebSocket.CLOSED) again = fakeWindow(9396);
					return run(second);
				},
				{ timeout: 10_000 },
			)
			.toBe(RAN);
	});
});
