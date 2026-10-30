import { describe, expect, it } from "vitest";
import { ExecuteTimeout, execute, serialize } from "./execute";

const figma = { currentPage: { name: "Page 1" } };

describe("execute", () => {
	it("supports top-level await and return", async () => {
		const result = await execute("await Promise.resolve(); return figma.currentPage.name;", { figma });
		expect(result.value).toBe('"Page 1"');
	});

	it("cannot see the locals of the plugin", async () => {
		await expect(execute("return typeof timeoutMs;", { figma })).resolves.toMatchObject({ value: '"undefined"' });
	});

	it("tells the model to return a value", async () => {
		const result = await execute("figma.currentPage.name;", { figma });
		expect(result.value).toMatch(/use `return`/);
	});

	it("rejects with the error of the code", async () => {
		await expect(execute("throw new Error('boom');", { figma })).rejects.toThrow("boom");
	});

	it("rejects with a syntax error", async () => {
		await expect(execute("return (;", { figma })).rejects.toThrow(SyntaxError);
	});

	it("stops waiting after the timeout and gives the running code", async () => {
		const error = await execute("await new Promise((r) => setTimeout(r, 50)); return 1;", { figma, timeoutMs: 20 }).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(ExecuteTimeout);
		expect((error as ExecuteTimeout).message).toMatch(/Timed out after 20 ms/);
		await expect((error as ExecuteTimeout).running).resolves.toBe(1);
	});

	it("collects attachments from pi.attach", async () => {
		const result = await execute("pi.attach(new Uint8Array([1, 2]), { mime: 'image/png', name: 'a.png' }); return 1;", {
			figma,
		});
		expect(result.attachments).toEqual([{ bytes: new Uint8Array([1, 2]), mime: "image/png", name: "a.png" }]);
	});
});

describe("serialize", () => {
	it("writes nodes as id, name and type", () => {
		// Like a Plugin API node: `id` is an own property, the others come from the prototype.
		const node = Object.assign(Object.create({ name: "Card", type: "FRAME", removed: false }), { id: "1:2" });
		expect(JSON.parse(serialize([node]).value)).toEqual([{ id: "1:2", name: "Card", type: "FRAME" }]);
	});

	it("truncates long output", () => {
		const result = serialize("x".repeat(100), 10);
		expect(result.truncated).toBe(true);
		expect(result.value).toMatch(/output truncated: 102 characters, limit 10/);
	});
});
