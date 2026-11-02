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

/** The image types that models read. Other files go to the user, or to an outside agent as resources. */
export const MODEL_IMAGES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** IDs in Figma links have dashes: "1-2" is the node "1:2". Real node IDs have no dashes. */
export const nodeIdOf = (id: string) => id.replaceAll("-", ":");

/** Limits that code.js applies. The tool descriptions tell the model. */
export const EXECUTE_TIMEOUT_MS = { default: 30_000, max: 300_000 } as const;
export const EXECUTE_OUTPUT_LIMIT = 20_000;
/** The longest side of an image for the model: Claude rejects larger images in requests with more than 20 images. */
export const MODEL_IMAGE_MAX_PX = 2000;

/** code.js gives the UI Figma's theme class (`figma-light` or `figma-dark`) in this URL hash parameter. */
export const THEME_HASH_KEY = "figma-theme";

export type NodeSummary = { id: string; name: string; type: string };

export type FileInfo = {
	/** `figma.fileKey` if the plugin can read it, else a UUID kept in the document. */
	fileId: string;
	/** The key of the file in Figma URLs and in the REST API. Null if the plugin cannot read it. */
	fileKey: string | null;
	fileName: string;
	page: NodeSummary;
	/** The first 50 nodes of the selection. */
	selection: NodeSummary[];
	/** The count of all selected nodes. */
	selectionCount: number;
};

export type Attachment = { name: string; mime: string; bytes: Uint8Array };

/** The local variables of the file, in the shape that the token converter of figma-console-mcp reads. */
export type Variables = {
	collections: {
		id: string;
		name: string;
		/** The first mode is the default. */
		modes: { modeId: string; name: string }[];
		/** An extended collection keeps only its changes to another collection. */
		isExtension: boolean;
	}[];
	variables: {
		id: string;
		name: string;
		resolvedType: string;
		valuesByMode: Record<string, unknown>;
		variableCollectionId: string;
		scopes: string[];
		codeSyntax: Record<string, string>;
		description: string;
	}[];
};

/** The local components and styles of all pages, in the shape that the design-system audit of figma-console-mcp reads. */
export type Components = {
	fileName: string;
	componentSets: { id: string; name: string; description: string }[];
	/** A variant has the ID of its set. Figma has no property definitions for a variant. The audit counts the properties. */
	components: {
		id: string;
		name: string;
		description: string;
		componentSetId: string | null;
		componentPropertyDefinitions?: Record<string, { type: string }>;
	}[];
	styles: { name: string; type: string }[];
};

/** The findings of the lint (the checks of figma-console-mcp), by rule. Each finding has the layer and details. */
export type LintResult = {
	rootNodeId: string;
	rootNodeName: string;
	nodesScanned: number;
	categories: {
		rule: string;
		severity: string;
		wcagLevel: string | null;
		count: number;
		description: string;
		nodes: ({ id: string; name: string } & Record<string, unknown>)[];
	}[];
	summary: Record<string, number>;
	/** When it stopped at maxFindings. */
	warning?: string;
};

/** Requests from the UI and the result that each one returns. */
export type Requests = {
	execute: { params: { code: string; timeoutMs?: number }; result: { value: string } };
	screenshot: { params: { nodeId?: string; scale?: number }; result: { nodeId: string; width: number; height: number } };
	"storage-get": { params: { key: string }; result: unknown };
	"storage-set": { params: { key: string; value: unknown }; result: null };
	"storage-delete": { params: { key: string }; result: null };
	"open-external": { params: { url: string }; result: null };
	/** Read-only, so the UI can export tokens again without the agent. */
	variables: { params: Record<string, never>; result: Variables };
	/** Read-only. For the design-system audit. */
	components: { params: Record<string, never>; result: Components };
	/** Read-only. Without nodeId: the current page. */
	lint: { params: { nodeId?: string; rules?: string[]; maxFindings?: number }; result: LintResult };
	/**
	 * Hides the panel; the agent goes on. A notice with the message and a Show button stays until the panel shows.
	 * `update`: only change the notice, if the panel is still hidden.
	 */
	background: { params: { message: string; update?: boolean }; result: null };
	/** Resizes the panel, within the canvas, and saves the size. Gives the size that it set. */
	resize: { params: { width: number; height: number }; result: { width: number; height: number } };
	/** Selects the layers of the first page that has one of them, and zooms to them. */
	select: { params: { nodeIds: string[] }; result: { count: number } };
	/**
	 * Read-only, so the UI can export the nodes again without the agent. The files are the attachments. A video has the
	 * animation of the top-level frame of the node. `width` replaces `scale`; `fps` and `quality` are for videos.
	 */
	export: {
		params: { nodeIds: string[]; format: ExportFormat; scale?: number; width?: number; fps?: number; quality?: VideoQuality };
		result: { count: number };
	};
};

export const VIDEO_FORMATS = ["MP4", "WEBM", "GIF"] as const;
export const EXPORT_FORMATS = ["SVG", "PDF", "PNG", "JPG", ...VIDEO_FORMATS] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type VideoQuality = "LOW" | "MEDIUM" | "HIGH";
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
	/** `byAgent`: figma_execute code made the selection. */
	| ({ kind: "event"; type: "selection"; page: NodeSummary; byAgent: boolean } & Pick<FileInfo, "selection" | "selectionCount">)
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
	"open-external": true,
	variables: true,
	components: true,
	lint: true,
	select: true,
	export: true,
	resize: true,
	background: true,
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Checks the shape of a message from the UI. code.js calls it before it trusts the message. */
export function isUiToPlugin(value: unknown): value is UiToPlugin {
	if (!isRecord(value)) return false;
	if (value.kind === "ready" || value.kind === "retry") return true;
	if (value.kind === "switch-ui") return typeof value.ui === "string" && Object.keys(UI_ORIGINS).includes(value.ui);
	return (
		value.kind === "request" &&
		typeof value.id === "string" &&
		typeof value.type === "string" &&
		Object.keys(REQUEST_TYPES).includes(value.type) &&
		isRecord(value.params)
	);
}

/** Checks the shape of a message from code.js. The UI calls it before it trusts the message. */
export function isPluginToUi(value: unknown): value is PluginToUi {
	if (!isRecord(value)) return false;
	if (value.kind === "response") return typeof value.id === "string" && typeof value.ok === "boolean";
	if (value.kind !== "event" || typeof value.type !== "string") return false;
	// The chips need these fields. An older code.js does not send them.
	if (value.type === "selection")
		return (
			Array.isArray(value.selection) &&
			typeof value.selectionCount === "number" &&
			isRecord(value.page) &&
			typeof value.byAgent === "boolean"
		);
	return true;
}
