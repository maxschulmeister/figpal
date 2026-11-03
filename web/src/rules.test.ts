import { describe, expect, it } from "vitest";
import type { Bridge } from "./bridge";
import { loadRules, readRulesPrompt, rulesPrompt, saveRules } from "./rules";

/** A bridge with clientStorage and the rules of the file. `calls` has each request. */
function fakeBridge(stored: { global?: unknown; file?: string } = {}) {
	const calls: [string, unknown][] = [];
	let global = stored.global;
	let file = stored.file ?? "";
	const bridge = {
		async request(type: string, params: { key?: string; value?: unknown; text?: string }) {
			calls.push([type, params]);
			if (type === "storage-get") return { result: params.key === "figpal.rules" ? global : undefined, attachments: [] };
			if (type === "storage-set") global = params.value;
			if (type === "rules" && params.text !== undefined) file = params.text;
			return { result: type === "rules" ? file : null, attachments: [] };
		},
	} as unknown as Pick<Bridge, "request">;
	return { bridge, calls };
}

describe("rules", () => {
	it("are none in the prompt without text", () => {
		expect(rulesPrompt({ global: "", file: " \n" })).toBeUndefined();
	});

	it("are in the prompt with the rules for this file last: they win", () => {
		const prompt = rulesPrompt({ global: "Answer briefly.", file: "Use the Brand library." })!;
		expect(prompt).toContain("Answer briefly.");
		expect(prompt.indexOf("Answer briefly.")).toBeLessThan(prompt.indexOf("Use the Brand library."));
		expect(prompt).toMatch(/for this file win/);
		expect(rulesPrompt({ global: "", file: "Use the Brand library." })).not.toContain("all files");
	});

	it("load the rules for all files from clientStorage and the rules for this file from the file", async () => {
		expect(await loadRules(fakeBridge({ global: "Answer briefly.", file: "Use the Brand library." }).bridge)).toEqual({
			global: "Answer briefly.",
			file: "Use the Brand library.",
		});
		expect(await loadRules(fakeBridge({ global: 3 }).bridge)).toEqual({ global: "", file: "" });
		// A text from an older FigPal, or written by another plugin, is cut at the limit.
		expect((await loadRules(fakeBridge({ global: "x".repeat(5000), file: "y".repeat(5000) }).bridge)).file).toHaveLength(4000);
	});

	// A code.js from before the rules does not know the request: the chat goes on without rules.
	it("are none in the prompt when code.js cannot give them", async () => {
		const bridge = { request: async () => Promise.reject(new Error("Unknown request rules")) } as unknown as Pick<Bridge, "request">;
		expect(await readRulesPrompt(bridge)).toBeUndefined();
		expect(await readRulesPrompt(fakeBridge({ global: "Answer briefly." }).bridge)).toContain("Answer briefly.");
	});

	it("save each text in its place", async () => {
		const { bridge, calls } = fakeBridge();
		await saveRules(bridge, "global", "Answer briefly.");
		await saveRules(bridge, "file", "Use the Brand library.");
		expect(calls).toEqual([
			["storage-set", { key: "figpal.rules", value: "Answer briefly." }],
			["rules", { text: "Use the Brand library." }],
		]);
	});
});
