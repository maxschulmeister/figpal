// Types of checks.js. The results are JSON for the model.

import type { LintResult } from "@figpal/shared";

/** Variant axes, states, CSS mapping and the changes of each variant. Needs a component set. */
export function analyzeComponentSet(options: { nodeId: string }): Promise<unknown>;

/** Accessibility and design-system findings by rule. Without nodeId: the current page. */
export function lintDesign(options: {
	nodeId?: string;
	rules?: string[];
	maxDepth?: number;
	maxFindings?: number;
	/** FigPal: stop the walk after this time, with a warning. */
	timeLimitMs?: number;
}): Promise<LintResult>;

/** An accessibility score of a component set. Without nodeId: the single selected node. */
export function auditComponentAccessibility(options: { nodeId?: string; targetSize?: number }): Promise<unknown>;
