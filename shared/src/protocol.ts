// Message protocol between the hosted UI (iframe) and the plugin main thread (code.js).

export const PLUGIN_ID = "figpal";
export const FIGMA_ORIGIN = "https://www.figma.com";
/** The UI can only read and write clientStorage keys with this prefix. */
export const STORAGE_PREFIX = "figpal.";

export type NodeSummary = { id: string; name: string; type: string };

export type FileInfo = {
	/** `figma.fileKey` if the plugin can read it, else a UUID kept in the document. */
	fileId: string;
	fileKey: string | null;
	fileName: string;
	editorType: string;
	page: NodeSummary;
	selection: NodeSummary[];
};

export type Attachment = { name: string; mime: string; bytes: Uint8Array };

/** Requests from the UI and the result that each one returns. */
export type Requests = {
	execute: { params: { code: string; timeoutMs?: number }; result: { value: string; truncated: boolean } };
	screenshot: { params: { nodeId?: string; scale?: number }; result: { nodeId: string; width: number; height: number } };
	"storage-get": { params: { key: string }; result: unknown };
	"storage-set": { params: { key: string; value: unknown }; result: null };
	"storage-delete": { params: { key: string }; result: null };
	"create-image": { params: { url?: string; bytes?: Uint8Array }; result: { nodeId: string } };
	hide: { params: { ms: number }; result: null };
	"open-external": { params: { url: string }; result: null };
};
export type RequestType = keyof Requests;
export type Params<T extends RequestType> = Requests[T]["params"];
export type Result<T extends RequestType> = Requests[T]["result"];

export type RequestMessage<T extends RequestType = RequestType> = {
	kind: "request";
	id: string;
	type: T;
	params: Params<T>;
};

export type ResponseMessage =
	| { kind: "response"; id: string; ok: true; result: unknown; attachments: Attachment[] }
	| { kind: "response"; id: string; ok: false; error: string };

export type EventMessage =
	| { kind: "event"; type: "init"; file: FileInfo }
	| { kind: "event"; type: "selection"; selection: NodeSummary[] }
	| { kind: "event"; type: "page"; page: NodeSummary };

/** `ready` tells code.js that the UI loaded. `retry` comes from the offline page. */
export type UiToPlugin = { kind: "ready" } | { kind: "retry" } | RequestMessage;
export type PluginToUi = ResponseMessage | EventMessage;

const REQUEST_TYPES: Record<RequestType, true> = {
	execute: true,
	screenshot: true,
	"storage-get": true,
	"storage-set": true,
	"storage-delete": true,
	"create-image": true,
	hide: true,
	"open-external": true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Checks the shape of a message from the UI. code.js calls it before it trusts the message. */
export function isUiToPlugin(value: unknown): value is UiToPlugin {
	if (!isRecord(value)) return false;
	if (value.kind === "ready" || value.kind === "retry") return true;
	return (
		value.kind === "request" &&
		typeof value.id === "string" &&
		typeof value.type === "string" &&
		Object.prototype.hasOwnProperty.call(REQUEST_TYPES, value.type) &&
		isRecord(value.params)
	);
}

/** Checks the shape of a message from code.js. The UI calls it before it trusts the message. */
export function isPluginToUi(value: unknown): value is PluginToUi {
	if (!isRecord(value)) return false;
	if (value.kind === "response") return typeof value.id === "string" && typeof value.ok === "boolean";
	return value.kind === "event" && typeof value.type === "string";
}
