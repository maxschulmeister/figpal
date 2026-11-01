import type { Bridge } from "./bridge";
import type { Variables } from "@figpal/shared";
import { describe, expect, it } from "vitest";
import { exportTokens } from "./tokens";

const LIGHT = "1:0";
const DARK = "1:1";
const collection = (id: string, name: string, extra: Partial<Variables["collections"][number]> = {}) => ({
	id,
	name,
	modes: [{ modeId: LIGHT, name: "Light" }],
	isExtension: false,
	...extra,
});
const variable = (id: string, name: string, collectionId: string, resolvedType: string, valuesByMode: Record<string, unknown>) => ({
	id,
	name,
	resolvedType,
	valuesByMode,
	variableCollectionId: collectionId,
	scopes: ["ALL_SCOPES"],
	codeSyntax: {},
	description: "",
});

/** Two collections: colors with light and dark mode, and spacing. One extended collection. */
const VARIABLES: Variables = {
	collections: [
		collection("C:1", "Colors", { modes: [{ modeId: LIGHT, name: "Light" }, { modeId: DARK, name: "Dark" }] }),
		// Figma names the first mode of a new collection "Mode 1".
		collection("C:2", "Spacing", { modes: [{ modeId: "2:0", name: "Mode 1" }] }),
		collection("C:3", "Brand B", { isExtension: true }),
	],
	variables: [
		variable("V:1", "color/primary", "C:1", "COLOR", { [LIGHT]: { r: 0, g: 0.4, b: 1, a: 1 }, [DARK]: { r: 0.4, g: 0.6, b: 1, a: 1 } }),
		variable("V:2", "color/accent", "C:1", "COLOR", { [LIGHT]: { type: "VARIABLE_ALIAS", id: "V:1" }, [DARK]: { type: "VARIABLE_ALIAS", id: "V:1" } }),
		variable("V:3", "space/sm", "C:2", "FLOAT", { "2:0": 4 }),
		variable("V:4", "motion/slow", "C:2", "TIMING", { "2:0": 0.4 }),
		variable("V:5", "motion/ease", "C:2", "EASING", { "2:0": { type: "EASE_OUT", easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } } }),
	],
};

const bridge = (variables = VARIABLES) =>
	({ request: async () => ({ result: variables, attachments: [] }) }) as unknown as Pick<Bridge, "request">;
const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("exportTokens", () => {
	it("exports the local variables as files and tells the model what it made", async () => {
		const { files, summary } = await exportTokens(bridge(), { format: "css-vars" });
		expect(files.map((file) => [file.name, file.mime])).toEqual([["tokens.css", "text/css"]]);
		const css = textOf(files[0]!.bytes);
		expect(css).toContain("--color-primary");
		expect(css).toContain("--space-sm");
		expect(summary).toMatch(/^Exported 5 tokens from 2 collections as css-vars\./);
		expect(summary).toMatch(/Files for the user to download from this step: tokens\.css \([\d.]+ (bytes|KB)\)\./);
		expect(summary).toContain("--color-primary");
	});

	it("leaves out extended collections, and says so", async () => {
		const { summary } = await exportTokens(bridge(), { format: "dtcg" });
		expect(summary).toContain('Extended collection "Brand B" was not exported');
	});

	it("exports only the collections that the model names, by name or ID", async () => {
		const { files } = await exportTokens(bridge(), { format: "json-flat", collections: ["spacing"] });
		const json = textOf(files[0]!.bytes);
		expect(json).toContain("space");
		expect(json).not.toContain("primary");
		const byId = await exportTokens(bridge(), { format: "json-flat", collections: ["C:1"] });
		expect(textOf(byId.files[0]!.bytes)).toContain("primary");
	});

	it("names the collections when the model asks for one that does not exist", async () => {
		await expect(exportTokens(bridge(), { format: "dtcg", collections: ["Typography"] })).rejects.toThrow(
			'No collection "Typography". The collections are: Colors, Spacing.',
		);
	});

	it("gives one file for each mode when asked", async () => {
		const { files } = await exportTokens(bridge(), { format: "css-vars", split_by_mode: true, collections: ["Colors"] });
		expect(files.length).toBe(2);
	});

	it("puts the first mode of each collection into :root in CSS, and Dark into .dark", async () => {
		const css = textOf((await exportTokens(bridge(), { format: "css-vars" })).files[0]!.bytes);
		expect(css).toMatch(/:root \{[^}]*--space-sm: 4px;/);
		expect(css).toMatch(/\.dark \{[^}]*--color-primary/);
		const tailwind4 = textOf((await exportTokens(bridge(), { format: "tailwind-v4" })).files[0]!.bytes);
		expect(tailwind4).toMatch(/@theme inline \{[^}]*--spacing-space-sm: 4px;/);
		expect(tailwind4).not.toContain("mode-1");
	});

	it("writes durations and easings as CSS values", async () => {
		const css = textOf((await exportTokens(bridge(), { format: "css-vars" })).files[0]!.bytes);
		expect(css).toContain("--motion-slow: 400ms;");
		expect(css).toContain("--motion-ease: cubic-bezier(0, 0, 0.58, 1);");
		const scss = textOf((await exportTokens(bridge(), { format: "scss" })).files[0]!.bytes);
		expect(scss).toContain("$motion-slow: 400ms;");
		const tailwind4 = textOf((await exportTokens(bridge(), { format: "tailwind-v4" })).files[0]!.bytes);
		expect(tailwind4).toContain("400ms;");
		expect(tailwind4).toContain("cubic-bezier(0, 0, 0.58, 1);");
	});

	it("puts durations and easings under Tailwind v3 theme keys", async () => {
		const tailwind3 = textOf((await exportTokens(bridge(), { format: "tailwind-v3" })).files[0]!.bytes);
		expect(tailwind3).toMatch(/transitionDuration: \{[^}]*"400ms"/s);
		expect(tailwind3).toMatch(/transitionTimingFunction: \{[^}]*"cubic-bezier\(0, 0, 0\.58, 1\)"/s);
		expect(tailwind3).not.toMatch(/^\s*extend:/m);
	});

	it("matches mode names without case, and leaves out collections without the modes", async () => {
		const { files, summary } = await exportTokens(bridge(), { format: "css-vars", modes: ["dark"] });
		const css = textOf(files[0]!.bytes);
		expect(css).toContain("--color-primary");
		expect(css).not.toContain("--space-sm");
		expect(summary).toMatch(/^Exported 2 tokens from 1 collection/);
		expect(summary).toContain('Collection "Spacing" has none of the modes Dark: it was not exported.');
	});

	it("names the modes when the model asks for one that does not exist", async () => {
		await expect(exportTokens(bridge(), { format: "dtcg", modes: ["Night"] })).rejects.toThrow(
			'No mode "Night". The modes are: Light, Dark, Mode 1.',
		);
	});

	it("says why an extended collection cannot be exported", async () => {
		await expect(exportTokens(bridge(), { format: "dtcg", collections: ["Brand B"] })).rejects.toThrow(
			'"Brand B" is an extended collection',
		);
	});

	it("fails when the file has no variables", async () => {
		await expect(exportTokens(bridge({ collections: [], variables: [] }), { format: "dtcg" })).rejects.toThrow(
			"The file has no local variables to export.",
		);
	});
});
