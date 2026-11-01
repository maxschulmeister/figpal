// Lint: the checks of figma-console-mcp (plugin/src/vendor/figma-console-mcp/checks.js) on the layers of the open file,
// with APCA, the contrast method of the WCAG 3 drafts. The chat shows a pill for each rule: a click selects its layers.

import { type Static, Type } from "@earendil-works/pi-ai";
import type { Bridge } from "./bridge";
import { nodeIdOf } from "./schema";

/** The parameters of figma_lint. */
export const LINT = Type.Object({
	node_id: Type.Optional(Type.String({ description: "Default: the current page." })),
	rules: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Groups: "wcag" (WCAG 2 and APCA), "best-practice", "design-system", "layout", "all"; or rule IDs from an earlier result. Default: wcag, design-system and layout.',
		}),
	),
	max_findings: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 500, description: "Default 200. A text that fails both contrast checks counts twice." }),
	),
});

/** Layers that the user can select from a step of the chat. */
export type PillDetails = { pills: { label: string; nodeIds: string[] }[] };

/** Short names of the rules, for the pills. */
const LABELS: Record<string, string> = {
	"wcag-contrast": "Contrast (WCAG 2)",
	"apca-contrast": "Contrast (APCA)",
	"wcag-text-size": "Small text",
	"wcag-target-size": "Small target",
	"wcag-line-height": "Tight line height",
	"wcag-non-text-contrast": "Non-text contrast",
	"wcag-color-only": "Color only",
	"wcag-focus-indicator": "No focus state",
	"wcag-letter-spacing": "Tight letter spacing",
	"wcag-paragraph-spacing": "Tight paragraph spacing",
	"wcag-image-alt": "No alt text",
	"wcag-heading-hierarchy": "Skipped heading level",
	"wcag-reflow": "No reflow",
	"wcag-reading-order": "Reading order",
	"wcag-disabled-no-context": "Disabled without reason",
	"token-misuse": "Wrong token",
	"hardcoded-color": "Color without variable",
	"no-text-style": "No text style",
	"default-name": "Default name",
	"detached-component": "Detached component",
	"no-autolayout": "No auto layout",
	"empty-container": "Empty container",
};

/** Lints the layers. The model gets the findings as JSON: names are data of the file, and JSON quotes them. */
export async function lint(bridge: Pick<Bridge, "request">, { node_id, rules, max_findings }: Static<typeof LINT>) {
	const nodeId = node_id && nodeIdOf(node_id);
	// Upstream's default is 100. A text that fails both contrast checks takes 2 places.
	const { result } = await bridge.request("lint", { nodeId, rules, maxFindings: max_findings ?? 200 });
	const pills = result.categories.map((category) => ({
		label: LABELS[category.rule] ?? category.rule,
		// One rule can find a layer twice, for example in two fills.
		nodeIds: [...new Set(category.nodes.map((node) => node.id))],
	}));
	return { report: JSON.stringify(result), details: { pills } satisfies PillDetails };
}
