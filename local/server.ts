// The WebSocket server of the helper. FigPal's UI connects to it: the UI sends file requests and changes of the folders,
// and the helper sends the requests of an outside agent. It listens on 127.0.0.1 only, and accepts only FigPal's origins.

import { basename, resolve } from "node:path";
import type { AgentRequest, FolderChange, UiToHelper, WireAttachment } from "@figpal/shared/local";
import { isUiToHelper } from "@figpal/shared/local";
import { type WebSocket, WebSocketServer } from "ws";
import { type Config, type Folder, loadConfig, runFile, saveConfig, sharedFolders } from "./files.ts";

export type Helper = {
	port: number;
	/** Sends a request of an outside agent to the FigPal window of the file, and gives its answer. */
	request(type: AgentRequest, params: Record<string, unknown>, file?: string): Promise<{ result: unknown; attachments: WireAttachment[] }>;
	close(): Promise<void>;
};

/** The folders of the helper that starts at login: the config file, the home folder, and the folder picker. */
export type FolderOptions = { config: string; home: string; pick(): Promise<string[]> };

type Pending = { socket: WebSocket; resolve(value: { result: unknown; attachments: WireAttachment[] }): void; reject(error: Error): void };

/** Listens on the first free port of `ports`. */
async function listen(ports: readonly number[], origins: readonly string[]): Promise<{ server: WebSocketServer; port: number }> {
	for (const port of ports) {
		const server = new WebSocketServer({
			host: "127.0.0.1",
			port,
			// A web page can connect to localhost, but it cannot fake its origin.
			verifyClient: ({ origin }: { origin: string }) => origins.includes(origin),
		});
		const listening = await new Promise<boolean>((resolve) => {
			server.once("listening", () => resolve(true));
			server.once("error", () => resolve(false));
		});
		if (listening) return { server, port };
	}
	throw new Error(`The ports ${ports[0]} to ${ports.at(-1)} are in use. Stop another FigPal helper.`);
}

export async function startHelper(options: {
	origins: readonly string[];
	ports: readonly number[];
	/** An outside agent uses this helper (MCP). */
	agent: boolean;
	/** Only the helper that starts at login keeps folders. */
	folders?: FolderOptions;
}): Promise<Helper> {
	const store = options.folders;
	let config: Config = store ? await loadConfig(store.config) : { folders: [], home: false };
	let shared: Folder[] = store ? sharedFolders(config, store.home) : [];
	const { server, port } = await listen(options.ports, options.origins);
	/** The FigPal windows, oldest first, with the names of their files. */
	const windows = new Map<WebSocket, string | undefined>();
	const pending = new Map<string, Pending>();
	let nextId = 0;

	const send = (socket: WebSocket, message: object) => socket.send(JSON.stringify(message));
	const hello = (socket: WebSocket) =>
		send(socket, {
			kind: "hello",
			folders: shared.map((folder) => folder.name),
			agent: options.agent,
			manage: store !== undefined,
			home: config.home,
		});

	/** The config after a change. "add" opens the folder picker. */
	const changed = async (store: FolderOptions, change: FolderChange): Promise<Config> => {
		if (change.op === "home") return { ...config, home: change.on };
		if (change.op === "add") {
			const picked = (await store.pick()).map((path) => resolve(path));
			return { ...config, folders: [...config.folders, ...picked.filter((path) => !config.folders.includes(path))] };
		}
		const folders = config.folders.filter((path) => basename(resolve(path)) !== change.name);
		return { folders, home: config.home && basename(store.home) !== change.name };
	};
	const answer = async (socket: WebSocket, message: Extract<UiToHelper, { kind: "files" | "folders" }>) => {
		try {
			if (message.kind === "files") {
				send(socket, { kind: "response", id: message.id, ok: true, result: await runFile(shared, message.request) });
				return;
			}
			if (!store) throw new Error("This helper keeps no folders: it is for an outside agent.");
			const next = await changed(store, message.change);
			// It checks the names before it saves.
			const nextShared = sharedFolders(next, store.home);
			await saveConfig(store.config, next);
			[config, shared] = [next, nextShared];
			send(socket, { kind: "response", id: message.id, ok: true, result: null });
			for (const window of windows.keys()) hello(window);
		} catch (error) {
			send(socket, { kind: "response", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	};

	server.on("connection", (socket) => {
		windows.set(socket, undefined);
		hello(socket);
		socket.on("message", (data) => {
			let message: unknown;
			try {
				message = JSON.parse(String(data));
			} catch {
				return;
			}
			if (!isUiToHelper(message)) return;
			if (message.kind === "window") {
				windows.set(socket, message.file);
				return;
			}
			if (message.kind === "files" || message.kind === "folders") {
				void answer(socket, message);
				return;
			}
			const waiting = pending.get(message.id);
			if (!waiting || waiting.socket !== socket) return;
			pending.delete(message.id);
			if (message.ok) waiting.resolve({ result: message.result, attachments: message.attachments });
			else waiting.reject(new Error(message.error));
		});
		socket.on("close", () => {
			windows.delete(socket);
			for (const [id, waiting] of pending)
				if (waiting.socket === socket) {
					pending.delete(id);
					waiting.reject(new Error("FigPal closed before it answered."));
				}
		});
	});

	return {
		port,
		request(type, params, file) {
			// A window counts once it names its file: it does so at once after the hello.
			const open = [...windows].filter((entry): entry is [WebSocket, string] => entry[1] !== undefined);
			const names = open.map(([, name]) => `"${name}"`).join(", ");
			const matches = file === undefined ? open : open.filter(([, name]) => name === file);
			if (open.length === 0) return Promise.reject(new Error("FigPal is not open. Run the FigPal plugin in Figma Desktop."));
			if (matches.length === 0) return Promise.reject(new Error(`FigPal is not open in "${file}". Open files: ${names}.`));
			if (matches.length > 1) return Promise.reject(new Error(`FigPal is open in several files: ${names}. Give the file.`));
			const socket = matches[0]![0];
			const id = String(++nextId);
			return new Promise((resolve, reject) => {
				pending.set(id, { socket, resolve, reject });
				send(socket, { kind: "request", id, type, params });
			});
		},
		close: () =>
			new Promise((resolve) => {
				for (const socket of windows.keys()) socket.terminate();
				server.close(() => resolve());
			}),
	};
}
