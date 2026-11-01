import { afterEach, describe, expect, it, vi } from "vitest";

type OnMessage = (message: unknown, props: { origin: string }) => void;

/** Runs code.ts with a fake Plugin API. Returns the HTML of each `figma.showUI` call, and the UI channel. */
async function startPlugin(getAsync: () => Promise<unknown>, api: object = {}) {
	const shown: string[] = [];
	const posted: unknown[] = [];
	const ui = { postMessage: (message: unknown) => posted.push(message), onmessage: undefined as OnMessage | undefined };
	vi.stubGlobal("figma", {
		clientStorage: { getAsync, setAsync: async () => {} },
		showUI: (html: string) => shown.push(html),
		ui,
		on() {},
		...api,
	});
	vi.resetModules();
	await import("./code");
	await new Promise((resolve) => setTimeout(resolve, 0));
	return { shown, posted, send: (message: unknown, origin: string) => ui.onmessage?.(message, { origin }) };
}

const start = async (getAsync: () => Promise<unknown>) => (await startPlugin(getAsync)).shown;

afterEach(() => vi.unstubAllGlobals());

describe("code.ts start", () => {
	it("opens the saved UI", async () => {
		const shown = await start(async () => "local");
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("http://localhost:5173/");
	});

	it("opens the remote UI when the setting cannot be read", async () => {
		const shown = await start(async () => {
			throw new Error("storage failed");
		});
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("https://figpal.maxschulmeister.dev/");
	});

	// A newer remote UI can send a request type that this code.js does not know. Without a reply, the call waits forever.
	it("answers a request of an unknown type from the UI with an error", async () => {
		const { posted, send } = await startPlugin(async () => "remote");
		send({ kind: "request", id: "7", type: "something-new", params: {} }, "https://figpal.maxschulmeister.dev");
		expect(posted).toEqual([{ kind: "response", id: "7", ok: false, error: expect.stringContaining("something-new") }]);
	});

	it("does not answer a request from another origin", async () => {
		const { posted, send } = await startPlugin(async () => "remote");
		send({ kind: "request", id: "7", type: "something-new", params: {} }, "https://evil.example");
		expect(posted).toEqual([]);
	});
});

describe("screenshot", () => {
	const UI = "https://figpal.maxschulmeister.dev";
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

	it("exports a page: its content, with the longest side at most 2048 px", async () => {
		const { response, page } = await screenshot({ nodeId: "0:1" });
		expect(page.loadAsync).toHaveBeenCalled();
		expect(page.exportAsync).toHaveBeenCalledWith({ format: "PNG", constraint: { type: "SCALE", value: 2048 / 6000 } });
		expect(response).toEqual({
			kind: "response",
			id: "1",
			ok: true,
			result: { nodeId: "0:1", width: 2048, height: 683 },
			attachments: [{ name: "Page 1.png", mime: "image/png", bytes: png }],
		});
	});

	it("exports the current page when nothing is selected", async () => {
		const { response } = await screenshot({});
		expect(response).toMatchObject({ ok: true, result: { nodeId: "0:1" } });
	});
});

describe("selection events", () => {
	const UI = "https://figpal.maxschulmeister.dev";
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
		send({ kind: "request", id: "1", type: "variables", params: {} }, "https://figpal.maxschulmeister.dev");
		await vi.waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toEqual({ kind: "response", id: "1", ok: true, result: { collections: [collection], variables: [variable] }, attachments: [] });
	});
});

describe("export", () => {
	const UI = "https://figpal.maxschulmeister.dev";
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
});
