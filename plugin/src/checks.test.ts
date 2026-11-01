import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute";

afterEach(() => vi.unstubAllGlobals());

const solid = (gray: number) => ({ type: "SOLID", visible: true, opacity: 1, color: { r: gray, g: gray, b: gray } });

/** A small Plugin API tree. Each node knows its parent, as in Figma. */
function tree() {
	const frame: Record<string, unknown> = { id: "1:1", name: "Frame 1", type: "FRAME", visible: true, fills: [solid(1)] };
	const label = {
		id: "1:2",
		name: "Label",
		type: "TEXT",
		visible: true,
		parent: frame,
		fills: [solid(0.75)],
		fontSize: 14,
		fontName: { family: "Inter", style: "Regular" },
		fontWeight: 400,
		characters: "Read more",
		textStyleId: "",
		width: 80,
		height: 17,
		absoluteBoundingBox: { x: 0, y: 0, width: 80, height: 17 },
	};
	frame.children = [label];
	frame.absoluteBoundingBox = { x: 0, y: 0, width: 200, height: 100 };
	const nodes: Record<string, unknown> = { "1:1": frame, "1:2": label };
	return {
		currentPage: { id: "0:1", name: "Page 1", type: "PAGE", children: [frame], selection: [] },
		getNodeByIdAsync: async (id: string) => nodes[id] ?? null,
		getLocalPaintStylesAsync: async () => [],
		getLocalTextStylesAsync: async () => [],
		variables: { getLocalVariablesAsync: async () => [], getLocalVariableCollectionsAsync: async () => [] },
	};
}

/** A button component set with the variants State=Default and State=Hover, 20 px high. */
function buttons() {
	const variant = (id: string, state: string, blue: number) => {
		const node: Record<string, unknown> = {
			id,
			name: `State=${state}`,
			type: "COMPONENT",
			visible: true,
			variantProperties: { State: state },
			fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0, g: 0.4, b: blue } }],
			strokes: [],
			effects: [],
			width: 80,
			height: 20,
		};
		const label = { id: `${id}:1`, name: "Label", type: "TEXT", visible: true, parent: node, fills: [solid(1)], fontSize: 14, characters: "Buy" };
		node.children = [label];
		return node;
	};
	const normal = variant("2:1", "Default", 1);
	const hover = variant("2:2", "Hover", 0.8);
	const set = {
		id: "2:0",
		name: "Button",
		type: "COMPONENT_SET",
		visible: true,
		children: [normal, hover],
		defaultVariant: normal,
		componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] } },
		findAllWithCriteria: () => [],
	};
	normal.parent = set;
	hover.parent = set;
	const nodes: Record<string, unknown> = { "2:0": set, "2:1": normal, "2:2": hover };
	return { ...tree(), getNodeByIdAsync: async (id: string) => nodes[id] ?? null };
}

const run = async (code: string, figma: ReturnType<typeof tree> = tree()) => {
	vi.stubGlobal("figma", figma);
	return JSON.parse((await execute(code, { figma })).value);
};

describe("pi checks (copied from figma-console-mcp)", () => {
	it("pi.lint finds text with low contrast and a default layer name", async () => {
		const result = await run(`return pi.lint(await figma.getNodeByIdAsync("1:1"));`);
		const rules = Object.fromEntries(result.categories.map((category: { rule: string; nodes: { id: string }[] }) => [category.rule, category.nodes.map((node) => node.id)]));
		expect(rules["wcag-contrast"]).toEqual(["1:2"]);
		expect(rules["default-name"]).toEqual(["1:1"]);
	});

	it("pi.lint takes a node ID and options", async () => {
		const result = await run(`return pi.lint("1:1", { rules: ["wcag"] });`);
		expect(result.rootNodeId).toBe("1:1");
		expect(result.categories.map((category: { rule: string }) => category.rule)).toEqual(["wcag-contrast", "apca-contrast"]);
	});

	it("pi.lint does not load styles or variables when the rule does not use them", async () => {
		const figma = tree();
		const paints = vi.spyOn(figma, "getLocalPaintStylesAsync");
		const texts = vi.spyOn(figma, "getLocalTextStylesAsync");
		const variables = vi.spyOn(figma.variables, "getLocalVariablesAsync");
		const result = await run(`return pi.lint("1:1", { rules: ["no-text-style"] });`, figma);
		expect(result.categories.map((category: { rule: string }) => category.rule)).toEqual(["no-text-style"]);
		expect(paints).not.toHaveBeenCalled();
		expect(texts).not.toHaveBeenCalled();
		expect(variables).not.toHaveBeenCalled();
	});

	it("pi.analyzeComponentSet gives the variant axes and the CSS state of each variant", async () => {
		const result = await run(`return pi.analyzeComponentSet("2:0");`, buttons());
		expect(result.variantAxes).toEqual({ State: ["Default", "Hover"] });
		expect(result.stateMachine.cssMapping).toEqual({ Hover: ":hover" });
	});

	it("pi.auditAccessibility reads only the first 20 text color pairs that its simulations use", async () => {
		const figma = buttons();
		const normal = (await figma.getNodeByIdAsync("2:1")) as Record<string, unknown>;
		const fillsRead: number[] = [];
		normal.children = Array.from({ length: 100 }, (_, index) => ({
			id: `3:${index}`,
			name: `Label ${index}`,
			type: "TEXT",
			parent: normal,
			get fills() {
				fillsRead.push(index);
				return [solid(1)];
			},
		}));
		const result = await run(`return pi.auditAccessibility("2:0");`, figma);
		expect(result.colorBlindSimulation.simulations.map((simulation: { pairsChecked: number }) => simulation.pairsChecked)).toEqual([
			20, 20, 20,
		]);
		expect(fillsRead).toHaveLength(20);
		expect(fillsRead.at(-1)).toBe(19);
	});

	it("pi.auditAccessibility finds the missing focus state and the small target", async () => {
		const result = await run(`return pi.auditAccessibility(await figma.getNodeByIdAsync("2:0"));`, buttons());
		expect(result.variantCoverage.missing).toContain("focus");
		expect(result.targetSize.issues.map((issue: { variant: string }) => issue.variant)).toEqual(["State=Default", "State=Hover"]);
	});

	describe("fixes in FigPal's copy", () => {
		const rgb = (r: number, g: number, b: number, opacity = 1) => ({ type: "SOLID", visible: true, opacity, color: { r, g, b } });

		/** A frame with one text node. */
		function textOn(text: Record<string, unknown>) {
			const figma = tree();
			const frame = figma.currentPage.children[0] as Record<string, unknown>;
			const label = { id: "1:2", name: "Label", type: "TEXT", visible: true, parent: frame, fontSize: 14, fontWeight: 400, characters: "Read more", ...text };
			frame.children = [label];
			return { ...figma, getNodeByIdAsync: async (id: string) => ({ "1:1": frame, "1:2": label })[id] ?? null };
		}

		/** A component set. Each variant: its name and fill; the first is not the default one. */
		function componentSet(name: string, variants: { name: string; fills: unknown[]; strokes?: unknown[]; width?: number; height?: number }[]) {
			// As in Figma: the variant properties of the set, from the names "Axis=Value, ...".
			const axes: Record<string, string[]> = {};
			for (const variant of variants)
				for (const pair of variant.name.split(",")) {
					const [axis, value] = pair.split("=").map((part) => part.trim()) as [string, string];
					axes[axis] = [...new Set([...(axes[axis] ?? []), value])];
				}
			const componentPropertyDefinitions = Object.fromEntries(
				Object.entries(axes).map(([axis, options]) => [axis, { type: "VARIANT", defaultValue: options[0], variantOptions: options }]),
			);
			const set: Record<string, unknown> = { id: "2:0", name, type: "COMPONENT_SET", visible: true, componentPropertyDefinitions, findAllWithCriteria: () => [] };
			const nodes: Record<string, unknown> = { "2:0": set };
			set.children = variants.map((variant, index) => {
				const node = { id: `2:${index + 1}`, type: "COMPONENT", visible: true, parent: set, strokes: [], effects: [], children: [], width: 80, height: 40, ...variant };
				nodes[node.id] = node;
				return node;
			});
			const page = { id: "0:1", name: "Page 1", type: "PAGE", children: [set], selection: [] };
			set.parent = page;
			return { ...tree(), currentPage: page, getNodeByIdAsync: async (id: string) => nodes[id] ?? null };
		}

		const lintRules = async (figma: ReturnType<typeof tree>, rules: string[], node = "1:1") => {
			const result = await run(`return pi.lint(${JSON.stringify(node)}, { rules: ${JSON.stringify(rules)} });`, figma);
			return Object.fromEntries(result.categories.map((category: { rule: string; nodes: unknown[] }) => [category.rule, category.nodes]));
		};

		// APCA (WCAG 3 draft method): the font table of apca-w3 gives the smallest size for each weight at the contrast.
		// Gray 0.45 on white: 4.76:1 passes WCAG 2; Lc 73 needs 19 px at weight 400.
		it("pi.lint checks text contrast with APCA as well, by default, for the size and weight of the text", async () => {
			const small = await lintRules(textOn({ fills: [rgb(0.45, 0.45, 0.45)], fontSize: 16, fontWeight: 400 }), ["wcag"]);
			expect(small["wcag-contrast"]).toBeUndefined();
			expect(small["apca-contrast"]).toEqual([{ id: "1:2", name: "Label", lc: "Lc 73", required: "19 px at weight 400", fg: "#737373", bg: "#FFFFFF" }]);
			const large = await lintRules(textOn({ fills: [rgb(0.45, 0.45, 0.45)], fontSize: 20, fontWeight: 400 }), ["apca-contrast"]);
			expect(large["apca-contrast"]).toBeUndefined();
			const faint = await lintRules(textOn({ fills: [rgb(0.9, 0.9, 0.9)], fontSize: 40, fontWeight: 700 }), ["apca-contrast"]);
			expect(faint["apca-contrast"]).toMatchObject([{ required: "not for text" }]);
		});

		// APCA keeps its sign: negative for light text on a dark background.
		it("pi.lint gives the APCA contrast of light text on dark as a negative value", async () => {
			const figma = textOn({ fills: [rgb(1, 1, 1)], fontSize: 12, fontWeight: 400 });
			(figma.currentPage.children[0] as Record<string, unknown>).fills = [rgb(0, 0, 0)];
			const rules = await lintRules(figma, ["apca-contrast"]);
			expect(rules["apca-contrast"]).toMatchObject([{ lc: "Lc -107", required: "14.5 px at weight 400" }]);
		});

		// At the limit, the known standard gets the last place. Gray 0.5 at 16 px fails both.
		it("pi.lint checks WCAG 2 before APCA", async () => {
			const result = await run(`return pi.lint("1:1", { rules: ["wcag"], maxFindings: 1 });`, textOn({ fills: [rgb(0.5, 0.5, 0.5)], fontSize: 16 }));
			expect(result.categories.map((category: { rule: string }) => category.rule)).toEqual(["wcag-contrast"]);
		});

		// FigPal's lint request is not inside figma_execute: without a limit, a long lint blocks the other requests.
		it("pi.lint stops at its time limit and says how far it got", async () => {
			const result = await run(`return pi.lint("1:1", { timeLimitMs: 0 });`, textOn({ fills: [rgb(0.5, 0.5, 0.5)] }));
			expect(result).toMatchObject({ nodesScanned: 0, categories: [], warning: "Stopped after 0 s, after 0 layers. Check a smaller part, such as one frame." });
		});

		it("pi.lint treats text of at least 18.66 px and weight 700 as large text (3:1)", async () => {
			// Gray 0.5 on white is about 4:1: enough for large text, too little for normal text.
			const bold = await lintRules(textOn({ fills: [rgb(0.5, 0.5, 0.5)], fontSize: 20, fontWeight: 700 }), ["wcag-contrast"]);
			expect(bold["wcag-contrast"]).toBeUndefined();
			const regular = await lintRules(textOn({ fills: [rgb(0.5, 0.5, 0.5)], fontSize: 20, fontWeight: 400 }), ["wcag-contrast"]);
			expect(regular["wcag-contrast"]).toHaveLength(1);
		});

		it("pi.lint checks the color that shows: black text at 10 % opacity on white fails", async () => {
			const faint = await lintRules(textOn({ fills: [rgb(0, 0, 0, 0.1)] }), ["wcag-contrast"]);
			expect(faint["wcag-contrast"]).toMatchObject([{ id: "1:2", fg: "#E6E6E6", bg: "#FFFFFF" }]);
		});

		// Blue text at 50 % opacity on black shows at about 1.8:1. The audit used the opaque color (4.6:1), and so it
		// reported a loss of contrast for color blindness, not the failure.
		it("pi.auditAccessibility checks the color that shows", async () => {
			const figma = componentSet("Badge", [{ name: "Type=Info", fills: [] }]);
			const variant = (await figma.getNodeByIdAsync("2:1")) as Record<string, unknown>;
			const set = (await figma.getNodeByIdAsync("2:0")) as Record<string, unknown>;
			set.fills = [rgb(0, 0, 0)];
			variant.children = [{ id: "2:9", name: "Label", type: "TEXT", visible: true, parent: variant, fills: [rgb(0, 0.45, 0.9, 0.5)] }];
			const audit = await run(`return pi.auditAccessibility("2:0");`, figma);
			expect(audit.colorBlindSimulation.issues).toEqual([]);
		});

		it("pi.lint checks borders and fills of controls with the color that shows", async () => {
			const figma = tree();
			Object.assign(figma.currentPage.children[0] as object, { name: "Button", fills: [], strokes: [rgb(0, 0, 0, 0.2)] });
			const lint = await lintRules(figma, ["wcag-non-text-contrast"]);
			expect(lint["wcag-non-text-contrast"]).toMatchObject([{ element: "stroke", component: "#CCCCCC" }]);
		});

		it("pi.auditAccessibility checks the focus ring with the color that shows", async () => {
			const figma = componentSet("Button", [
				{ name: "State=Default", fills: [rgb(0, 0, 1)] },
				{ name: "State=Focus", fills: [rgb(0, 0, 1)], strokes: [rgb(0, 0, 0, 0.2)] },
			]);
			const audit = await run(`return pi.auditAccessibility("2:0");`, figma);
			expect(audit.focusIndicator.contrastRatio).toBe(1.6);
		});

		it("pi.lint refuses a rule that it does not know, instead of a clean result", async () => {
			await expect(run(`return pi.lint("1:1", { rules: ["wcga"] });`)).rejects.toThrow('Unknown lint rule "wcga"');
		});

		it("pi.lint and pi.auditAccessibility compare an error state with the default variant, not with the first child", async () => {
			const figma = componentSet("Input", [
				{ name: "State=Error", fills: [rgb(1, 0, 0)] },
				{ name: "State=Default", fills: [rgb(0, 0, 1)] },
			]);
			const lint = await lintRules(figma, ["wcag-color-only"], "2:0");
			expect(lint["wcag-color-only"]).toMatchObject([{ id: "2:1" }]);
			const audit = await run(`return pi.auditAccessibility("2:0");`, figma);
			expect(audit.colorDifferentiation.issues).toMatchObject([{ variant: "State=Error", defaultColor: "#0000FF" }]);
		});

		// "Size=Base" is not a resting state, and "Enabled" is one.
		it("pi.lint and pi.auditAccessibility find the default variant by whole state values", async () => {
			const figma = componentSet("Input", [
				{ name: "Size=Base, State=Error", fills: [rgb(1, 0, 0)] },
				{ name: "Size=Base, State=Enabled", fills: [rgb(0, 0, 1)] },
			]);
			const lint = await lintRules(figma, ["wcag-color-only"], "2:0");
			expect(lint["wcag-color-only"]).toMatchObject([{ id: "2:1", defaultColor: "#0000FF" }]);
			const audit = await run(`return pi.auditAccessibility("2:0");`, figma);
			expect(audit.colorDifferentiation.issues).toMatchObject([{ variant: "Size=Base, State=Error", defaultColor: "#0000FF" }]);
		});

		it("pi.auditAccessibility keeps a badge with a status axis presentational", async () => {
			const figma = componentSet("Badge", [
				{ name: "Status=Active", fills: [rgb(0, 0.5, 0)] },
				{ name: "Status=Inactive", fills: [rgb(0.5, 0.5, 0.5)] },
			]);
			const audit = await run(`return pi.auditAccessibility("2:0");`, figma);
			expect(audit.component.classification).toBe("presentational");
		});

		it("pi.analyzeComponentSet reads variant names without a space after the comma", async () => {
			const figma = componentSet("Button", [
				{ name: "Size=Small,State=Default", fills: [rgb(0, 0, 1)] },
				{ name: "Size=Small,State=Hover", fills: [rgb(0, 0, 0.8)] },
			]);
			const result = await run(`return pi.analyzeComponentSet("2:0");`, figma);
			expect(result.variants.map((variant: { state: string }) => variant.state)).toEqual(["Default", "Hover"]);
			expect(result.stateMachine.cssMapping).toEqual({ Hover: ":hover" });
		});

		it("pi.analyzeComponentSet says when a variant removes the fill of the default variant", async () => {
			const figma = componentSet("Button", [
				{ name: "State=Default", fills: [rgb(1, 1, 1)] },
				{ name: "State=Disabled", fills: [] },
			]);
			const result = await run(`return pi.analyzeComponentSet("2:0");`, figma);
			expect(result.variants[1].diffFromDefault).toMatchObject({ fillHex: null });
		});

		it("pi.auditAccessibility treats a component with an interaction axis or a button name in a folder as interactive", async () => {
			const figma = componentSet("Controls/Button", [
				{ name: "Interaction=Default", fills: [rgb(0, 0, 1)], width: 20, height: 20 },
				{ name: "Interaction=Focus", fills: [rgb(0, 0, 1)], width: 20, height: 20 },
			]);
			const result = await run(`return pi.auditAccessibility("2:0");`, figma);
			expect(result.component.classification).toBe("interactive");
			expect(result.targetSize.issues).toHaveLength(2);
		});

		it("pi.lint lets timers run during a large scan", async () => {
			const figma = tree();
			const frame = figma.currentPage.children[0] as Record<string, unknown>;
			const order: string[] = [];
			frame.children = Array.from({ length: 3000 }, (_, index) => ({
				id: `4:${index}`,
				type: "RECTANGLE",
				parent: frame,
				get name() {
					if (index === 2999) order.push("last node");
					return "Box";
				},
			}));
			setTimeout(() => order.push("timer"), 0);
			await run(`return pi.lint("1:1", { rules: ["default-name"] });`, figma);
			expect(order).toEqual(["timer", "last node"]);
		});
	});
});
