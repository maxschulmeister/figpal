/**
 * @license
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BUNDLED_CLAUDE_VERSION, type ClaudeConfig, type ClaudeIdentity, isClaudeIdentity, isClaudeVersion, isObject } from "@figpal/shared/claude";

const VERSION_URL = "https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest";

async function readJson(path: string): Promise<unknown> {
	return readFile(path, "utf8").then((text) => JSON.parse(text)).catch(() => undefined);
}

async function discoverVersion(): Promise<string> {
	const cachePath = join(homedir(), ".config", "figpal", "claude-version.json");
	let version = BUNDLED_CLAUDE_VERSION;
	const cached = await readJson(cachePath);
	if (isObject(cached) && isClaudeVersion(cached.version)) version = cached.version;
	if (process.env.PI_OFFLINE === "1") return version;

	try {
		const response = await fetch(VERSION_URL, { signal: AbortSignal.timeout(2500) });
		if (!response.ok) return version;
		const data: unknown = await response.json();
		if (!isObject(data) || !isClaudeVersion(data.version)) return version;
		version = data.version;
		await mkdir(dirname(cachePath), { recursive: true });
		await writeFile(cachePath, `${JSON.stringify({ version })}\n`, "utf8");
	} catch {
		// Use the last valid version if the registry or cache write fails.
	}
	return version;
}

async function discoverIdentity(): Promise<ClaudeIdentity | undefined> {
	const environment = { deviceId: process.env.CLAUDE_CODE_DEVICE_ID, accountUuid: process.env.CLAUDE_CODE_ACCOUNT_UUID };
	if (isClaudeIdentity(environment)) return environment;
	const value = await readJson(join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json"));
	if (!isObject(value) || !isObject(value.oauthAccount)) return undefined;
	const identity = { deviceId: value.userID, accountUuid: value.oauthAccount.accountUuid };
	return isClaudeIdentity(identity) ? identity : undefined;
}

export function serveClaudeConfig(incoming: IncomingMessage, response: ServerResponse, config: ClaudeConfig) {
	const { host, origin, "sec-fetch-site": site } = incoming.headers;
	if (
		!host || !/^(localhost|127\.0\.0\.1):\d+$/u.test(host) ||
		(origin !== undefined && origin !== `http://${host}`) ||
		(site !== undefined && site !== "same-origin")
	) return response.writeHead(403).end("Forbidden");
	if (incoming.method !== "GET") return response.writeHead(405).end("Method not allowed");
	return response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(config));
}

export async function discoverClaude(): Promise<ClaudeConfig> {
	const [version, identity] = await Promise.all([discoverVersion(), discoverIdentity()]);
	return { version, ...(identity && { identity }) };
}
