// Plugin main thread. Shows the UI (from the FigPal command on this Mac) and runs its requests against the Plugin API.

import {
	type Attachment,
	EXECUTE_TIMEOUT_MS,
	type ExportFormat,
	type FileInfo,
	INSTALL_COMMAND,
	isUiToPlugin,
	VIDEO_FORMATS,
	MODEL_IMAGE_MAX_PX,
	type NodeSummary,
	type Params,
	type PluginToUi,
	type RequestMessage,
	type RequestType,
	type Result,
	MAX_RULES,
	STORAGE_PREFIX,
	THEME_HASH_KEY,
	UI_ORIGIN,
	type UiToPlugin,
} from "@figpal/shared";
import { ExecuteTimeout, execute } from "./execute";
import { lintDesign } from "./vendor/figma-console-mcp/checks";

const UI_OPTIONS: ShowUIOptions = { themeColors: true };
const DEFAULT_WIDTH = 420;
const MIN_SIZE = { width: 320, height: 400 };
/** The title bar of the panel and a gap: the panel fits in the visible canvas. */
const CANVAS_MARGIN = 64;
const SIZE_KEY = "figpal.size";
const LOAD_TIMEOUT_MS = 10_000;
const FILE_ID_KEY = "figpal.fileId";
const RULES_KEY = "figpal.rules";
// The UI saves the rules for this file at each key. They go into the file after a short wait, or when FigPal closes, so
// that typing does not change the file at each key.
const RULES_DELAY_MS = 500;
let unsavedRules: string | undefined;
let rulesTimer = 0;
function writeRules(): void {
	clearTimeout(rulesTimer);
	if (unsavedRules === undefined) return;
	figma.root.setPluginData(RULES_KEY, unsavedRules);
	unsavedRules = undefined;
}
const MAX_SELECTION = 50;

/** Only the origin of the UI can send requests, and only it gets the replies. */
const UI_URL = `${UI_ORIGIN}/`;
/** The size of the panel: the saved size, or the full height. */
let size: { width: number; height: number } | undefined;
const uiOptions = (): ShowUIOptions => ({ ...UI_OPTIONS, ...fit(size), title: "FigPal" });

/**
 * The size within the visible canvas, which is as large as the panel can be: code.js cannot read the size of the
 * Figma window. Without a size: the default width and the full height.
 */
function fit(wanted?: { width: number; height: number }): { width: number; height: number } {
	const { bounds, zoom } = figma.viewport;
	// The canvas can read too small, for example while the file loads: it never makes the panel smaller than the
	// default width and the minimum height (the panel opened very narrow once).
	const max = {
		width: Math.max(DEFAULT_WIDTH, Math.round(bounds.width * zoom) - CANVAS_MARGIN),
		height: Math.max(MIN_SIZE.height, Math.round(bounds.height * zoom) - CANVAS_MARGIN),
	};
	const clamp = (value: number, key: "width" | "height") => Math.round(Math.max(MIN_SIZE[key], Math.min(max[key], value)));
	return { width: clamp(wanted?.width ?? DEFAULT_WIDTH, "width"), height: clamp(wanted?.height ?? max.height, "height") };
}

const isSize = (value: unknown): value is { width: number; height: number } =>
	typeof value === "object" &&
	value !== null &&
	Number.isFinite((value as { width?: unknown }).width) &&
	Number.isFinite((value as { height?: unknown }).height);

let saveTimer = 0;

/** The notice while the panel is hidden. */
let notice: NotificationHandler | undefined;

/**
 * The figma object of the agent's code. A new notice ends FigPal's notice with "dismiss", as its close button does, and
 * FigPal closed (user report). While the panel is hidden, the agent's notices do not show. figma is frozen, so the Proxy
 * has an empty target; Figma's methods work with the Proxy as `this` (measured).
 */
const agentFigma = new Proxy({} as PluginAPI, {
	get: (_, key) => (key === "notify" && notice ? () => ({ cancel() {} }) : Reflect.get(figma, key)),
	set: (_, key, value) => Reflect.set(figma, key, value),
	has: (_, key) => key in figma,
});

/** Shows the hidden panel and ends its notice. */
function showPanel(): void {
	const previous = notice;
	notice = undefined;
	previous?.cancel();
	figma.ui.show();
}

let loadTimer = 0;

/** The pages of code.js have Figma's theme colors (`themeColors`), not the UI's styles. */
const PAGE_STYLE = `<style>
body { font: 12px/1.5 Inter, system-ui, sans-serif; margin: 16px; color: var(--figma-color-text); background: var(--figma-color-bg); }
button { font: inherit; height: 24px; padding: 0 8px; border: 1px solid var(--figma-color-border); border-radius: 5px; color: var(--figma-color-text); background: var(--figma-color-bg); }
code { display: block; margin: 8px 0; padding: 4px 8px; border-radius: 5px; background: var(--figma-color-bg-secondary); user-select: all; }
[hidden] { display: none; }
</style>`;

/** JSON has no single quotes, so the attributes use them. */
const send = (message: UiToPlugin) => `parent.postMessage({ pluginMessage: ${JSON.stringify(message)} }, "*")`;

function offlineHtml(): string {
	return `<!doctype html>
${PAGE_STYLE}
<p>FigPal did not start.</p>
<button onclick='${send({ kind: "retry" })}'>Try again</button>`;
}

/**
 * The first document. It goes to the UI when the FigPal command answers, and until then says how to start it, and asks
 * again every 2 seconds. A refused connection fails at once.
 *
 * Figma adds the theme class (`figma-dark` or `figma-light`) to this document after it starts. The UI page does not
 * get it, so wait for the class (at most 500 ms) and give it to the page in the URL hash.
 */
function bootstrapHtml(): string {
	return `<!doctype html>
${PAGE_STYLE}
<div id="off" hidden>
<p><strong>FigPal is not running.</strong> Run this command in Terminal. Then FigPal opens.</p>
<code id="command">${INSTALL_COMMAND}</code>
<button id="copy">Copy</button>
</div>
<script>
const root = document.documentElement;
const theme = new Promise((resolve) => {
	if (root.className) return resolve();
	new MutationObserver(() => resolve()).observe(root, { attributes: true, attributeFilter: ["class"] });
	setTimeout(resolve, 500);
});
// A program on the port that does not answer counts as not running.
const running = () =>
	fetch(${JSON.stringify(`${UI_ORIGIN}/health`)}, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const copy = document.getElementById("copy");
copy.onclick = () => {
	const command = document.getElementById("command");
	// The plugin window can block the clipboard API, or not have it: the older way works there. If both fail, the
	// command stays selected for Cmd+C.
	Promise.resolve()
		.then(() => navigator.clipboard.writeText(command.textContent))
		.catch(() => {
			getSelection().selectAllChildren(command);
			if (!document.execCommand("copy")) throw new Error("Not copied");
		})
		.then(() => (copy.textContent = "Copied"), () => (copy.textContent = "Press Cmd+C"));
};
(async () => {
	await theme;
	while (!(await running())) {
		document.getElementById("off").hidden = false;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	${send({ kind: "loading" })};
	location.href = ${JSON.stringify(`${UI_URL}#${THEME_HASH_KEY}=`)} + encodeURIComponent(root.className);
})();
</script>`;
}

function showUi(): void {
	clearTimeout(loadTimer);
	figma.showUI(bootstrapHtml(), uiOptions());
}

function post(message: PluginToUi): void {
	figma.ui.postMessage(message, { origin: UI_ORIGIN });
}

/** The scales of Figma's export panel: the only scales for a video. */
const VIDEO_SCALES = [0.5, 0.75, 1, 1.5, 2, 3, 4];

const EXPORT_MIME: Record<ExportFormat, string> = {
	SVG: "image/svg+xml",
	PDF: "application/pdf",
	PNG: "image/png",
	JPG: "image/jpeg",
	MP4: "video/mp4",
	WEBM: "video/webm",
	GIF: "image/gif",
};

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
			const { attachments, ...result } = await execute(code, { figma: agentFigma, timeoutMs });
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
		const value = Math.min(scale ?? 1, MODEL_IMAGE_MAX_PX / Math.max(size.width, size.height, 1));
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

	// In the file, not in clientStorage: everyone who runs FigPal on the file gets them.
	async rules({ text }) {
		if (text !== undefined) {
			if (typeof text !== "string" || text.length > MAX_RULES) throw new Error(`Rules must be text of at most ${MAX_RULES} characters.`);
			unsavedRules = text;
			clearTimeout(rulesTimer);
			rulesTimer = setTimeout(writeRules, RULES_DELAY_MS);
		}
		return { result: unsavedRules ?? figma.root.getPluginData(RULES_KEY) };
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

	async export({ nodeIds, format, scale, width, fps, quality }) {
		const attachments: Attachment[] = [];
		const video = (VIDEO_FORMATS as readonly ExportFormat[]).includes(format);
		if (video && !width && !VIDEO_SCALES.includes(scale ?? 1)) throw new Error(`Videos take the scales ${VIDEO_SCALES.join(", ").replace(/, (?=[^,]*$)/, " and ")}.`);
		const exported = new Set<string>();
		for (const id of nodeIds) {
			let node = await figma.getNodeByIdAsync(id);
			// The chat shows this error when a Download makes the files again.
			if (!node) throw new Error(`The layer with ID ${id} no longer exists.`);
			if (!("exportAsync" in node)) throw new Error(`Cannot export a ${node.type} node`);
			if (video) {
				// Figma exports the animation of a top-level frame only: one file for each frame.
				const frame = node.getTopLevelFrame();
				if (!frame) throw new Error(`The layer ${JSON.stringify(node.name)} is not in a top-level frame. Only top-level frames have animations.`);
				if (exported.has(frame.id)) continue;
				exported.add(frame.id);
				node = frame;
			}
			const constraint = width ? { type: "WIDTH" as const, value: width } : { type: "SCALE" as const, value: scale ?? 1 };
			// SVG and PDF are vector files: no size. A GIF has no quality.
			const settings =
				format === "SVG" || format === "PDF"
					? { format }
					: format === "PNG" || format === "JPG"
						? { format, constraint }
						: { format, constraint, ...(fps && { fps }), ...(quality && format !== "GIF" && { quality }) };
			// The video settings are a second overload of exportAsync, with fps as literal types: one call for all formats.
			const bytes = await node.exportAsync(settings as ExportSettings);
			// A download has no folders: "Icons/Arrow" becomes "Icons-Arrow".
			attachments.push({ name: `${node.name.replaceAll("/", "-")}.${format.toLowerCase()}`, mime: EXPORT_MIME[format], bytes });
		}
		return { result: { count: attachments.length }, attachments };
	},

	async background({ message, update }) {
		if (typeof message !== "string" || (update !== undefined && typeof update !== "boolean"))
			throw new Error("The message must be text.");
		// The user clicked Show before the run ended.
		if (update && !notice) return { result: null };
		// The old notice goes first. Figma ends a notice under a newer one without its callbacks, and closing FigPal
		// then failed with "Invalid handle". Its cancel calls onDequeue with "dismiss": FigPal must stay.
		const previous = notice;
		notice = undefined;
		previous?.cancel();
		let current: NotificationHandler;
		try {
			current = figma.notify(message, {
				timeout: Number.POSITIVE_INFINITY,
				button: { text: "Show", action: () => (notice === current ? showPanel() : undefined) },
				// The notice has Show: when the user closes it, FigPal closes.
				onDequeue: (reason) => (reason === "dismiss" && notice === current ? figma.closePlugin() : undefined),
			});
		} catch (error) {
			// Without a notice, the user could not get the panel back.
			figma.ui.show();
			throw error;
		}
		notice = current;
		figma.ui.hide();
		return { result: null };
	},

	async resize(wanted) {
		if (!isSize(wanted)) throw new Error("The size must be numbers.");
		size = fit(wanted);
		figma.ui.resize(size.width, size.height);
		// A drag sends many sizes: save the last one.
		clearTimeout(saveTimer);
		const saving = size;
		saveTimer = setTimeout(() => void figma.clientStorage.setAsync(SIZE_KEY, saving).catch((error) => console.warn("FigPal could not save the panel size:", error)), 300);
		return { result: size };
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
		if (origin === UI_ORIGIN && request?.kind === "request" && typeof request.id === "string") {
			const error = `This FigPal plugin does not know the request "${String(request.type)}". Update the plugin.`;
			post({ kind: "response", id: request.id, ok: false, error });
		}
		return;
	}
	// The first page and the offline page have a null origin. Their messages only open the UI again, or start the wait
	// for the UI.
	if (message.kind === "retry") {
		showUi();
		return;
	}
	if (message.kind === "loading") {
		clearTimeout(loadTimer);
		loadTimer = setTimeout(() => figma.showUI(offlineHtml(), uiOptions()), LOAD_TIMEOUT_MS);
		return;
	}
	if (origin !== UI_ORIGIN) {
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

figma.on("close", () => {
	writeRules();
	// Figma cleans up a notice after FigPal's code stopped, and then fails with "Invalid handle". Without a notice, its
	// onDequeue does not close FigPal again.
	const open = notice;
	notice = undefined;
	open?.cancel();
});

figma.on("currentpagechange", () => {
	post({ kind: "event", type: "page", page: summarize(figma.currentPage) });
});

// Without a saved size, the full height.
void figma.clientStorage
	.getAsync(SIZE_KEY)
	.catch(() => undefined)
	.then((saved) => {
		if (isSize(saved)) size = saved;
		showUi();
	});
