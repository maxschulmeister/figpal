// Plugin main thread. Shows the UI (remote or local) and runs its requests against the Plugin API.

import {
	type Attachment,
	EXECUTE_TIMEOUT_MS,
	type ExportFormat,
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
import { lintDesign } from "./vendor/figma-console-mcp/checks.js";

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

const EXPORT_MIME: Record<ExportFormat, string> = { SVG: "image/svg+xml", PDF: "application/pdf", PNG: "image/png", JPG: "image/jpeg" };

function summarize(node: BaseNode): NodeSummary {
	return { id: node.id, name: node.name, type: node.type };
}

/** The first nodes of the selection, and the count of all. */
function selection(nodes = figma.currentPage.selection): Pick<FileInfo, "selection" | "selectionCount"> {
	return { selection: nodes.slice(0, MAX_SELECTION).map(summarize), selectionCount: nodes.length };
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
		page: summarize(figma.currentPage),
		...selection(),
	};
}

/** A page has no size. Its image shows its content. */
async function contentSize(page: PageNode): Promise<{ width: number; height: number }> {
	await page.loadAsync();
	const boxes = page.children.flatMap((child) => child.absoluteBoundingBox ?? []);
	if (!boxes.length) throw new Error(`The page ${page.name} is empty`);
	const left = Math.min(...boxes.map((box) => box.x));
	const top = Math.min(...boxes.map((box) => box.y));
	return {
		width: Math.max(...boxes.map((box) => box.x + box.width)) - left,
		height: Math.max(...boxes.map((box) => box.y + box.height)) - top,
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

const selectionKey = (nodes = figma.currentPage.selection) => nodes.map((node) => node.id).join(",");
/**
 * Figma does not tell who changed the selection, and a plugin cannot watch the setter: the accessor on the page
 * prototype cannot be redefined, and pages are not extensible (Figma test 2026-11-01). So a selection change while
 * figma_execute code runs counts as the code's. A click by the user in that time adds no chip.
 */
let executing = false;
/** The selection that the last code left. Figma can report it after the code ends, and more than one time. */
let agentSelection: string | undefined;

function codeEnded() {
	executing = false;
	agentSelection = selectionKey();
}

const handlers: Handlers = {
	async execute({ code, timeoutMs }) {
		executing = true;
		try {
			const { attachments, ...result } = await execute(code, { figma, timeoutMs });
			codeEnded();
			return { result, attachments };
		} catch (error) {
			if (!(error instanceof ExecuteTimeout)) codeEnded();
			// The code still runs, and its selections are the code's until it ends.
			else {
				const done = () => {
					lateRun = undefined;
					codeEnded();
				};
				lateRun = error.running.then(done, done);
			}
			throw error;
		}
	},

	async screenshot({ nodeId, scale }) {
		const node = nodeId ? await figma.getNodeByIdAsync(nodeId) : (figma.currentPage.selection[0] ?? figma.currentPage);
		if (!node) throw new Error(`No node with ID ${nodeId}`);
		if (!("exportAsync" in node)) throw new Error(`Cannot export a ${node.type} node`);
		const size = node.type === "PAGE" ? await contentSize(node) : node;
		const value = Math.min(scale ?? 1, SCREENSHOT_MAX_PX / Math.max(size.width, size.height, 1));
		const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value } });
		return {
			result: { nodeId: node.id, width: Math.round(size.width * value), height: Math.round(size.height * value) },
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

	async variables() {
		const [collections, variables] = await Promise.all([
			figma.variables.getLocalVariableCollectionsAsync(),
			figma.variables.getLocalVariablesAsync(),
		]);
		return {
			result: {
				collections: collections.map((c) => ({
					id: c.id,
					name: c.name,
					modes: c.modes,
					isExtension: c.isExtension === true,
				})),
				variables: variables.map((v) => ({
					id: v.id,
					name: v.name,
					resolvedType: v.resolvedType,
					valuesByMode: v.valuesByMode,
					variableCollectionId: v.variableCollectionId,
					scopes: v.scopes,
					codeSyntax: v.codeSyntax,
					description: v.description,
				})),
			},
		};
	},

	async components() {
		await figma.loadAllPagesAsync();
		// Main components are never inside instances. Figma says that skipping them makes the search much faster. The
		// search is synchronous, so no other code sees the flag.
		const skip = figma.skipInvisibleInstanceChildren;
		figma.skipInvisibleInstanceChildren = true;
		let found: (ComponentNode | ComponentSetNode)[];
		try {
			found = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
		} finally {
			figma.skipInvisibleInstanceChildren = skip;
		}
		/** The type of each property. Figma throws for a component with errors, as upstream knows: then none. */
		const types = (component: ComponentNode) => {
			try {
				return Object.fromEntries(Object.entries(component.componentPropertyDefinitions).map(([name, { type }]) => [name, { type }]));
			} catch {
				return {};
			}
		};
		const styles = await Promise.all([
			figma.getLocalPaintStylesAsync(),
			figma.getLocalTextStylesAsync(),
			figma.getLocalEffectStylesAsync(),
			figma.getLocalGridStylesAsync(),
		]);
		return {
			result: {
				fileName: figma.root.name,
				componentSets: found
					.filter((node) => node.type === "COMPONENT_SET")
					// No property definitions: the audit does not read them, and Figma throws for a set with errors.
					.map((set) => ({ id: set.id, name: set.name, description: set.description })),
				components: found
					.filter((node) => node.type === "COMPONENT")
					.map((component) => {
						const base = { id: component.id, name: component.name, description: component.description };
						// Figma throws when code reads the property definitions of a variant.
						return component.parent?.type === "COMPONENT_SET"
							? { ...base, componentSetId: component.parent.id }
							: { ...base, componentSetId: null, componentPropertyDefinitions: types(component) };
					}),
				styles: styles.flat().map((style) => ({ name: style.name, type: style.type })),
			},
		};
	},

	async lint({ nodeId, rules, maxFindings }) {
		// Outside figma_execute, so with the same time limit: the other requests wait for the lint.
		return { result: await lintDesign({ nodeId, rules, maxFindings, timeLimitMs: EXECUTE_TIMEOUT_MS.default }) };
	},

	async select({ nodeIds }) {
		const found = await Promise.all(nodeIds.map((id) => figma.getNodeByIdAsync(id)));
		const pageOf = (node: BaseNode) => {
			let parent = node.parent;
			while (parent && parent.type !== "PAGE") parent = parent.parent;
			return parent as PageNode | null;
		};
		const layers = found.filter((node): node is SceneNode => node !== null && node.type !== "PAGE" && node.type !== "DOCUMENT");
		// A selection cannot have layers of two pages: the current page if it has one of them, else the first page.
		const pages = layers.map(pageOf);
		const page = pages.find((item) => item?.id === figma.currentPage.id) ?? pages.find((item) => item !== null);
		if (!page) throw new Error("These layers no longer exist.");
		const selection = layers.filter((layer) => pageOf(layer)?.id === page.id);
		if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
		page.selection = selection;
		figma.viewport.scrollAndZoomIntoView(selection);
		return { result: { count: selection.length } };
	},

	async export({ nodeIds, format, scale }) {
		const attachments: Attachment[] = [];
		for (const id of nodeIds) {
			const node = await figma.getNodeByIdAsync(id);
			// The chat shows this error when a Download makes the files again.
			if (!node) throw new Error(`The layer with ID ${id} no longer exists.`);
			if (!("exportAsync" in node)) throw new Error(`Cannot export a ${node.type} node`);
			// SVG and PDF are vector files: no scale.
			const settings: ExportSettings =
				format === "SVG" || format === "PDF" ? { format } : { format, constraint: { type: "SCALE", value: scale ?? 1 } };
			const bytes = await node.exportAsync(settings);
			// A download has no folders: "Icons/Arrow" becomes "Icons-Arrow".
			attachments.push({ name: `${node.name.replaceAll("/", "-")}.${format.toLowerCase()}`, mime: EXPORT_MIME[format], bytes });
		}
		return { result: { count: attachments.length }, attachments };
	},

	async "open-external"({ url }) {
		if (!/^https:\/\//.test(url)) throw new Error("Only https URLs can open");
		figma.openExternal(url);
		return { result: null };
	},
};

/** Calls that change or read the canvas run one at a time. */
const QUEUED = new Set<RequestType>(["execute", "screenshot", "export", "components", "lint", "select"]);
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
	const nodes = figma.currentPage.selection;
	const byAgent = executing || selectionKey(nodes) === agentSelection;
	// A different selection is the user's, and so is any later one.
	if (!byAgent) agentSelection = undefined;
	post({ kind: "event", type: "selection", ...selection(nodes), page: summarize(figma.currentPage), byAgent });
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
