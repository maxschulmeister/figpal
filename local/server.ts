// The WebSocket server of the bridge. FigPal's UI connects to it: the UI sends file requests and changes of the
// folders, and the bridge sends the requests of outside agents. The MCP processes of the agents (mcp.ts) connect on
// /agent. It listens on 127.0.0.1 only. It accepts only FigPal's origins, and on /agent only clients without an
// origin: a web page always sends its origin.

import { basename, resolve } from "node:path";
import { isRecord } from "@figpal/shared";
import type { AgentRequest, FolderChange, HelperToUi, UiToHelper, WireAttachment } from "@figpal/shared/local";
import { isHelperToUi, isUiToHelper } from "@figpal/shared/local";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { type Config, type Folder, loadConfig, runFile, saveConfig, sharedFolders } from "./files.ts";

export type Helper = {
	port: number;
	/** Sends a request of an outside agent to the FigPal window of the file, and gives its answer. */
	request(type: AgentRequest, params: Record<string, unknown>, file?: string): Promise<AgentResult>;
	close(): Promise<void>;
};

export type AgentResult = { result: unknown; attachments: WireAttachment[] };

/** The folders of the bridge of `figpal`: the config file, the home folder, and the folder picker. */
export type FolderOptions = { config: string; home: string; pick(): Promise<string[]> };

type Pending = { socket: WebSocket; resolve(value: AgentResult): void; reject(error: Error): void };

/** The path of the agents' MCP processes. */
export const AGENT_PATH = "/agent";

/** The messages between an agent's MCP process and the bridge: the same as between the bridge and FigPal. */
export type AgentMessage = Extract<HelperToUi, { kind: "request" }> & { file?: string };
export type AgentAnswer = Extract<UiToHelper, { kind: "response" }>;

const isAgentMessage = (value: unknown): value is AgentMessage =>
	isHelperToUi(value) && value.kind === "request" && (!("file" in value) || typeof value.file === "string");

/** A message as JSON, or undefined. */
export function parse(data: RawData): unknown {
	try {
		return JSON.parse(String(data));
	} catch {
		return undefined;
	}
}

/** Listens on the first free port of `ports`. */
async function listen(ports: readonly number[], origins: readonly string[]): Promise<{ server: WebSocketServer; port: number }> {
	for (const port of ports) {
		const server = new WebSocketServer({
			host: "127.0.0.1",
			port,
			// A web page can connect to localhost, but it cannot fake its origin.
			verifyClient: ({ origin, req }: { origin?: string; req: { url?: string } }) =>
				req.url === AGENT_PATH ? origin === undefined : origin !== undefined && origins.includes(origin),
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
	/** Only the bridge of `figpal` keeps folders: two bridges can run, and FigPal must not show the folders twice. */
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
			// FigPal before 2026-11-02 reads it.
			agent: false,
			manage: store !== undefined,
			home: config.home,
		});
	const helloAll = () => {
		for (const window of windows.keys()) hello(window);
	};

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
			if (!store) throw new Error("This bridge keeps no folders: it is for an outside agent.");
			const next = await changed(store, message.change);
			// It checks the names before it saves.
			const nextShared = sharedFolders(next, store.home);
			await saveConfig(store.config, next);
			[config, shared] = [next, nextShared];
			send(socket, { kind: "response", id: message.id, ok: true, result: null });
			helloAll();
		} catch (error) {
			send(socket, { kind: "response", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	};

	server.on("connection", (socket, request) => {
		if (request.url === AGENT_PATH) {
			socket.on("message", (data) => {
				const message = parse(data);
				if (!isAgentMessage(message)) {
					// For example a newer `figpal mcp` with a new request: its agent must not wait forever.
					if (isRecord(message) && typeof message.id === "string")
						send(socket, { kind: "response", id: message.id, ok: false, error: "The FigPal bridge does not know this request. Run pnpm local:install again." } satisfies AgentAnswer);
					return;
				}
				const { id, type, params, file } = message;
				helper.request(type, params, file).then(
					(answer) => send(socket, { kind: "response", id, ok: true, ...answer } satisfies AgentAnswer),
					(error: Error) => send(socket, { kind: "response", id, ok: false, error: error.message } satisfies AgentAnswer),
				);
			});
			return;
		}
		windows.set(socket, undefined);
		hello(socket);
		socket.on("message", (data) => {
			const message = parse(data);
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

	const helper: Helper = {
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
				for (const socket of server.clients) socket.terminate();
				server.close(() => resolve());
			}),
	};
	return helper;
}
