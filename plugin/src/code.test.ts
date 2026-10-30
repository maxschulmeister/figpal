import { afterEach, describe, expect, it, vi } from "vitest";

type OnMessage = (message: unknown, props: { origin: string }) => void;

/** Runs code.ts with a fake Plugin API. Returns the HTML of each `figma.showUI` call, and the UI channel. */
async function startPlugin(getAsync: () => Promise<unknown>) {
	const shown: string[] = [];
	const posted: unknown[] = [];
	const ui = { postMessage: (message: unknown) => posted.push(message), onmessage: undefined as OnMessage | undefined };
	vi.stubGlobal("figma", {
		clientStorage: { getAsync, setAsync: async () => {} },
		showUI: (html: string) => shown.push(html),
		ui,
		on() {},
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
