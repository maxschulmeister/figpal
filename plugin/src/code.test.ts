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
