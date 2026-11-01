// Runs the browser checks in Chrome, in the light and the dark theme. Usage:
//   pnpm e2e [check ...] [--light | --dark] [--ui https://figpal.example]
// Without --ui, it starts Vite on a free port and stops it at the end.

import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Context, SCREENSHOTS } from "./harness.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args.splice(index, 2)[1];
};
const remote = option("--ui");
const themes = args.includes("--light") ? [false] : args.includes("--dark") ? [true] : [false, true];
const names = args.filter((arg) => !arg.startsWith("--"));
const tests = fileURLToPath(new URL("tests", import.meta.url));
const all = readdirSync(tests)
	.filter((file) => file.endsWith(".ts"))
	.map((file) => file.slice(0, -".ts".length));
const unknown = names.filter((name) => !all.includes(name));
if (unknown.length) throw new Error(`No check named ${unknown.join(", ")}. The checks: ${all.join(", ")}.`);

/** A free port for Vite: never the fixed ports of other servers on this machine. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer().listen(0, () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

async function startVite(): Promise<{ ui: string; vite: ChildProcess }> {
	const port = await freePort();
	const root = fileURLToPath(new URL("..", import.meta.url));
	// Its own process group, so that the stop also stops the processes of pnpm.
	const vite = spawn("pnpm", ["--filter", "@figpal/web", "exec", "vite", "--port", String(port), "--strictPort"], { cwd: root, detached: true, stdio: "ignore" });
	const ui = `http://localhost:${port}`;
	for (let attempt = 0; attempt < 60; attempt++) {
		if (await fetch(ui).then((response) => response.ok, () => false)) return { ui, vite };
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	process.kill(-vite.pid!);
	throw new Error("Vite did not start.");
}

const server = remote ? undefined : await startVite();
/** Stops Vite once. Playwright closes its browsers itself at Ctrl-C. */
let stopped = false;
const stop = () => {
	if (server && !stopped) process.kill(-server.vite.pid!);
	stopped = true;
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		stop();
		process.exit(130);
	});
const ui = remote ?? server!.ui;
let failed = 0;
try {
	for (const dark of themes) {
		for (const name of names.length ? names : all) {
			console.log(`${name} (${dark ? "dark" : "light"})`);
			const context = new Context(ui, dark);
			try {
				const check = (await import(`./tests/${name}.ts`)) as { default(context: Context): Promise<void> };
				await check.default(context);
			} catch (error) {
				context.check("runs to the end", false, error instanceof Error ? error.message : String(error));
			} finally {
				await context.close();
			}
			if (context.failures) failed++;
		}
	}
} finally {
	stop();
}
console.log(failed ? `\n${failed} checks failed.` : `\nAll checks passed. Screenshots: ${SCREENSHOTS}`);
process.exitCode = failed ? 1 : 0;
