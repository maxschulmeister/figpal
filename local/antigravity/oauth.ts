import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CAPTURE_ENV = "FIGPAL_ANTIGRAVITY_OAUTH_CAPTURE_FILE";
const CAPTURE_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

/**
 * The ACP server does not surface its OAuth URL: it opens a browser. FigPal replaces the browser command with a private
 * capture helper and gives the URL to its UI, which opens it (FigPal runs as a service, which may have no display).
 * The browser then calls the server's loopback listener on this computer.
 */
export class OAuthCapture {
	readonly env: NodeJS.ProcessEnv;
	private readonly directory: string;
	private readonly captureFile: string;
	private disposed = false;

	constructor(baseEnv: NodeJS.ProcessEnv = process.env) {
		this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "figpal-antigravity-oauth-"));
		fs.chmodSync(this.directory, 0o700);
		this.captureFile = path.join(this.directory, "authorization-url");
		const browser = path.join(this.directory, "capture-browser");
		fs.writeFileSync(
			browser,
			`#!/bin/sh\numask 077\nprintf '%s\\n' "$1" > "$${CAPTURE_ENV}"\n`,
			{ mode: 0o700 },
		);
		const executable = path.join(this.directory, "xdg-open");
		fs.copyFileSync(browser, executable);
		fs.chmodSync(executable, 0o700);
		this.env = {
			...baseEnv,
			BROWSER: browser,
			[CAPTURE_ENV]: this.captureFile,
			PATH: `${this.directory}${path.delimiter}${baseEnv.PATH ?? ""}`,
		};
	}

	async waitForUrl(signal?: AbortSignal): Promise<string> {
		const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
		for (;;) {
			if (this.disposed) throw new Error("Antigravity OAuth relay was closed");
			signal?.throwIfAborted();
			try {
				const stat = fs.lstatSync(this.captureFile);
				if (!stat.isFile() || stat.size > MAX_CAPTURE_BYTES) {
					throw new Error("Antigravity OAuth browser capture produced an invalid file");
				}
				const text = fs.readFileSync(this.captureFile, "utf8").trim();
				if (text) return parseAuthorization(text);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (Date.now() >= deadline) {
				throw new Error("Antigravity did not provide an OAuth URL within 30 seconds");
			}
			await delay(100, undefined, { signal, ref: false });
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		fs.rmSync(this.directory, { recursive: true, force: true });
	}
}

function parseAuthorization(text: string): string {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new Error("Antigravity produced an invalid OAuth authorization URL");
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "accounts.google.com" ||
		url.pathname !== "/o/oauth2/v2/auth"
	) {
		throw new Error("Antigravity produced an unexpected OAuth authorization URL");
	}
	const redirect = url.searchParams.get("redirect_uri");
	const state = url.searchParams.get("state");
	if (!redirect || !state) throw new Error("Antigravity OAuth URL is missing redirect or state data");
	validateLoopback(new URL(redirect));
	const prompts = new Set(url.searchParams.get("prompt")?.split(/\s+/u).filter(Boolean));
	prompts.delete("none");
	prompts.add("select_account");
	url.searchParams.set("prompt", [...prompts].join(" "));
	return url.toString();
}

function validateLoopback(url: URL): void {
	if (
		url.protocol !== "http:" ||
		!(url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") ||
		!url.port ||
		url.username ||
		url.password
	) {
		throw new Error("Antigravity OAuth redirect is not a valid loopback URL");
	}
}
