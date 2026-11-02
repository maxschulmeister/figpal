// The local helper (local/cli.ts) runs on the user's machine. FigPal's UI connects to it with a WebSocket: the helper
// gives FigPal's agent the files of some folders, and gives outside agents (MCP) the requests of code.js.

import { type Attachment, isRecord, UI_ORIGINS } from "./protocol.ts";

/** The helper takes the first free port, and the UI tries all. figma-console-mcp's bridge uses 9223 to 9232. */
export const LOCAL_PORTS = Array.from({ length: 10 }, (_, index) => 9300 + index);

/** The UI origins that the helper accepts. A web page can connect to localhost, but it cannot fake its origin. */
export const LOCAL_ORIGINS: readonly string[] = Object.values(UI_ORIGINS);

/** The requests of code.js that an outside agent can send through FigPal, when the user allows it. */
export const AGENT_REQUESTS = ["execute", "screenshot"] as const;
export type AgentRequest = (typeof AGENT_REQUESTS)[number];

/** A path starts with the name of a folder: "project/src/app.tsx". */
export type FileRequest = { op: "list"; path: string } | { op: "read"; path: string } | { op: "write"; path: string; content: string };

/** Bytes as base64: JSON has no bytes. */
export type WireAttachment = Omit<Attachment, "bytes"> & { data: string };

type Response<T> = { kind: "response"; id: string } & ({ ok: true } & T | { ok: false; error: string });

/** A change of the shared folders. The helper opens the folder picker for "add": FigPal cannot name a path. */
export type FolderChange = { op: "add" } | { op: "remove"; name: string } | { op: "home"; on: boolean };

export type HelperToUi =
	/**
	 * After the connection and after each change of the folders: the names of the shared folders; whether an outside
	 * agent uses this helper; whether it keeps the folders (the helper that starts at login); whether the home folder is
	 * shared.
	 */
	| { kind: "hello"; folders: string[]; agent: boolean; manage: boolean; home: boolean }
	/** A request of an outside agent. */
	| { kind: "request"; id: string; type: AgentRequest; params: Record<string, unknown> }
	/** The answer to a file request. */
	| Response<{ result: unknown }>;

export type UiToHelper =
	| { kind: "files"; id: string; request: FileRequest }
	| { kind: "folders"; id: string; change: FolderChange }
	/** The name of the file of this window: an outside agent can choose the file. */
	| { kind: "window"; file: string }
	/** The answer to a request of an outside agent. */
	| Response<{ result: unknown; attachments: WireAttachment[] }>;

function isResponse(value: Record<string, unknown>): boolean {
	return value.kind === "response" && typeof value.id === "string" && (value.ok === true || (value.ok === false && typeof value.error === "string"));
}

/** Checks a message from the helper. The UI calls it before it trusts the message. */
export function isHelperToUi(value: unknown): value is HelperToUi {
	if (!isRecord(value)) return false;
	if (value.kind === "hello")
		return (
			Array.isArray(value.folders) &&
			value.folders.every((name) => typeof name === "string") &&
			typeof value.agent === "boolean" &&
			typeof value.manage === "boolean" &&
			typeof value.home === "boolean"
		);
	if (value.kind === "request")
		return typeof value.id === "string" && AGENT_REQUESTS.includes(value.type as AgentRequest) && isRecord(value.params);
	return isResponse(value);
}

/** Checks a message from the UI. The helper calls it before it trusts the message. */
export function isUiToHelper(value: unknown): value is UiToHelper {
	if (!isRecord(value)) return false;
	if (value.kind === "files") {
		const request = value.request;
		if (typeof value.id !== "string" || !isRecord(request) || typeof request.path !== "string") return false;
		return request.op === "list" || request.op === "read" || (request.op === "write" && typeof request.content === "string");
	}
	if (value.kind === "folders") {
		const change = value.change;
		if (typeof value.id !== "string" || !isRecord(change)) return false;
		return change.op === "add" || (change.op === "remove" && typeof change.name === "string") || (change.op === "home" && typeof change.on === "boolean");
	}
	if (value.kind === "window") return typeof value.file === "string";
	if (!isResponse(value)) return false;
	return value.ok === false || (Array.isArray(value.attachments) && value.attachments.every(isWireAttachment));
}

const isWireAttachment = (value: unknown) =>
	isRecord(value) && typeof value.name === "string" && typeof value.mime === "string" && typeof value.data === "string";
