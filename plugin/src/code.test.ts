import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../manifest.json" with { type: "json" };

type OnMessage = (message: unknown, props: { origin: string }) => void;

/** The origin of FigPal's UI: the FigPal command on this Mac. */
const UI = "http://localhost:9310";

/** Runs code.ts with a fake Plugin API. Returns the HTML of each `figma.showUI` call, and the UI channel. */
async function startPlugin(getAsync: (key: string) => Promise<unknown>, api: object = {}) {
	const shown: string[] = [];
	const options: ShowUIOptions[] = [];
	const posted: unknown[] = [];
	const saved = new Map<string, unknown>();
	const ui = {
		postMessage: (message: unknown) => posted.push(message),
		onmessage: undefined as OnMessage | undefined,
		resize: vi.fn(),
		hide: vi.fn(),
		show: vi.fn(),
	};
	const notices: { message: string; options: NotificationOptions; cancel: ReturnType<typeof vi.fn> }[] = [];
	vi.stubGlobal("figma", {
		clientStorage: { getAsync, setAsync: async (key: string, value: unknown) => void saved.set(key, value) },
		showUI: (html: string, option: ShowUIOptions) => {
			shown.push(html);
			options.push(option);
		},
		ui,
		on() {},
		notify: (message: string, options: NotificationOptions) => {
			const notice = { message, options, cancel: vi.fn() };
			notices.push(notice);
			return notice;
		},
		...api,
		// The visible canvas: 1600 × 900 px. A test can add to the viewport, for example scrollAndZoomIntoView.
		viewport: { bounds: { width: 800, height: 450 }, zoom: 2, ...(api as { viewport?: object }).viewport },
	});
	vi.resetModules();
	await import("./code");
	await new Promise((resolve) => setTimeout(resolve, 0));
	return { shown, options, posted, saved, ui, notices, send: (message: unknown, origin: string) => ui.onmessage?.(message, { origin }) };
}

const start = async (getAsync: () => Promise<unknown>) => (await startPlugin(getAsync)).shown;

afterEach(() => vi.unstubAllGlobals());

describe("code.ts start", () => {
	// The FigPal command serves the UI on this Mac (Phase 8). An old saved choice of a UI does nothing.
	it("opens the UI of the FigPal command, also with an old saved choice of a UI", async () => {
		const shown = await start(async () => "local");
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("http://localhost:9310/");
	});

	// Figma refuses the manifest with an IP address: "'http://127.0.0.1:9310' must be a valid URL" (user test).
	it("lets the manifest allow the UI origin by its host name", () => {
		expect(manifest.networkAccess.devAllowedDomains).toEqual([UI]);
	});

	// The first page waits for the FigPal command as long as it must. The time limit starts when it loads the UI.
	it("shows the offline page only when the UI does not answer 10 s after it starts to load", async () => {
		const page = { id: "0:1", name: "Page 1", type: "PAGE", selection: [] };
		const plugin = await startPlugin(async () => undefined, { root: { name: "File", getPluginData: () => "ID" }, currentPage: page });
		vi.useFakeTimers();
		try {
			await vi.advanceTimersByTimeAsync(60_000);
			expect(plugin.shown).toHaveLength(1);
			plugin.send({ kind: "loading" }, "null");
			await vi.advanceTimersByTimeAsync(9_000);
			expect(plugin.shown).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(plugin.shown[1]).toContain("FigPal did not start.");
			plugin.send({ kind: "retry" }, "null");
			expect(plugin.shown[2]).toBe(plugin.shown[0]);

			// The UI answers in time.
			plugin.send({ kind: "loading" }, "null");
			plugin.send({ kind: "ready" }, UI);
			await vi.advanceTimersByTimeAsync(20_000);
			expect(plugin.shown).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});

	// User request: the deployed UI is the normal case, so its title has no "(remote)".
	it("is titled FigPal", async () => {
		expect((await startPlugin(async () => "local")).options[0]?.title).toBe("FigPal");
	});

	// The canvas is 1600 × 900 px: the panel and its title bar fit in it.
	it("opens at the height of the canvas without a saved size", async () => {
		const { options } = await startPlugin(async () => undefined);
		expect(options[0]).toMatchObject({ width: 420, height: 836 });
	});

	it("opens at the saved size, at most as large as the canvas", async () => {
		const { options } = await startPlugin(async (key) => (key === "figpal.size" ? { width: 2000, height: 500 } : undefined));
		expect(options[0]).toMatchObject({ width: 1536, height: 500 });
		const broken = await startPlugin(async (key) => (key === "figpal.size" ? { width: "wide" } : undefined));
		expect(broken.options[0]).toMatchObject({ width: 420, height: 836 });
	});

	// The canvas can read too small, for example while the file loads: the panel opened very narrow once (user report).
	it("never opens smaller than the default width and the minimum height", async () => {
		const empty = await startPlugin(async () => undefined, { viewport: { bounds: { width: 0, height: 0 }, zoom: 1 } });
		expect(empty.options[0]).toMatchObject({ width: 420, height: 400 });
		const saved = await startPlugin(async (key) => (key === "figpal.size" ? { width: 900, height: 900 } : undefined), {
			viewport: { bounds: { width: 300, height: 350 }, zoom: 1 },
		});
		expect(saved.options[0]).toMatchObject({ width: 420, height: 400 });
	});

	it("resizes the panel within the limits, and saves the size", async () => {
		const { posted, saved, ui, send } = await startPlugin(async () => "remote");
		send({ kind: "request", id: "1", type: "resize", params: { width: 100, height: 600 } }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(1));
		expect(ui.resize).toHaveBeenCalledWith(320, 600);
		expect(posted[0]).toMatchObject({ ok: true, result: { width: 320, height: 600 } });
		await vi.waitFor(() => expect(saved.get("figpal.size")).toEqual({ width: 320, height: 600 }));
	});

	// The agent goes on in the hidden panel. A notice that stays brings it back.
	it("runs in the background: hides the panel, and a notice shows it again", async () => {
		const { posted, ui, notices, send } = await startPlugin(async () => "remote");
		send({ kind: "request", id: "1", type: "background", params: { message: "FigPal works in the background." } }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(1));
		expect(ui.hide).toHaveBeenCalled();
		expect(notices[0]).toMatchObject({ message: "FigPal works in the background.", options: { timeout: Number.POSITIVE_INFINITY, button: { text: "Show" } } });
		// A new message replaces the notice.
		send({ kind: "request", id: "2", type: "background", params: { message: "FigPal is done." } }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(2));
		expect(notices[0]!.cancel).toHaveBeenCalled();
		notices[1]!.options.button!.action();
		expect(ui.show).toHaveBeenCalled();
	});

	// A run can end after the user clicked Show: its notice must not hide the panel again.
	it("changes only a notice that is still there", async () => {
		const { posted, ui, notices, send } = await startPlugin(async () => "remote");
		send({ kind: "request", id: "1", type: "background", params: { message: "FigPal works in the background." } }, UI);
		await vi.waitFor(() => expect(notices).toHaveLength(1));
		notices[0]!.options.button!.action();
		send({ kind: "request", id: "2", type: "background", params: { message: "FigPal is done.", update: true } }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(2));
		expect(ui.hide).toHaveBeenCalledTimes(1);
		expect(notices).toHaveLength(1);
	});

	it("keeps the panel when Figma cannot show the notice", async () => {
		const { posted, ui, send } = await startPlugin(async () => "remote", {
			notify() {
				throw new Error("no notices");
			},
		});
		send({ kind: "request", id: "1", type: "background", params: { message: "FigPal works in the background." } }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({ ok: false });
		expect(ui.hide).not.toHaveBeenCalled();
	});

	// The notice has Show: closing it closes FigPal (user request).
	it("closes FigPal when the user closes the notice", async () => {
		const closePlugin = vi.fn();
		const { ui, notices, send } = await startPlugin(async () => "remote", { closePlugin });
		send({ kind: "request", id: "1", type: "background", params: { message: "FigPal works in the background." } }, UI);
		await vi.waitFor(() => expect(notices).toHaveLength(1));
		notices[0]!.options.onDequeue!("dismiss");
		expect(closePlugin).toHaveBeenCalled();
		expect(ui.show).not.toHaveBeenCalled();
	});

	// A new notice takes the place of the old one: the old one goes, FigPal stays.
	it("does not close FigPal when a new notice takes the place of the old one", async () => {
		const closePlugin = vi.fn();
		const { notices, send } = await startPlugin(async () => "remote", { closePlugin });
		send({ kind: "request", id: "1", type: "background", params: { message: "FigPal works in the background." } }, UI);
		send({ kind: "request", id: "2", type: "background", params: { message: "FigPal is done.", update: true } }, UI);
		await vi.waitFor(() => expect(notices).toHaveLength(2));
		notices[0]!.options.onDequeue!("dismiss");
		expect(closePlugin).not.toHaveBeenCalled();
	});

	it("opens the UI when the saved size cannot be read", async () => {
		const shown = await start(async () => {
			throw new Error("storage failed");
		});
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain(`${UI}/`);
	});

	// A newer remote UI can send a request type that this code.js does not know. Without a reply, the call waits forever.
	it("answers a request of an unknown type from the UI with an error", async () => {
		const { posted, send } = await startPlugin(async () => "remote");
		send({ kind: "request", id: "7", type: "something-new", params: {} }, UI);
		expect(posted).toEqual([{ kind: "response", id: "7", ok: false, error: expect.stringContaining("something-new") }]);
	});

	it("does not answer a request from another origin", async () => {
		const { posted, send } = await startPlugin(async () => "remote");
		send({ kind: "request", id: "7", type: "something-new", params: {} }, "https://evil.example");
		expect(posted).toEqual([]);
	});
});

describe("screenshot", () => {
	const png = new Uint8Array([137, 80, 78, 71]);
	/** A page with two top-level frames. Its content is 6000 × 2000 px. */
	const page = () => ({
		id: "0:1",
		name: "Page 1",
		type: "PAGE",
		selection: [],
		children: [
			{ absoluteBoundingBox: { x: -1000, y: 0, width: 4000, height: 1000 } },
			{ absoluteBoundingBox: { x: 4000, y: 500, width: 1000, height: 1500 } },
		],
		loadAsync: vi.fn(async () => {}),
		exportAsync: vi.fn(async () => png),
	});

	async function screenshot(params: object, current = page()) {
		const { posted, send } = await startPlugin(async () => "remote", {
			currentPage: current,
			getNodeByIdAsync: async (id: string) => (id === current.id ? current : null),
		});
		send({ kind: "request", id: "1", type: "screenshot", params }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(1));
		return { response: posted[0], page: current };
	}

	// Claude rejects images over 2000 px in requests with more than 20 images.
	it("exports a page: its content, with the longest side at most 2000 px", async () => {
		const { response, page } = await screenshot({ nodeId: "0:1" });
		expect(page.loadAsync).toHaveBeenCalled();
		expect(page.exportAsync).toHaveBeenCalledWith({ format: "PNG", constraint: { type: "SCALE", value: 2000 / 6000 } });
		expect(response).toEqual({
			kind: "response",
			id: "1",
			ok: true,
			result: { nodeId: "0:1", width: 2000, height: 667 },
			attachments: [{ name: "Page 1.png", mime: "image/png", bytes: png }],
		});
	});

	it("exports the current page when nothing is selected", async () => {
		const { response } = await screenshot({});
		expect(response).toMatchObject({ ok: true, result: { nodeId: "0:1" } });
	});
});

describe("selection events", () => {
	const card = { id: "1:2", name: "Card", type: "FRAME" };
	const logo = { id: "1:3", name: "Logo", type: "VECTOR" };

	async function plugin() {
		const handlers: Record<string, () => void> = {};
		const page = { id: "0:1", name: "Home", type: "PAGE", selection: [] as object[] };
		const fire = () => handlers.selectionchange?.();
		const { posted, send } = await startPlugin(async () => "remote", {
			currentPage: page,
			on: (name: string, handler: () => void) => {
				handlers[name] = handler;
			},
			fire,
			logo,
		});
		const events = () =>
			posted.filter((message) => (message as { type?: string }).type === "selection") as {
				selection: { id: string }[];
				selectionCount: number;
				page: { name: string };
				byAgent: boolean;
			}[];
		return { page, fire, events, posted, send };
	}

	it("gives the page of the selection, and a selection by the user is not by the agent", async () => {
		const { page, fire, events } = await plugin();
		page.selection = [card];
		fire();
		expect(events()).toEqual([
			{ kind: "event", type: "selection", selection: [card], selectionCount: 1, page: { id: "0:1", name: "Home", type: "PAGE" }, byAgent: false },
		]);
	});

	it("sends at most 50 nodes, and the count of all", async () => {
		const { page, fire, events } = await plugin();
		page.selection = Array.from({ length: 300 }, (_, index) => ({ ...card, id: `1:${index}` }));
		fire();
		expect(events()[0]).toMatchObject({ selectionCount: 300 });
		expect(events()[0]!.selection).toHaveLength(50);
	});

	it("marks a selection that figma_execute code makes, also when Figma reports it after the code", async () => {
		const { page, fire, events, posted, send } = await plugin();
		// Figma can report the change while the code runs, or after it.
		send({ kind: "request", id: "1", type: "execute", params: { code: "figma.currentPage.selection = [figma.logo]; figma.fire(); return 1;" } }, UI);
		await vi.waitFor(() => expect(posted.some((message) => (message as { kind: string }).kind === "response")).toBe(true));
		fire();
		// Then the user selects: first another node, then the node that the code selected.
		page.selection = [card];
		fire();
		page.selection = [logo];
		fire();
		expect(events().map((event) => [event.selection.map((node) => node.id), event.byAgent])).toEqual([
			[["1:3"], true],
			[["1:3"], true],
			[["1:2"], false],
			[["1:3"], false],
		]);
	});

	// A long script often selects its result at the end, after the wait for it timed out.
	it("marks a selection of code that still runs after its timeout", async () => {
		const { page, fire, events, posted, send } = await plugin();
		const code = "await new Promise((r) => setTimeout(r, 50)); figma.currentPage.selection = [figma.logo]; figma.fire();";
		send({ kind: "request", id: "1", type: "execute", params: { code, timeoutMs: 10 } }, UI);
		await vi.waitFor(() => expect(events()).toHaveLength(1), { timeout: 500 });
		expect(posted.find((message) => (message as { kind: string }).kind === "response")).toMatchObject({ ok: false });
		page.selection = [card];
		fire();
		expect(events().map((event) => [event.selection.map((node) => node.id), event.byAgent])).toEqual([
			[["1:3"], true],
			[["1:2"], false],
		]);
	});

	// Figma can report a selection after the code ends. If the code put back the selection of the user, that report is
	// not a new selection.
	it("marks a late report of a selection that the code put back", async () => {
		const { page, fire, events, posted, send } = await plugin();
		page.selection = [card];
		const code = "const before = figma.currentPage.selection; figma.currentPage.selection = [figma.logo]; figma.currentPage.selection = before;";
		send({ kind: "request", id: "1", type: "execute", params: { code } }, UI);
		await vi.waitFor(() => expect(posted.some((message) => (message as { kind: string }).kind === "response")).toBe(true));
		fire();
		expect(events().map((event) => event.byAgent)).toEqual([true]);
	});
});

describe("variables", () => {
	it("gives the local variables and collections for a token export", async () => {
		const collection = { id: "VariableCollectionId:1", name: "Colors", modes: [{ modeId: "1:0", name: "Light" }], isExtension: false };
		const variable = {
			id: "VariableID:1",
			name: "color/primary",
			resolvedType: "COLOR",
			valuesByMode: { "1:0": { r: 0, g: 0.4, b: 1, a: 1 } },
			variableCollectionId: "VariableCollectionId:1",
			scopes: ["ALL_SCOPES"],
			codeSyntax: { WEB: "--color-primary" },
			description: "Brand",
		};
		const { posted, send } = await startPlugin(async () => "remote", {
			// Figma's objects have more fields, which the export does not read.
			variables: {
				getLocalVariablesAsync: async () => [{ ...variable, key: "k2", hiddenFromPublishing: false, remote: false }],
				getLocalVariableCollectionsAsync: async () => [{ ...collection, key: "k1", defaultModeId: "1:0", variableIds: ["VariableID:1"] }],
			},
		});
		send({ kind: "request", id: "1", type: "variables", params: {} }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toEqual({ kind: "response", id: "1", ok: true, result: { collections: [collection], variables: [variable] }, attachments: [] });
	});
});

describe("components", () => {
	const throws = () => {
		throw new Error("in get_componentPropertyDefinitions: Component set has existing errors");
	};
	/** Runs the request on the nodes. Figma throws when code reads the property definitions of a variant or of a broken set. */
	async function components(found: object[]) {
		const flags: boolean[] = [];
		const api: Record<string, unknown> = {
			skipInvisibleInstanceChildren: false,
			loadAllPagesAsync: vi.fn(async () => {}),
			getLocalPaintStylesAsync: async () => [{ name: "Brand", type: "PAINT" }],
			getLocalTextStylesAsync: async () => [{ name: "Body", type: "TEXT" }],
			getLocalEffectStylesAsync: async () => [],
			getLocalGridStylesAsync: async () => [],
		};
		api.root = {
			name: "Library",
			findAllWithCriteria: vi.fn(() => {
				flags.push(figma.skipInvisibleInstanceChildren);
				return found;
			}),
		};
		const { posted, send } = await startPlugin(async () => "remote", api);
		send({ kind: "request", id: "1", type: "components", params: {} }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(1));
		return { response: posted[0], api, flags };
	}

	it("gives the local components, component sets and styles of all pages for the design-system audit", async () => {
		const set = { id: "1:1", name: "Button", type: "COMPONENT_SET", description: "Starts an action.", get componentPropertyDefinitions() { return throws(); } };
		const variant = { id: "1:2", name: "Size=Small", type: "COMPONENT", description: "", parent: set, get componentPropertyDefinitions() { return throws(); } };
		const definitions = { "Label#1:0": { type: "TEXT", defaultValue: "OK" } };
		const icon = { id: "2:1", name: "Icon", type: "COMPONENT", description: "", parent: { type: "FRAME" }, componentPropertyDefinitions: definitions };
		const { response, api, flags } = await components([set, variant, icon]);
		expect(api.loadAllPagesAsync).toHaveBeenCalled();
		expect((api.root as { findAllWithCriteria: unknown }).findAllWithCriteria).toHaveBeenCalledWith({ types: ["COMPONENT", "COMPONENT_SET"] });
		// Main components are never inside instances: the search skips them, which Figma says is much faster.
		expect(flags).toEqual([true]);
		expect(figma.skipInvisibleInstanceChildren).toBe(false);
		expect(response).toEqual({
			kind: "response",
			id: "1",
			ok: true,
			result: {
				fileName: "Library",
				componentSets: [{ id: "1:1", name: "Button", description: "Starts an action." }],
				components: [
					{ id: "1:2", name: "Size=Small", description: "", componentSetId: "1:1" },
					{ id: "2:1", name: "Icon", description: "", componentSetId: null, componentPropertyDefinitions: { "Label#1:0": { type: "TEXT" } } },
				],
				styles: [
					{ name: "Brand", type: "PAINT" },
					{ name: "Body", type: "TEXT" },
				],
			},
			attachments: [],
		});
	});

	it("gives a component with broken properties without them", async () => {
		const broken = { id: "2:1", name: "Icon", type: "COMPONENT", description: "", parent: { type: "FRAME" }, get componentPropertyDefinitions() { return throws(); } };
		const { response } = await components([broken]);
		expect(response).toMatchObject({ ok: true, result: { components: [{ id: "2:1", componentSetId: null, componentPropertyDefinitions: {} }] } });
	});
});

describe("lint and select", () => {
	/** Two pages. A layer knows its parent, as in Figma. */
	function pages() {
		const home: Record<string, unknown> = { id: "0:1", name: "Home", type: "PAGE", selection: [] };
		const icons: Record<string, unknown> = { id: "0:2", name: "Icons", type: "PAGE", selection: [] };
		const frame = { id: "1:1", name: "Frame 1", type: "FRAME", visible: true, children: [], parent: home };
		const card = { id: "1:2", name: "Card", type: "FRAME", visible: true, children: [], parent: home };
		const star = { id: "2:1", name: "Star", type: "FRAME", visible: true, children: [], parent: icons };
		home.children = [frame, card];
		icons.children = [star];
		const nodes: Record<string, unknown> = { "1:1": frame, "1:2": card, "2:1": star };
		return { home, icons, nodes };
	}
	async function request(type: string, params: object, current: "home" | "icons" = "icons") {
		const { home, icons, nodes } = pages();
		const api = {
			currentPage: current === "home" ? home : icons,
			getNodeByIdAsync: async (id: string) => nodes[id] ?? null,
			setCurrentPageAsync: vi.fn(async (page: unknown) => {
				api.currentPage = page as typeof icons;
			}),
			viewport: { scrollAndZoomIntoView: vi.fn() },
		};
		const { posted, send } = await startPlugin(async () => "remote", api);
		send({ kind: "request", id: "1", type, params }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(1));
		return { response: posted[0] as { ok: boolean; result: never; error?: string }, api: figma as unknown as typeof api, home, nodes };
	}

	it("lints a node, with the rules", async () => {
		const { response } = await request("lint", { nodeId: "1:1", rules: ["default-name"] });
		expect(response).toMatchObject({ ok: true, result: { rootNodeId: "1:1", categories: [{ rule: "default-name", nodes: [{ id: "1:1" }] }] } });
	});

	it("selects the layers, goes to their page and zooms to them; it skips layers that no longer exist", async () => {
		const { response, api, home, nodes } = await request("select", { nodeIds: ["9:9", "1:1", "1:2"] });
		expect(response).toMatchObject({ ok: true, result: { count: 2 } });
		expect(api.setCurrentPageAsync).toHaveBeenCalledWith(home);
		expect(home.selection).toEqual([nodes["1:1"], nodes["1:2"]]);
		expect(api.viewport.scrollAndZoomIntoView).toHaveBeenCalledWith([nodes["1:1"], nodes["1:2"]]);
	});

	// A selection cannot have layers of two pages.
	it("stays on the current page when it has some of the layers, and selects only those", async () => {
		const { response, api, home, nodes } = await request("select", { nodeIds: ["2:1", "1:2"] }, "home");
		expect(response).toMatchObject({ ok: true, result: { count: 1 } });
		expect(api.setCurrentPageAsync).not.toHaveBeenCalled();
		expect(home.selection).toEqual([nodes["1:2"]]);
	});

	it("says when none of the layers exist", async () => {
		const { response } = await request("select", { nodeIds: ["9:9"] });
		expect(response).toMatchObject({ ok: false, error: "These layers no longer exist." });
	});
});

describe("export", () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const node = (id: string, name: string) => ({ id, name, type: "FRAME", exportAsync: vi.fn(async () => bytes) });

	async function exportNodes(params: object, nodes = [node("1:2", "Icons/Arrow"), node("1:3", "Logo")]) {
		const { posted, send } = await startPlugin(async () => "remote", {
			currentPage: { selection: [] },
			getNodeByIdAsync: async (id: string) => nodes.find((n) => n.id === id) ?? null,
		});
		send({ kind: "request", id: "1", type: "export", params }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(1));
		return { response: posted[0], nodes };
	}

	it("exports each node as a file with its name, without changing the file", async () => {
		const { response, nodes } = await exportNodes({ nodeIds: ["1:2", "1:3"], format: "SVG" });
		expect(nodes[0]!.exportAsync).toHaveBeenCalledWith({ format: "SVG" });
		expect(response).toEqual({
			kind: "response",
			id: "1",
			ok: true,
			result: { count: 2 },
			attachments: [
				{ name: "Icons-Arrow.svg", mime: "image/svg+xml", bytes },
				{ name: "Logo.svg", mime: "image/svg+xml", bytes },
			],
		});
	});

	it("exports PNG and JPG at a scale, default 1", async () => {
		const { nodes } = await exportNodes({ nodeIds: ["1:2"], format: "PNG", scale: 2 });
		expect(nodes[0]!.exportAsync).toHaveBeenCalledWith({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
		const jpg = await exportNodes({ nodeIds: ["1:3"], format: "JPG" });
		expect(jpg.nodes[1]!.exportAsync).toHaveBeenCalledWith({ format: "JPG", constraint: { type: "SCALE", value: 1 } });
		expect(jpg.response).toMatchObject({ attachments: [{ name: "Logo.jpg", mime: "image/jpeg" }] });
	});

	it("fails for a node that does not exist", async () => {
		const { response } = await exportNodes({ nodeIds: ["9:9"], format: "PDF" });
		expect(response).toMatchObject({ ok: false, error: "The layer with ID 9:9 no longer exists." });
	});

	// Figma exports the animation of a top-level frame only.
	function animated() {
		const hero = { ...node("1:1", "Hero"), getTopLevelFrame: () => hero };
		const ball = { ...node("1:5", "Ball"), type: "ELLIPSE", getTopLevelFrame: () => hero };
		const loose = { ...node("1:6", "Loose"), type: "SECTION", getTopLevelFrame: () => undefined };
		return [hero, ball, loose];
	}

	it("exports the animation of the top-level frame as a video, once for layers of the same frame", async () => {
		const { response, nodes } = await exportNodes({ nodeIds: ["1:5", "1:1"], format: "MP4" }, animated());
		expect(nodes[0]!.exportAsync).toHaveBeenCalledTimes(1);
		expect(nodes[0]!.exportAsync).toHaveBeenCalledWith({ format: "MP4", constraint: { type: "SCALE", value: 1 } });
		expect(nodes[1]!.exportAsync).not.toHaveBeenCalled();
		expect(response).toMatchObject({ ok: true, result: { count: 1 }, attachments: [{ name: "Hero.mp4", mime: "video/mp4" }] });
	});

	// For the frames of figma_animation_frames: small and fast.
	it("exports a video at a width, frame rate and quality; a GIF has no quality", async () => {
		const webm = await exportNodes({ nodeIds: ["1:5"], format: "WEBM", width: 480, fps: 24, quality: "LOW" }, animated());
		expect(webm.nodes[0]!.exportAsync).toHaveBeenCalledWith({ format: "WEBM", constraint: { type: "WIDTH", value: 480 }, fps: 24, quality: "LOW" });
		expect(webm.response).toMatchObject({ attachments: [{ name: "Hero.webm", mime: "video/webm" }] });
		const gif = await exportNodes({ nodeIds: ["1:1"], format: "GIF", fps: 12, quality: "LOW" }, animated());
		expect(gif.nodes[0]!.exportAsync).toHaveBeenCalledWith({ format: "GIF", constraint: { type: "SCALE", value: 1 }, fps: 12 });
		expect(gif.response).toMatchObject({ attachments: [{ name: "Hero.gif", mime: "image/gif" }] });
	});

	it("exports a video only at the scales of Figma's export panel", async () => {
		const { response, nodes } = await exportNodes({ nodeIds: ["1:1"], format: "MP4", scale: 0.6 }, animated());
		expect(nodes[0]!.exportAsync).not.toHaveBeenCalled();
		expect(response).toMatchObject({ ok: false, error: "Videos take the scales 0.5, 0.75, 1, 1.5, 2, 3 and 4." });
	});

	it("fails for a video of a layer that is not in a top-level frame", async () => {
		const { response } = await exportNodes({ nodeIds: ["1:6"], format: "WEBM" }, animated());
		expect(response).toMatchObject({ ok: false, error: 'The layer "Loose" is not in a top-level frame. Only top-level frames have animations.' });
	});
});

// Rules for this file (user request, like an AGENTS.md of a repo): in the file, so everyone with the file gets them.
describe("rules of the file", () => {
	it("reads and saves the rules in the file, and refuses more than 4,000 characters", async () => {
		const data = new Map<string, string>();
		const root = { getPluginData: (key: string) => data.get(key) ?? "", setPluginData: (key: string, value: string) => void data.set(key, value) };
		const { posted, send } = await startPlugin(async () => undefined, { root });
		const ask = async (id: string, params: object) => {
			send({ kind: "request", id, type: "rules", params }, UI);
			await vi.waitFor(() => expect(posted.some((reply) => (reply as { id: string }).id === id)).toBe(true));
			return posted.find((reply) => (reply as { id: string }).id === id);
		};
		expect(await ask("1", {})).toMatchObject({ ok: true, result: "" });
		expect(await ask("2", { text: "Use the Brand library." })).toMatchObject({ ok: true, result: "Use the Brand library." });
		expect(await ask("3", { text: "x".repeat(4001) })).toMatchObject({ ok: false });
		expect(await ask("4", { text: 3 })).toMatchObject({ ok: false });
		await vi.waitFor(() => expect(data.get("figpal.rules")).toBe("Use the Brand library."));
	});

	// Typing must not change the file at each key; closing FigPal must not lose the last keys (review).
	it("writes the rules into the file after a short wait, or at once when FigPal closes", async () => {
		const data = new Map<string, string>();
		const root = { getPluginData: (key: string) => data.get(key) ?? "", setPluginData: (key: string, value: string) => void data.set(key, value) };
		const events: Record<string, () => void> = {};
		const { posted, send } = await startPlugin(async () => undefined, { root, on: (event: string, listener: () => void) => {
				events[event] = listener;
			},
		});
		send({ kind: "request", id: "1", type: "rules", params: { text: "Use" } }, UI);
		send({ kind: "request", id: "2", type: "rules", params: {} }, UI);
		await vi.waitFor(() => expect(posted).toHaveLength(2));
		expect(posted[1]).toMatchObject({ ok: true, result: "Use" });
		expect(data.has("figpal.rules")).toBe(false);
		events.close!();
		expect(data.get("figpal.rules")).toBe("Use");
	});
});
