// The folders of Antigravity in FigPal, under one root (in FigPal's app folder): the ACP server (runtime/), its Google
// login (gemini/), and the empty folder that its sessions work in (workspace/).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AntigravityLaunch = { command: string; args: string[] };

/** What the setup writes next to the ACP server: the version and how to start it. */
export type InstallRecord = { version: string; sha256: string; cmd: string; args: string[] };

export const runtimeFolder = (root: string) => path.join(root, "runtime");

/** Antigravity writes files into the folder of a session: an empty folder of FigPal, not a folder of the user. */
export function workspaceFolder(root: string): string {
	const folder = path.join(root, "workspace");
	fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
	return folder;
}

/** The server keeps its login under GEMINI_HOME. FigPal's own home keeps it apart from other Antigravity clients. */
export function acpEnvironment(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	// FigPal signs in with Google only: a key of the environment must not replace that login.
	const { GEMINI_API_KEY: _, ...rest } = env;
	return {
		...rest,
		GEMINI_HOME: path.join(root, "gemini"),
		// The upstream macOS keychain entry does not follow GEMINI_HOME (credential_store.py).
		AGY_ACP_FORCE_FILE_STORAGE: "1",
	};
}

const acpDirectory = (root: string) => path.join(root, "gemini", "antigravity-acp");
const tokenFile = (root: string) => path.join(acpDirectory(root), "acp_token.json");

/** True when the server saved a Google login that it can refresh. */
export function hasSavedGoogleLogin(root: string): boolean {
	try {
		const token = JSON.parse(fs.readFileSync(tokenFile(root), "utf8")) as { refresh_token?: unknown };
		return typeof token.refresh_token === "string" && token.refresh_token.length > 0;
	} catch {
		return false;
	}
}

export function clearGoogleLogin(root: string): void {
	fs.rmSync(tokenFile(root), { force: true });
}

/** The conversation files that the server writes for a session (after pi-antigravity-acp-provider). */
export function removeConversation(root: string, sessionId: string): void {
	// Only a UUID: the path cannot leave the folder.
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sessionId)) return;
	for (const suffix of [".db", ".db-shm", ".db-wal", ".meta"]) fs.rmSync(path.join(acpDirectory(root), "conversations", sessionId + suffix), { force: true });
}

/** An own server (an own install, or a test server) in place of the one that the setup installs. */
export const ownServer = () => process.env.AGY_ACP_BIN?.trim() || undefined;

/**
 * The server to start: AGY_ACP_BIN (an own install, or a test agent), else the one that the setup installed. Undefined
 * when there is none.
 */
export function installedLaunch(root: string): AntigravityLaunch | undefined {
	const env = ownServer();
	if (env) {
		const command = env === "~" || env.startsWith("~/") ? path.join(os.homedir(), env.slice(1)) : env;
		return executable(command) ? directOrWrapper(command) : undefined;
	}
	// The release itself, not the link "current": an update must not change the files of a running server.
	const current = realpath(path.join(runtimeFolder(root), "current"));
	const record = current && readInstallRecord(current);
	if (!current || !record) return undefined;
	const command = path.join(current, record.cmd);
	return executable(command) ? { command, args: record.args } : undefined;
}

export function readInstallRecord(folder: string): InstallRecord | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(path.join(folder, "install.json"), "utf8")) as Partial<InstallRecord>;
		if (
			typeof value.version !== "string" ||
			typeof value.sha256 !== "string" ||
			typeof value.cmd !== "string" ||
			!Array.isArray(value.args) ||
			!value.args.every((arg) => typeof arg === "string")
		)
			return undefined;
		return value as InstallRecord;
	} catch {
		return undefined;
	}
}

function directOrWrapper(command: string): AntigravityLaunch {
	try {
		const fd = fs.openSync(command, "r");
		const bytes = Buffer.alloc(64);
		const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
		fs.closeSync(fd);
		if (bytes.subarray(0, count).toString("utf8").startsWith("#!")) return { command, args: [] };
	} catch {
		// Native executable; use the server's required empty uid argument.
	}
	return { command, args: process.platform === "linux" ? ["--uid="] : [] };
}

function executable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

export function realpath(file: string): string | undefined {
	try {
		return fs.realpathSync(file);
	} catch {
		return undefined;
	}
}
