import { describe, expect, it, vi } from "vitest";
import { createBridge } from "./bridge";

function setup() {
	const host = new EventTarget() as unknown as Window;
	type Posted = { pluginMessage: { id: string } };
	const posted: { message: Posted; targetOrigin: string }[] = [];
	const parent = { postMessage: (message: Posted, targetOrigin: string) => posted.push({ message, targetOrigin }) };
	const bridge = createBridge(host, parent as unknown as Window);
	// Node's MessageEvent only accepts a MessagePort as source, so use a plain event with the same fields.
	const reply = (pluginMessage: unknown, source: unknown = parent, origin = "https://www.figma.com") =>
		host.dispatchEvent(Object.assign(new Event("message"), { data: { pluginMessage }, source, origin }));
	return { bridge, posted, reply };
}

describe("bridge", () => {
	it("sends a request with the plugin ID to the Figma origin and resolves with the response", async () => {
		const { bridge, posted, reply } = setup();
		const promise = bridge.request("execute", { code: "return 1" });
		const { message, targetOrigin } = posted[0]!;
		expect(targetOrigin).toBe("https://www.figma.com");
		expect(message).toMatchObject({ pluginId: "figpal", pluginMessage: { kind: "request", type: "execute" } });
		reply({ kind: "response", id: message.pluginMessage.id, ok: true, result: { value: "1" }, attachments: [] });
		await expect(promise).resolves.toEqual({ result: { value: "1" }, attachments: [] });
	});

	it("rejects with the error from code.js", async () => {
		const { bridge, posted, reply } = setup();
		const promise = bridge.request("storage-get", { key: "figpal.x" });
		reply({ kind: "response", id: posted[0]!.message.pluginMessage.id, ok: false, error: "nope" });
		await expect(promise).rejects.toThrow("nope");
	});

	// In Figma Desktop, messages from code.js did not arrive when the bridge required `event.source === parent`.
	it("accepts messages from figma.com that another window sends", () => {
		const { bridge, reply } = setup();
		const events: unknown[] = [];
		bridge.onEvent((event) => events.push(event));
		reply({ kind: "event", type: "page", page: { id: "0:1", name: "Page", type: "PAGE" } }, {});
		expect(events).toHaveLength(1);
	});

	// The remote UI deploys separately from code.js. A selection event of an older code.js has no page and no
	// `byAgent`, and its chip would break.
	it("ignores a selection event of an older code.js and asks for an update", () => {
		const { bridge, reply } = setup();
		const events: unknown[] = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		bridge.onEvent((event) => events.push(event));
		reply({ kind: "event", type: "selection", selection: [{ id: "1:2", name: "Card", type: "FRAME" }] });
		expect(events).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Run the newest FigPal plugin"));
		warn.mockRestore();
	});

	it("ignores messages from other origins", () => {
		const { bridge, reply } = setup();
		const events: unknown[] = [];
		bridge.onEvent((event) => events.push(event));
		reply({ kind: "event", type: "page", page: { id: "0:1", name: "Page", type: "PAGE" } }, undefined, "https://evil.example");
		expect(events).toHaveLength(0);
	});
});
