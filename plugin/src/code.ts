// Plugin main thread. Shows the UI (remote or local) and runs its requests against the Plugin API.

import {
	type Attachment,
	type FileInfo,
	isUiToPlugin,
	SCREENSHOT_MAX_PX,
	type NodeSummary,
	type Params,
	type PluginToUi,
	type RequestMessage,
	type RequestType,
	type Result,
	STORAGE_PREFIX,
	THEME_HASH_KEY,
	UI_ORIGINS,
	type UiSource,
	type UiToPlugin,
} from "@figpal/shared";
import { ExecuteTimeout, execute } from "./execute";

const UI_OPTIONS: ShowUIOptions = { width: 420, height: 680, themeColors: true };
const LOAD_TIMEOUT_MS = 10_000;
const UI_KEY = "figpal.ui";
const FILE_ID_KEY = "figpal.fileId";
const MAX_SELECTION = 50;

/** A setting in clientStorage. Only the origin of this UI can send requests, and only it gets the replies. */
let source: UiSource = "remote";
const uiOrigin = () => UI_ORIGINS[source];
const uiUrl = () => `${uiOrigin()}/`;
const uiOptions = (): ShowUIOptions => ({ ...UI_OPTIONS, title: `FigPal (${source})` });

let loadTimer = 0;

function offlineHtml(): string {
	const other: UiSource = source === "remote" ? "local" : "remote";
	const hint = source === "remote" ? "Connect Tailscale" : "Start the dev server (pnpm dev)";
	// JSON has no single quotes, so the attributes use them.
	const send = (message: UiToPlugin) => `parent.postMessage({ pluginMessage: ${JSON.stringify(message)} }, "*")`;
	return `<!doctype html>
<style>
body { font: 12px/1.5 Inter, system-ui, sans-serif; margin: 16px; color: var(--figma-color-text); background: var(--figma-color-bg); }
button { font: inherit; padding: 6px 12px; }
</style>
<p>Cannot reach FigPal at ${uiUrl()}. ${hint} and try again.</p>
<button onclick='${send({ kind: "retry" })}'>Try again</button>
<button onclick='${send({ kind: "switch-ui", ui: other })}'>Use the ${other} UI</button>`;
}

/**
 * Figma adds the theme class (`figma-dark` or `figma-light`) to this first document after it starts. The UI page
 * does not get it, so wait for the class (at most 500 ms) and give it to the page in the URL hash.
 */
function bootstrapHtml(): string {
	return `<script>
let done = false;
const go = () => {
	if (done) return;
	done = true;
	location.href = ${JSON.stringify(`${uiUrl()}#${THEME_HASH_KEY}=`)} + encodeURIComponent(document.documentElement.className);
};
if (document.documentElement.className) go();
new MutationObserver(go).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
setTimeout(go, 500);
</script>`;
}

function showUi(): void {
	figma.showUI(bootstrapHtml(), uiOptions());
	clearTimeout(loadTimer);
	loadTimer = setTimeout(() => figma.showUI(offlineHtml(), uiOptions()), LOAD_TIMEOUT_MS);
}

async function switchUi(next: UiSource): Promise<void> {
	source = next;
	// First the UI: if the setting cannot be saved, only the next start uses the old UI.
	showUi();
	await figma.clientStorage.setAsync(UI_KEY, next);
}

function post(message: PluginToUi): void {
	figma.ui.postMessage(message, { origin: uiOrigin() });
}

function summarize(node: BaseNode): NodeSummary {
	return { id: node.id, name: node.name, type: node.type };
}

function selection(): NodeSummary[] {
	return figma.currentPage.selection.slice(0, MAX_SELECTION).map(summarize);
}

function readFileKey(): string | null {
	// Only private plugins with `enablePrivatePluginApi` can read it. Other plugins can get an error.
	try {
		return figma.fileKey ?? null;
	} catch {
		return null;
	}
}

function uuid(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
	});
}

function fileInfo(): FileInfo {
	let fileId = readFileKey() ?? figma.root.getPluginData(FILE_ID_KEY);
	if (!fileId) {
		fileId = uuid();
		figma.root.setPluginData(FILE_ID_KEY, fileId);
	}
	return {
		fileId,
		fileName: figma.root.name,
		page: summarize(figma.currentPage),
		selection: selection(),
	};
}

function storageKey(key: string): string {
	if (!key.startsWith(STORAGE_PREFIX)) throw new Error(`Storage keys must start with "${STORAGE_PREFIX}"`);
	return key;
}

type Handled<T extends RequestType> = { result: Result<T>; attachments?: Attachment[] };
type Handlers = { [T in RequestType]: (params: Params<T>) => Promise<Handled<T>> };

/** An execute call that timed out but still runs. Canvas calls fail until it ends. */
let lateRun: Promise<void> | undefined;

const handlers: Handlers = {
	async execute({ code, timeoutMs }) {
		try {
			const { attachments, ...result } = await execute(code, { figma, timeoutMs });
			return { result, attachments };
		} catch (error) {
			if (error instanceof ExecuteTimeout) {
				const done = () => {
					lateRun = undefined;
				};
				lateRun = error.running.then(done, done);
			}
			throw error;
		}
	},

	async screenshot({ nodeId, scale }) {
		const node = nodeId ? await figma.getNodeByIdAsync(nodeId) : figma.currentPage.selection[0];
		if (!node) throw new Error(nodeId ? `No node with ID ${nodeId}` : "Select a node or give a node ID");
		if (!("exportAsync" in node) || !("width" in node)) throw new Error(`Cannot export a ${node.type} node`);
		const largest = Math.max(node.width, node.height, 1);
		const value = Math.min(scale ?? 1, SCREENSHOT_MAX_PX / largest);
		const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value } });
		return {
			result: { nodeId: node.id, width: Math.round(node.width * value), height: Math.round(node.height * value) },
			attachments: [{ name: `${node.name}.png`, mime: "image/png", bytes }],
		};
	},

	async "storage-get"({ key }) {
		return { result: await figma.clientStorage.getAsync(storageKey(key)) };
	},

	async "storage-set"({ key, value }) {
		await figma.clientStorage.setAsync(storageKey(key), value);
		return { result: null };
	},

	async "storage-delete"({ key }) {
		await figma.clientStorage.deleteAsync(storageKey(key));
		return { result: null };
	},

	async "open-external"({ url }) {
		if (!/^https:\/\//.test(url)) throw new Error("Only https URLs can open");
		figma.openExternal(url);
		return { result: null };
	},
};

/** Calls that change or read the canvas run one at a time. */
const QUEUED = new Set<RequestType>(["execute", "screenshot"]);
let queue: Promise<unknown> = Promise.resolve();

async function handle(message: RequestMessage): Promise<void> {
	const queued = QUEUED.has(message.type);
	const run = async () => {
		if (queued && lateRun)
			throw new Error("An earlier figma_execute call timed out and still runs. Try again later, or run the plugin again.");
		return (handlers[message.type] as (params: unknown) => Promise<Handled<RequestType>>)(message.params);
	};
	let task: Promise<Handled<RequestType>>;
	if (queued) {
		task = queue.then(run);
		queue = task.catch(() => undefined);
	} else {
		task = run();
	}
	try {
		const { result, attachments = [] } = await task;
		post({ kind: "response", id: message.id, ok: true, result: result ?? null, attachments });
	} catch (error) {
		post({ kind: "response", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

figma.ui.onmessage = (message: unknown, { origin }) => {
	if (!isUiToPlugin(message)) {
		// A newer remote UI can send a request type that this code.js does not know. Without a reply, it waits forever.
		const request = message as { kind?: unknown; id?: unknown; type?: unknown } | null;
		if (origin === uiOrigin() && request?.kind === "request" && typeof request.id === "string") {
			const error = `This FigPal plugin does not know the request "${String(request.type)}". Update the plugin.`;
			post({ kind: "response", id: request.id, ok: false, error });
		}
		return;
	}
	// The offline page has a null origin. Its messages only open one of the two UIs.
	if (message.kind === "retry") {
		showUi();
		return;
	}
	if (message.kind === "switch-ui") {
		void switchUi(message.ui);
		return;
	}
	if (origin !== uiOrigin()) {
		console.warn(`FigPal ignored a message from ${origin}`);
		return;
	}
	if (message.kind === "ready") {
		clearTimeout(loadTimer);
		post({ kind: "event", type: "init", file: fileInfo() });
		return;
	}
	void handle(message);
};

figma.on("selectionchange", () => {
	post({ kind: "event", type: "selection", selection: selection() });
});

figma.on("currentpagechange", () => {
	post({ kind: "event", type: "page", page: summarize(figma.currentPage) });
});

void figma.clientStorage
	.getAsync(UI_KEY)
	.then(
		(saved: unknown) => {
			if (saved === "local") source = "local";
		},
		// Without the setting, open the remote UI.
		() => undefined,
	)
	.then(showUi);
