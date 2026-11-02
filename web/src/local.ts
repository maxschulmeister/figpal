// The local helpers (local/cli.ts) on the user's machine: FigPal connects to them to read and write the shared folders,
// to change the folders, and to run the requests of an outside agent (MCP) in code.js, when the user allows it. One
// helper, the bridge, serves all outside agents. Older installs have a helper for each agent.

import {
	type FileRequest,
	type FolderChange,
	type HelperToUi,
	isHelperToUi,
	LOCAL_PORTS,
	type UiToHelper,
	type WireAttachment,
} from "@figpal/shared/local";
import type { Bridge } from "./bridge";
import { toBase64 } from "./extensions/figma";

/**
 * The shared folders; whether an outside agent is connected; whether the helper that keeps the folders is connected,
 * and whether it shares the home folder.
 */
export type LocalState = { folders: string[]; agent: boolean; manage: boolean; home: boolean };
export type LocalFiles = (request: FileRequest) => Promise<unknown>;

/** How often FigPal looks for helpers, and when its window gets the focus. A failed try writes an error in the console. */
const SCAN_MS = 30_000;

type Helper = Omit<Extract<HelperToUi, { kind: "hello" }>, "kind"> & { socket: WebSocket };

export function connectLocal(options: {
	bridge: Pick<Bridge, "request">;
	/** The name of the open file: an outside agent can choose the file. */
	file: string;
	allowAgents(): boolean;
	onChange(state: LocalState): void;
	ports?: readonly number[];
	/** For tests. */
	open?: (url: string) => WebSocket;
}): { files: LocalFiles; changeFolders(change: FolderChange): Promise<void>; stop(): void } {
	const open = options.open ?? ((url: string) => new WebSocket(url));
	const helpers = new Map<number, Helper>();
	const trying = new Set<number>();
	/** All open and opening sockets, so that stop closes them. */
	const sockets = new Set<WebSocket>();
	const pending = new Map<string, { socket: WebSocket; resolve(value: unknown): void; reject(error: Error): void }>();
	let nextId = 0;

	const keeper = () => [...helpers.values()].find((helper) => helper.manage);
	const changed = () => {
		const list = [...helpers.values()];
		options.onChange({
			folders: list.flatMap((helper) => helper.folders),
			agent: list.some((helper) => helper.agent),
			manage: keeper() !== undefined,
			home: keeper()?.home ?? false,
		});
	};
	const send = (socket: WebSocket, message: UiToHelper) => socket.send(JSON.stringify(message));
	/** Sends a request to a helper, and gives its answer. */
	const ask = (socket: WebSocket, message: (id: string) => UiToHelper) => {
		const id = String(++nextId);
		return new Promise<unknown>((resolve, reject) => {
			pending.set(id, { socket, resolve, reject });
			send(socket, message(id));
		});
	};

	/** A request of an outside agent: code.js runs it, as for FigPal's own agent. */
	const run = async (socket: WebSocket, message: Extract<HelperToUi, { kind: "request" }>) => {
		if (!options.allowAgents()) {
			send(socket, { kind: "response", id: message.id, ok: false, error: "MCP is off in FigPal. The user can turn it on: Settings → Access → MCP." });
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
				// The first hello: the helper learns the file. A later one has new folders.
				if (helpers.get(port)?.socket !== socket) send(socket, { kind: "window", file: options.file });
				const { kind: _, ...hello } = message;
				helpers.set(port, { ...hello, socket });
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
	addEventListener("focus", scan);

	return {
		files(request) {
			const name = request.path.split("/")[0] ?? "";
			const all = [...helpers.values()];
			if (request.op === "list" && name === "") return Promise.resolve(all.flatMap((helper) => helper.folders.map((folder) => `${folder}/`)));
			const helper = all.find((item) => item.folders.includes(name));
			if (!helper) return Promise.reject(new Error(`No shared folder is named "${name}".`));
			return ask(helper.socket, (id) => ({ kind: "files", id, request }));
		},
		async changeFolders(change) {
			const helper = keeper();
			if (!helper) throw new Error("The local helper is not running. Run pnpm local:install in the FigPal repo.");
			await ask(helper.socket, (id) => ({ kind: "folders", id, change }));
		},
		stop() {
			clearInterval(timer);
			removeEventListener("focus", scan);
			for (const socket of sockets) socket.close();
		},
	};
}
