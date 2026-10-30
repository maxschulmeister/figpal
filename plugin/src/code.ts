// Plugin main thread. Shows the hosted UI and runs its requests against the Plugin API.

import {
	type Attachment,
	type FileInfo,
	isUiToPlugin,
	type NodeSummary,
	type Params,
	type PluginToUi,
	type RequestMessage,
	type RequestType,
	type Result,
	STORAGE_PREFIX,
} from "@figpal/shared";
import { ExecuteTimeout, execute } from "./execute";

/**
 * The menu command selects the UI: the hosted UI, or the Vite dev server.
 * Only this origin can send requests, and only it gets the replies.
 */
const UI =
	figma.command === "dev"
		? { url: "http://localhost:5173/", origin: "http://localhost:5173" }
		: { url: "https://figpal.maxschulmeister.dev/", origin: "https://figpal.maxschulmeister.dev" };

const UI_OPTIONS: ShowUIOptions = { width: 420, height: 680, themeColors: true, title: "FigPal" };
const LOAD_TIMEOUT_MS = 10_000;
const FILE_ID_KEY = "figpal.fileId";
const MAX_SCREENSHOT_PX = 2048;
const MAX_SELECTION = 50;

const OFFLINE_HTML = `<!doctype html>
<style>
body { font: 12px/1.5 Inter, system-ui, sans-serif; margin: 16px; color: var(--figma-color-text); background: var(--figma-color-bg); }
button { font: inherit; padding: 6px 12px; }
</style>
<p>Cannot reach FigPal at ${UI.url}. Connect Tailscale (or start the dev server) and try again.</p>
<button onclick="parent.postMessage({ pluginMessage: { kind: 'retry' } }, '*')">Try again</button>`;

let loadTimer = 0;

/**
 * Figma adds the theme class (`figma-dark` or `figma-light`) to this first document after it starts. The hosted
 * page does not get it, so wait for the class (at most 500 ms) and give it to the page in the URL hash.
 */
const BOOTSTRAP_HTML = `<script>
let done = false;
const go = () => {
	if (done) return;
	done = true;
	location.href = ${JSON.stringify(UI.url)} + "#figma-theme=" + encodeURIComponent(document.documentElement.className);
};
if (document.documentElement.className) go();
new MutationObserver(go).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
setTimeout(go, 500);
</script>`;

function showHostedUi(): void {
	figma.showUI(BOOTSTRAP_HTML, UI_OPTIONS);
	clearTimeout(loadTimer);
	loadTimer = setTimeout(() => figma.showUI(OFFLINE_HTML, UI_OPTIONS), LOAD_TIMEOUT_MS);
}

function post(message: PluginToUi): void {
	figma.ui.postMessage(message, { origin: UI.origin });
}

function summarize(node: BaseNode): NodeSummary {
	return { id: node.id, name: node.name, type: node.type };
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
	const fileKey = readFileKey();
	let fileId = fileKey ?? figma.root.getPluginData(FILE_ID_KEY);
	if (!fileId) {
		fileId = uuid();
		figma.root.setPluginData(FILE_ID_KEY, fileId);
	}
	return {
		fileId,
		fileKey,
		fileName: figma.root.name,
		editorType: figma.editorType,
		page: summarize(figma.currentPage),
		selection: figma.currentPage.selection.slice(0, MAX_SELECTION).map(summarize),
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
		const value = Math.min(scale ?? 1, MAX_SCREENSHOT_PX / largest);
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

	async "create-image"({ url, bytes }) {
		let image: Image;
		if (url) image = await figma.createImageAsync(url);
		else if (bytes) image = figma.createImage(bytes);
		else throw new Error("Give a URL or bytes");
		const { width, height } = await image.getSizeAsync();
		const rect = figma.createRectangle();
		rect.name = "Image";
		rect.resize(width, height);
		rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
		rect.x = figma.viewport.center.x - width / 2;
		rect.y = figma.viewport.center.y - height / 2;
		figma.currentPage.appendChild(rect);
		return { result: { nodeId: rect.id } };
	},

	async hide({ ms }) {
		figma.ui.hide();
		setTimeout(() => figma.ui.show(), ms);
		return { result: null };
	},

	async "open-external"({ url }) {
		if (!/^https:\/\//.test(url)) throw new Error("Only https URLs can open");
		figma.openExternal(url);
		return { result: null };
	},
};

/** Calls that change or read the canvas run one at a time. */
const QUEUED = new Set<RequestType>(["execute", "screenshot", "create-image"]);
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
	if (!isUiToPlugin(message)) return;
	// The offline page has a null origin. Its only message shows the hosted UI again.
	if (message.kind === "retry") {
		showHostedUi();
		return;
	}
	if (origin !== UI.origin) {
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
	post({
		kind: "event",
		type: "selection",
		selection: figma.currentPage.selection.slice(0, MAX_SELECTION).map(summarize),
	});
});

figma.on("currentpagechange", () => {
	post({ kind: "event", type: "page", page: summarize(figma.currentPage) });
});

showHostedUi();
