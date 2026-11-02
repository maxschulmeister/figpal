// The WebSocket server of the helper. FigPal's UI connects to it: the UI sends file requests, and the helper sends the
// requests of an outside agent. It listens on 127.0.0.1 only, and accepts only FigPal's origins.

import type { AgentRequest, UiToHelper, WireAttachment } from "@figpal/shared/local";
import { isUiToHelper } from "@figpal/shared/local";
import { type WebSocket, WebSocketServer } from "ws";
import { type Folder, runFile } from "./files.ts";

export type Helper = {
	port: number;
	/** Sends a request of an outside agent to the newest FigPal window, and gives its answer. */
	request(type: AgentRequest, params: Record<string, unknown>): Promise<{ result: unknown; attachments: WireAttachment[] }>;
	close(): Promise<void>;
};

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
	folders: Folder[];
	origins: readonly string[];
	ports: readonly number[];
	/** An outside agent uses this helper (MCP). */
	agent: boolean;
}): Promise<Helper> {
	const { server, port } = await listen(options.ports, options.origins);
	/** The FigPal windows, oldest first. */
	const windows: WebSocket[] = [];
	const pending = new Map<string, Pending>();
	let nextId = 0;

	const send = (socket: WebSocket, message: object) => socket.send(JSON.stringify(message));
	const answer = async (socket: WebSocket, message: Extract<UiToHelper, { kind: "files" }>) => {
		try {
			send(socket, { kind: "response", id: message.id, ok: true, result: await runFile(options.folders, message.request) });
		} catch (error) {
			send(socket, { kind: "response", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	};

	server.on("connection", (socket) => {
		windows.push(socket);
		send(socket, { kind: "hello", folders: options.folders.map((folder) => folder.name), agent: options.agent });
		socket.on("message", (data) => {
			let message: unknown;
			try {
				message = JSON.parse(String(data));
			} catch {
				return;
			}
			if (!isUiToHelper(message)) return;
			if (message.kind === "files") {
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
			windows.splice(windows.indexOf(socket), 1);
			for (const [id, waiting] of pending)
				if (waiting.socket === socket) {
					pending.delete(id);
					waiting.reject(new Error("FigPal closed before it answered."));
				}
		});
	});

	return {
		port,
		request(type, params) {
			const socket = windows.at(-1);
			if (!socket) return Promise.reject(new Error("FigPal is not connected. Run the FigPal plugin in Figma Desktop."));
			const id = String(++nextId);
			return new Promise((resolve, reject) => {
				pending.set(id, { socket, resolve, reject });
				send(socket, { kind: "request", id, type, params });
			});
		},
		close: () =>
			new Promise((resolve) => {
				for (const socket of windows) socket.terminate();
				server.close(() => resolve());
			}),
	};
}
