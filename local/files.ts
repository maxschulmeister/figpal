// The shared folders: FigPal's agent reads and writes files in them, and nowhere else. A path starts with the name of
// a folder, "project/src/app.tsx".

import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import type { FileRequest } from "@figpal/shared/local";

export type Folder = { name: string; root: string };

/** A file for the model is text: larger files are not useful in a conversation. */
const MAX_READ_BYTES = 1_000_000;

/** The config of the helper that starts at login: the paths of the shared folders, and whether the home folder is shared. */
export type Config = { folders: string[]; home: boolean };

const EMPTY: Config = { folders: [], home: false };

/** The config in the file. Without a file, or with a broken one: no folders. */
export async function loadConfig(path: string): Promise<Config> {
	const value: unknown = await readFile(path, "utf8").then(JSON.parse).catch(() => EMPTY);
	const config = value as Partial<Config> | null;
	const valid =
		typeof config === "object" && config !== null && Array.isArray(config.folders) && config.folders.every((item) => typeof item === "string") && typeof config.home === "boolean";
	return valid ? { folders: config.folders!, home: config.home! } : EMPTY;
}

export async function saveConfig(path: string, config: Config): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(config, null, "\t")}\n`);
}

/** The folders of the config. A folder that is gone (deleted or moved) is left out, so the helper still starts. */
export function sharedFolders(config: Config, home: string): Folder[] {
	return folders([...config.folders, ...(config.home ? [home] : [])].filter((path) => existsSync(path)));
}

/** The folders by their names. The real paths: a symbolic link in a folder cannot lead out of it. */
export function folders(paths: string[]): Folder[] {
	const list = paths.map((path) => ({ name: basename(resolve(path)), root: realpathSync(path) }));
	const seen = new Set<string>();
	for (const { name } of list) {
		if (seen.has(name)) throw new Error(`Two shared folders are named "${name}". Share one of them, or a folder that has both.`);
		seen.add(name);
	}
	return list;
}

const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** The path on the disk, after a check that it stays in its folder. The file can be new. */
async function locate(shared: Folder[], path: string): Promise<string> {
	const [name = "", ...rest] = path.split("/");
	const folder = shared.find((item) => item.name === name);
	if (!folder) throw new Error(`No shared folder is named "${name}". The folders: ${shared.map((item) => item.name).join(", ")}.`);
	const target = resolve(folder.root, ...rest);
	const outside = () => new Error(`"${path}" is not in a shared folder.`);
	if (isAbsolute(rest.join("/")) || !inside(folder.root, target)) throw outside();
	// The nearest part that exists, with its symbolic links resolved, must stay in the folder too.
	let existing = target;
	while (!(await stat(existing).then(() => true, () => false))) existing = dirname(existing);
	if (!inside(folder.root, await realpath(existing))) throw outside();
	return target;
}

/** Runs a file request of the UI. */
export async function runFile(shared: Folder[], request: FileRequest): Promise<unknown> {
	if (request.op === "list" && request.path.replace(/\/$/, "") === "") return shared.map((folder) => `${folder.name}/`);
	const path = await locate(shared, request.path.replace(/\/$/, ""));
	if (request.op === "list") {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
	}
	if (request.op === "read") {
		if ((await stat(path)).size > MAX_READ_BYTES) throw new Error(`"${request.path}" is larger than 1 MB.`);
		return readFile(path, "utf8");
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, request.content);
	return { path: request.path, bytes: Buffer.byteLength(request.content) };
}
