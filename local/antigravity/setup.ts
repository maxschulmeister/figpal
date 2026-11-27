// The setup of the Antigravity ACP server: Google publishes it in the official ACP registry, with a SHA-256 for each
// platform. FigPal downloads it on the first use, checks it, and installs it in its own folder (launch.ts). A newer
// release installs in the background: the running sessions keep the old one.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import yauzl from "yauzl";
import { AntigravityAcpConnection } from "./connection.ts";
import { AntigravityAcpError } from "./errors.ts";
import { acpEnvironment, type AntigravityLaunch, type InstallRecord, installedLaunch, ownServer, readInstallRecord, realpath, runtimeFolder } from "./launch.ts";

const execFileAsync = promisify(execFile);
const REGISTRY_URL = "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";
const REGISTRY_CHECK_MS = 24 * 60 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 45 * 60_000;
/** The largest archive is about 340 MB (Linux x64, version 1.5.2). */
const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
const MAX_FILE_BYTES = 4 * 1024 ** 3;
const VALIDATION_TIMEOUT_MS = 90_000;

/** One release for this platform: the archive, its SHA-256, and the command in it. */
export type Release = InstallRecord & { archive: string };

let installing: Promise<AntigravityLaunch> | undefined;
/** The callers that wait for the install: a second sign-in during the download also sees the steps. */
const listeners = new Set<(message: string) => void>();

/**
 * The server to start. The first time, this downloads and installs it, and `onProgress` tells the steps. Later, a
 * newer release installs in the background.
 */
export async function ensureRuntime(root: string, onProgress?: (message: string) => void): Promise<AntigravityLaunch> {
	const launch = installedLaunch(root);
	if (launch) {
		if (!ownServer()) void install(root).catch((error) => console.error("FigPal: the Antigravity update failed:", error));
		return launch;
	}
	if (ownServer()) throw new AntigravityAcpError("spawn", "AGY_ACP_BIN is not an executable file.");
	if (!onProgress) return install(root);
	listeners.add(onProgress);
	try {
		return await install(root);
	} finally {
		listeners.delete(onProgress);
	}
}

function install(root: string): Promise<AntigravityLaunch> {
	installing ??= installLatest(root).finally(() => {
		installing = undefined;
	});
	return installing;
}

async function installLatest(root: string): Promise<AntigravityLaunch> {
	const folder = runtimeFolder(root);
	const release = await latestRelease(folder);
	const link = realpath(path.join(folder, "current"));
	const current = link && path.basename(link);
	if (current !== release.sha256) {
		removeStaleInstalls(folder);
		const destination = path.join(folder, release.sha256);
		if (readInstallRecord(destination)?.sha256 !== release.sha256)
			await installRelease(destination, release, (message) => {
				for (const listener of listeners) listener(message);
			});
		pointCurrentAt(folder, release.sha256);
		// The release before stays until the next update: its servers may still run.
		removeOtherReleases(folder, [release.sha256, current]);
	}
	const launch = installedLaunch(root);
	if (!launch) throw new AntigravityAcpError("spawn", "The Antigravity ACP server did not install.");
	return launch;
}

/** The release of the registry, checked once a day. Without the network, the last one that FigPal got. */
async function latestRelease(folder: string): Promise<Release> {
	const cache = path.join(folder, "registry.json");
	let cached: { checkedAt: number; release: Release } | undefined;
	try {
		const { checkedAt, document } = JSON.parse(fs.readFileSync(cache, "utf8"));
		if (typeof checkedAt === "number") cached = { checkedAt, release: parseRelease(document, platformKey()) };
	} catch {
		// No valid cache.
	}
	if (cached && Date.now() - cached.checkedAt < REGISTRY_CHECK_MS) return cached.release;
	try {
		const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`The ACP registry answered HTTP ${response.status}`);
		const document: unknown = await response.json();
		const release = parseRelease(document, platformKey());
		fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
		const temporary = `${cache}.${process.pid}`;
		fs.writeFileSync(temporary, `${JSON.stringify({ checkedAt: Date.now(), document })}\n`, { mode: 0o600 });
		fs.renameSync(temporary, cache);
		return release;
	} catch (error) {
		if (cached) return cached.release;
		throw new AntigravityAcpError("spawn", `FigPal could not get the Antigravity ACP server: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The release of `platform` in the registry entry. Only a download from Google, with a SHA-256. */
export function parseRelease(document: unknown, platform: string): Release {
	const value = document as { version?: unknown; distribution?: { binary?: Record<string, Partial<{ archive: unknown; cmd: unknown; args: unknown; sha256: unknown }>> } };
	const entry = value?.distribution?.binary?.[platform];
	if (typeof value?.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(value.version)) throw new Error("The ACP registry has no valid version of Antigravity");
	if (!entry) throw new Error(`Antigravity has no ACP server for ${platform}`);
	const { archive, cmd, sha256 } = entry;
	const args = entry.args ?? [];
	if (typeof archive !== "string" || !archive.startsWith("https://dl.google.com/")) throw new Error("The ACP registry has an unexpected download URL");
	if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("The ACP registry has no valid SHA-256");
	if (typeof cmd !== "string" || !/^\.\/[\w.-]+$/u.test(cmd)) throw new Error("The ACP registry has an unexpected command");
	if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw new Error("The ACP registry has unexpected arguments");
	return { version: value.version, archive, sha256, cmd: cmd.slice(2), args };
}

async function installRelease(destination: string, release: Release, onProgress?: (message: string) => void): Promise<void> {
	const folder = path.dirname(destination);
	fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
	const staging = fs.mkdtempSync(path.join(folder, ".install-"));
	const archive = path.join(staging, "download.zip");
	const runtime = path.join(staging, "runtime");
	fs.mkdirSync(runtime, { mode: 0o700 });
	try {
		onProgress?.(`Downloading Antigravity ${release.version}…`);
		if ((await download(release.archive, archive, onProgress)) !== release.sha256) throw new Error("The download of Antigravity has a wrong SHA-256");
		onProgress?.("Unpacking Antigravity…");
		await extract(archive, runtime);
		fs.rmSync(archive, { force: true });
		const binary = path.join(runtime, release.cmd);
		if (!fs.statSync(binary, { throwIfNoEntry: false })?.isFile()) throw new Error(`The Antigravity archive has no ${release.cmd}`);
		if (process.platform === "darwin")
			await Promise.all(fs.readdirSync(runtime).map((name) => execFileAsync("xattr", ["-d", "com.apple.quarantine", path.join(runtime, name)]).catch(() => undefined)));
		onProgress?.("Checking Antigravity…");
		await validate(runtime, release);
		const { archive: _, ...record } = release;
		fs.writeFileSync(path.join(runtime, "install.json"), `${JSON.stringify(record satisfies InstallRecord, null, "\t")}\n`, { mode: 0o600 });
		try {
			fs.renameSync(runtime, destination);
		} catch (error) {
			// Another FigPal process (the UI's dev server) installed the same release first.
			if (readInstallRecord(destination)?.sha256 !== release.sha256) throw error;
		}
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

/** Downloads `url` to `file`, and gives its SHA-256. */
async function download(url: string, file: string, onProgress?: (message: string) => void): Promise<string> {
	const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok || !response.body) throw new Error(`The download of Antigravity answered HTTP ${response.status}`);
	const total = Number(response.headers.get("content-length")) || undefined;
	const hash = createHash("sha256");
	const reader = response.body.getReader();
	async function* chunks() {
		let received = 0;
		let reported = 0;
		try {
			for (let read = await reader.read(); !read.done; read = await reader.read()) {
				received += read.value.byteLength;
				if (received > MAX_ARCHIVE_BYTES) throw new Error("The download of Antigravity is too large");
				hash.update(read.value);
				const percent = total ? Math.floor((received / total) * 100) : 0;
				if (percent >= reported + 10) {
					reported = percent - (percent % 10);
					onProgress?.(`Downloading Antigravity: ${reported}%`);
				}
				yield read.value;
			}
		} finally {
			// A failed write or a too-large download stops the download too.
			await reader.cancel().catch(() => undefined);
		}
	}
	await pipeline(chunks(), fs.createWriteStream(file, { mode: 0o600 }));
	return hash.digest("hex");
}

/** Unpacks the files of the archive into `folder`: only files at the top, as Google packs them, and executable. */
async function extract(archive: string, folder: string): Promise<void> {
	const zip = await promisify<string, yauzl.Options, yauzl.ZipFile>(yauzl.open)(archive, { lazyEntries: true, autoClose: true });
	const openEntry = promisify(zip.openReadStream.bind(zip));
	await new Promise<void>((resolve, reject) => {
		zip.on("error", reject);
		zip.on("end", resolve);
		zip.on("entry", (entry: yauzl.Entry) => {
			if (entry.fileName.endsWith("/")) return zip.readEntry();
			if (!/^[\w.-]+$/u.test(entry.fileName) || entry.fileName.startsWith(".") || entry.uncompressedSize > MAX_FILE_BYTES) {
				zip.close();
				return reject(new Error(`The Antigravity archive has an unexpected file: ${entry.fileName}`));
			}
			openEntry(entry)
				.then((stream) => pipeline(stream, fs.createWriteStream(path.join(folder, entry.fileName), { flags: "wx", mode: 0o700 })))
				.then(() => zip.readEntry(), (error) => {
					zip.close();
					reject(error);
				});
		});
		zip.readEntry();
	});
}

/** The downloaded server must start and say that it is Antigravity of this version. */
async function validate(folder: string, release: Release): Promise<void> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "figpal-antigravity-check-"));
	let connection: AntigravityAcpConnection | undefined;
	try {
		connection = new AntigravityAcpConnection({
			cwd: folder,
			command: path.join(folder, release.cmd),
			args: release.args,
			env: acpEnvironment(home),
			initializeTimeoutMs: VALIDATION_TIMEOUT_MS,
			operationTimeoutMs: VALIDATION_TIMEOUT_MS,
		});
		const { protocolVersion, agentInfo } = await connection.initialize();
		// Google reports the release as "agy_acp_server_<semver>"; the registry has the bare version.
		const versions = [release.version, `agy_acp_server_${release.version}`];
		if (protocolVersion !== 1 || agentInfo?.name !== "antigravity-acp" || !versions.includes(agentInfo.version))
			throw new Error("The downloaded server is not the expected Antigravity ACP release");
	} finally {
		await connection?.close();
		fs.rmSync(home, { recursive: true, force: true });
	}
}

function pointCurrentAt(folder: string, name: string): void {
	const current = path.join(folder, "current");
	const temporary = path.join(folder, `.current-${process.pid}`);
	fs.rmSync(temporary, { force: true });
	fs.symlinkSync(name, temporary, "dir");
	fs.renameSync(temporary, current);
}

function removeOtherReleases(folder: string, keep: (string | undefined)[]): void {
	for (const name of fs.readdirSync(folder))
		if (/^[0-9a-f]{64}$/u.test(name) && !keep.includes(name)) fs.rmSync(path.join(folder, name), { recursive: true, force: true });
}

/** The folders of installs that stopped with FigPal. An install of now (in another FigPal process) is younger. */
function removeStaleInstalls(folder: string): void {
	for (const name of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
		const file = path.join(folder, name);
		if (/^\.(install|current)-/u.test(name) && Date.now() - fs.lstatSync(file).mtimeMs > DOWNLOAD_TIMEOUT_MS) fs.rmSync(file, { recursive: true, force: true });
	}
}

export function platformKey(): string {
	if (process.platform !== "darwin" && process.platform !== "linux") throw new AntigravityAcpError("spawn", `Antigravity does not run on ${process.platform}`);
	if (process.arch !== "x64" && process.arch !== "arm64") throw new AntigravityAcpError("spawn", `Antigravity does not run on ${process.arch}`);
	return `${process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
}
