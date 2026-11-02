// The local helper (local/cli.ts) on the user's machine: FigPal connects to it to read and write the shared folders,
// and to run the requests of an outside agent (MCP) in code.js, when the user allows it.

import {
	type FileRequest,
	type HelperToUi,
	isHelperToUi,
	LOCAL_PORTS,
	type UiToHelper,
	type WireAttachment,
} from "@figpal/shared/local";
import type { Bridge } from "./bridge";
import { toBase64 } from "./extensions/figma";

export type LocalState = { folders: string[]; agent: boolean };
export type LocalFiles = (request: FileRequest) => Promise<unknown>;

/** How often FigPal looks for a helper. A failed try writes an error in the console of the browser. */
const SCAN_MS = 10_000;

type Helper = { socket: WebSocket; folders: string[]; agent: boolean };

export function connectLocal(options: {
	bridge: Pick<Bridge, "request">;
	allowAgents(): boolean;
	onChange(state: LocalState): void;
	ports?: readonly number[];
	/** For tests. */
	open?: (url: string) => WebSocket;
}): { files: LocalFiles; stop(): void } {
	const open = options.open ?? ((url: string) => new WebSocket(url));
	const helpers = new Map<number, Helper>();
	const trying = new Set<number>();
	/** All open and opening sockets, so that stop closes them. */
	const sockets = new Set<WebSocket>();
	const pending = new Map<string, { socket: WebSocket; resolve(value: unknown): void; reject(error: Error): void }>();
	let nextId = 0;

	const changed = () => {
		const list = [...helpers.values()];
		options.onChange({ folders: list.flatMap((helper) => helper.folders), agent: list.some((helper) => helper.agent) });
	};
	const send = (socket: WebSocket, message: UiToHelper) => socket.send(JSON.stringify(message));

	/** A request of an outside agent: code.js runs it, as for FigPal's own agent. */
	const run = async (socket: WebSocket, message: Extract<HelperToUi, { kind: "request" }>) => {
		if (!options.allowAgents()) {
			send(socket, { kind: "response", id: message.id, ok: false, error: "MCP is off in FigPal. The user can turn it on: Settings → Access → Enable MCP." });
			return;
		}
		try {
			const { result, attachments } = await options.bridge.request(message.type, message.params as never);
			const files: WireAttachment[] = attachments.map(({ bytes, ...file }) => ({ ...file, data: toBase64(bytes) }));
			send(socket, { kind: "response", id: message.id, ok: true, result, attachments: files });
		} catch (error) {
			send(socket, { kind: "response", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	};

	const connect = (port: number) => {
		trying.add(port);
		const socket = open(`ws://127.0.0.1:${port}`);
		sockets.add(socket);
		socket.addEventListener("message", (event) => {
			let message: unknown;
			try {
				message = JSON.parse(String((event as MessageEvent).data));
			} catch {
				return;
			}
			if (!isHelperToUi(message)) return;
			if (message.kind === "hello") {
				trying.delete(port);
				helpers.set(port, { socket, folders: message.folders, agent: message.agent });
				changed();
			} else if (message.kind === "request") void run(socket, message);
			else {
				const waiting = pending.get(message.id);
				if (waiting?.socket !== socket) return;
				pending.delete(message.id);
				if (message.ok) waiting.resolve(message.result);
				else waiting.reject(new Error(message.error));
			}
		});
		socket.addEventListener("close", () => {
			sockets.delete(socket);
			trying.delete(port);
			if (helpers.get(port)?.socket !== socket) return;
			helpers.delete(port);
			for (const [id, waiting] of pending)
				if (waiting.socket === socket) {
					pending.delete(id);
					waiting.reject(new Error("The FigPal helper stopped before it answered."));
				}
			changed();
		});
	};

	const scan = () => {
		for (const port of options.ports ?? LOCAL_PORTS) if (!helpers.has(port) && !trying.has(port)) connect(port);
	};
	scan();
	const timer = setInterval(scan, SCAN_MS);

	return {
		files(request) {
			const name = request.path.split("/")[0] ?? "";
			const all = [...helpers.values()];
			if (request.op === "list" && name === "") return Promise.resolve(all.flatMap((helper) => helper.folders.map((folder) => `${folder}/`)));
			const helper = all.find((item) => item.folders.includes(name));
			if (!helper) return Promise.reject(new Error(`No shared folder is named "${name}".`));
			const id = String(++nextId);
			return new Promise((resolve, reject) => {
				pending.set(id, { socket: helper.socket, resolve, reject });
				send(helper.socket, { kind: "files", id, request });
			});
		},
		stop() {
			clearInterval(timer);
			for (const socket of sockets) socket.close();
		},
	};
}
