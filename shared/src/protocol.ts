// Message protocol between the hosted UI (iframe) and the plugin main thread (code.js).

export const PLUGIN_ID = "figpal";
export const FIGMA_ORIGIN = "https://www.figma.com";
/** The UI can only read and write clientStorage keys with this prefix. */
export const STORAGE_PREFIX = "figpal.";

/** Where the UI comes from: the VPS (remote) or the Vite dev server on this Mac (local). */
export const UI_ORIGINS = {
	remote: "https://figpal.maxschulmeister.dev",
	local: "http://localhost:5173",
} as const;
export type UiSource = keyof typeof UI_ORIGINS;

/** Limits of `figma_execute`: code.js applies them, and the tool description tells the model. */
export const EXECUTE_TIMEOUT_MS = { default: 30_000, max: 300_000 } as const;

/** code.js gives the UI Figma's theme class (`figma-light` or `figma-dark`) in this URL hash parameter. */
export const THEME_HASH_KEY = "figma-theme";

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

/**
 * `ready` tells code.js that the UI loaded. `retry` comes from the offline page. `switch-ui` saves the UI source
 * and opens that UI.
 */
export type UiToPlugin = { kind: "ready" } | { kind: "retry" } | { kind: "switch-ui"; ui: UiSource } | RequestMessage;
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
	if (value.kind === "switch-ui") return typeof value.ui === "string" && Object.prototype.hasOwnProperty.call(UI_ORIGINS, value.ui);
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
