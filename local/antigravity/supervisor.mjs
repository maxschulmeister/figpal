#!/usr/bin/env node

import { spawn } from "node:child_process";

// Starts the Antigravity ACP server (the arguments: its command and arguments) and ends it with all its tools when
// FigPal stops (process.ts). It passes its environment to the server unchanged.

const [agentCommand, ...agentArgs] = process.argv.slice(2);
if (!agentCommand) {
	process.stderr.write("Antigravity ACP supervisor: missing agent command\n");
	process.exit(64);
}

const parentPid = process.ppid;
const agent = spawn(agentCommand, agentArgs, {
	stdio: ["pipe", "pipe", "pipe"],
	shell: false,
	// Give Antigravity and every tool it starts a group separate from the watchdog.
	detached: true,
	env: process.env,
});

let shuttingDown = false;
let hardKillTimer;

process.stdin.pipe(agent.stdin);
agent.stdout.pipe(process.stdout);
agent.stderr.pipe(process.stderr);

const parentWatch = setInterval(() => {
	try {
		process.kill(parentPid, 0);
	} catch {
		shutdown(0);
	}
}, 500);
parentWatch.unref();

process.stdin.once("end", () => shutdown(0));
process.stdin.once("error", () => shutdown(1));
process.once("SIGTERM", () => shutdown(0));
process.once("SIGINT", () => shutdown(0));
process.once("SIGHUP", () => shutdown(0));

agent.once("error", (error) => {
	process.stderr.write(`Antigravity ACP supervisor: ${error.message}\n`);
	shutdown(1);
});
agent.once("exit", (code, signal) => {
	clearInterval(parentWatch);
	if (hardKillTimer) clearTimeout(hardKillTimer);
	process.stdin.unpipe(agent.stdin);
	process.stdin.destroy();
	if (!shuttingDown && signal) process.stderr.write(`Antigravity ACP agent exited on ${signal}\n`);
	const exitCode = code ?? (signal ? 1 : 0);
	// End forwarded stdout so the parent SDK closes immediately, then exit even
	// though the original parent may still hold its pipe descriptors open.
	process.stdout.end(() => process.exit(exitCode));
});

function shutdown(exitCode) {
	if (shuttingDown) return;
	shuttingDown = true;
	clearInterval(parentWatch);
	process.exitCode = exitCode;
	try {
		process.stdin.unpipe(agent.stdin);
		agent.stdin.end();
	} catch {
		// Agent input already closed.
	}
	signalAgent("SIGTERM");
	hardKillTimer = setTimeout(() => {
		signalAgent("SIGKILL");
		process.exit(exitCode);
	}, 750);
	// This timer must remain referenced: the watchdog owns killing the detached
	// agent process group before it is allowed to exit.
}

function signalAgent(signal) {
	try {
		if (agent.pid) process.kill(-agent.pid, signal);
		else agent.kill(signal);
	} catch {
		// ESRCH means the process tree is already gone.
	}
}
