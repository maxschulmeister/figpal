import fs from "node:fs";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { redact } from "./errors.ts";
import { applyAcpProxyEnvironment } from "./proxy.ts";
const STDERR_LIMIT = 16 * 1024;
const STDERR_LINE_LIMIT = 4 * 1024;
// Longer than supervisor.mjs's 750 ms agent-tree escalation window.
const KILL_GRACE_MS = 1_500;

export interface AntigravityProcessOptions {
	cwd: string;
	command: string;
	args?: string[];
	env?: NodeJS.ProcessEnv;
}

export interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderrTail: string;
}

const CA_BUNDLE_PATHS = [
	"/etc/ssl/certs/ca-bundle.crt",
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/ca-bundle.pem",
	"/etc/ssl/cert.pem",
];

function isReadableRegularFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.R_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

/** The server needs a CA bundle: SSL_CERT_FILE, else NIX_SSL_CERT_FILE, else one of the system. */
function applyDefaultTlsEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...baseEnv };
	if (env.SSL_CERT_FILE) return env;
	const candidates = [env.NIX_SSL_CERT_FILE, ...CA_BUNDLE_PATHS].filter((file): file is string => Boolean(file));
	const certFile = candidates.find(isReadableRegularFile);
	if (certFile) env.SSL_CERT_FILE = certFile;
	return env;
}

export class AntigravityProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly input: ReadableStream<Uint8Array>;
	readonly output: WritableStream<Uint8Array>;
	readonly exited: Promise<ProcessExit>;
	private stderr = "";
	private stderrPartial = "";
	private readonly stderrLineListeners = new Set<(line: string) => void>();
	private settled = false;
	private closing?: Promise<void>;

	constructor(options: AntigravityProcessOptions) {
		// The supervisor ends the server and its tools when FigPal stops (supervisor.mjs).
		const command = process.execPath;
		// Next to this file, and next to cli.mjs in the package (local/build.ts copies it).
		const args = [fileURLToPath(new URL("./supervisor.mjs", import.meta.url)), options.command, ...(options.args ?? [])];
		let resolveExit!: (exit: ProcessExit) => void;
		this.exited = new Promise((resolve) => {
			resolveExit = resolve;
		});

		const env = applyDefaultTlsEnvironment(applyAcpProxyEnvironment(options.env ?? process.env));
		const child = spawn(command, args, {
			cwd: path.resolve(options.cwd),
			env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			detached: true,
		});
		this.child = child;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr = redact((this.stderr + chunk).slice(-STDERR_LIMIT));
			const lines = (this.stderrPartial + chunk).split("\n");
			this.stderrPartial = lines.pop()!.slice(-STDERR_LINE_LIMIT);
			for (const line of lines) {
				const safe = redact(line.slice(-STDERR_LINE_LIMIT));
				for (const listener of this.stderrLineListeners) listener(safe);
			}
		});
		child.once("error", (cause) => {
			this.finish(resolveExit, null, null, `spawn failed: ${cause.message}`);
		});
		child.once("exit", (code, signal) => {
			this.finish(resolveExit, code, signal, this.stderr);
		});

		this.input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
		this.output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
	}

	get stderrTail(): string {
		return this.stderr;
	}

	/** Complete, redacted and length-bounded stderr lines as they arrive. */
	onStderrLine(listener: (line: string) => void): void {
		this.stderrLineListeners.add(listener);
	}

	get alive(): boolean {
		// child.killed only records that kill() was called; it does not mean the
		// process has exited. Keep it alive until exit/error settles.
		return !this.settled && this.child.exitCode === null;
	}

	async close(): Promise<void> {
		this.closing ??= this.closeOnce();
		return this.closing;
	}

	private async closeOnce(): Promise<void> {
		if (!this.alive) return;
		// Do not end stdin independently of the Web WritableStream adapter. An
		// in-flight SDK write may otherwise reach Node after stdin.end() and raise
		// ERR_STREAM_WRITE_AFTER_END as an uncaught stream error. Terminating the
		// owned process tree closes all three stdio streams together.
		this.signal("SIGTERM");
		const exited = await Promise.race([
			this.exited.then(() => true),
			delay(KILL_GRACE_MS).then(() => false),
		]);
		if (!exited && this.alive) {
			this.signal("SIGKILL");
			await Promise.race([this.exited, delay(KILL_GRACE_MS)]);
		}
	}

	private signal(signal: NodeJS.Signals): void {
		try {
			if (this.child.pid) process.kill(-this.child.pid, signal);
			else this.child.kill(signal);
		} catch {
			// ESRCH means the process tree is already gone.
		}
	}

	private finish(
		resolve: (exit: ProcessExit) => void,
		code: number | null,
		signal: NodeJS.Signals | null,
		stderrTail: string,
	): void {
		if (this.settled) return;
		this.settled = true;
		resolve({ code, signal, stderrTail: redact(stderrTail) });
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

