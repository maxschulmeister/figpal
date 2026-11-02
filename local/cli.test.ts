import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UI_ORIGINS } from "@figpal/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

let helper: ChildProcess | undefined;
afterEach(() => helper?.kill());

/** Starts the helper with the arguments, and gives its port. */
async function start(args: string[]): Promise<number> {
	const config = join(mkdtempSync(join(tmpdir(), "figpal-cli-")), "local.json");
	helper = spawn("node", [new URL("cli.ts", import.meta.url).pathname, "--config", config, ...args]);
	let log = "";
	helper.stderr!.on("data", (data) => (log += String(data)));
	await expect.poll(() => log, { timeout: 10_000 }).toMatch(/port \d+/);
	return Number(/port (\d+)/.exec(log)![1]);
}

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
});
