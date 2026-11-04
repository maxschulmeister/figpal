// Design-system audit: the scoring of figma-console-mcp (vendor/figma-console-mcp/audit) on the local variables,
// components and styles that code.js reads. No REST calls and no cache: each call scores the file as it is now. The
// report text is adapted from upstream's figma_audit_design_system_report (src/apps/design-system-dashboard/server.ts).

import { obj, opt, type Static } from "@earendil-works/pi-schema";
import type { Bridge } from "./bridge";
import type { PillDetails } from "./lint";
import { literals } from "./schema";
import { scoreDesignSystem } from "./vendor/figma-console-mcp/audit/engine";
import { describeFixability, getRemediation } from "./vendor/figma-console-mcp/audit/remediation";
import { type CategoryScore, type DashboardData, type Finding, getStatus } from "./vendor/figma-console-mcp/audit/types";

const CATEGORIES = [
	"naming-semantics",
	"token-architecture",
	"component-metadata",
	"accessibility",
	"consistency",
	"coverage",
] as const;

/** The parameters of figma_audit_design_system. */
export const AUDIT = obj(
	{ category: opt(literals(CATEGORIES, { description: "Its findings, with examples, locations and fixes. Default: a summary of all." })) },
	{ open: true },
);

/** The status of the overall score, for the report and the chat. */
export const STATUS_LABELS: Record<DashboardData["status"], string> = { good: "Good", "needs-work": "Needs work", poor: "Poor" };

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The scores for the chat, with upstream's short labels. Null: no data. */
export type AuditDetails = {
	audit: { overall: number; status: DashboardData["status"]; categories: { label: string; score: number | null }[] };
};

/** The scores without the checks that had no data. A category without other checks has no score (null). */
type Scored = Omit<DashboardData, "categories"> & { categories: (Omit<CategoryScore, "score"> & { score: number | null })[] };

/**
 * Upstream counts checks without data ("info", such as "No color variables to evaluate"), mostly as 100: an empty file
 * scored 62/100. Here they do not count, and a category without other checks does not count in the overall score.
 */
function withoutEmptyChecks(scored: DashboardData): Scored {
	const categories = scored.categories.map((category) => {
		const checked = category.findings.filter((finding) => finding.severity !== "info");
		const score = checked.length ? Math.round(checked.reduce((sum, finding) => sum + finding.score, 0) / checked.length) : null;
		return { ...category, score };
	});
	let total = 0;
	let weight = 0;
	for (const category of categories) {
		if (category.score === null) continue;
		total += category.score * category.weight;
		weight += category.weight;
	}
	// Without variables, the token checks fail: some category always counts.
	const overall = Math.round(total / weight);
	return { ...scored, overall, status: getStatus(overall), categories };
}

/** The fix of a finding, without upstream's tool names: FigPal fixes with figma_execute. */
function fix(id: string) {
	const remediation = getRemediation(id);
	return remediation && { fixability: describeFixability(remediation.fixability), how: remediation.how };
}

/** The summary: what was read, the scores, the findings that do not pass, the top actions and the fixes. */
function summary(scored: Scored, fileName: string): string {
	const { meta } = scored;
	const lines = [
		`Design system: ${fileName}. Overall health: ${scored.overall}/100 (${STATUS_LABELS[scored.status].toLowerCase()}).`,
		`Read: ${count(meta.componentSetCount, "component set")} (${count(meta.variantCount, "variant")}), ${count(meta.standaloneCount, "component")}, ${count(meta.variableCount, "variable")} in ${count(meta.collectionCount, "collection")}, ${count(meta.styleCount, "style")}.`,
		"Checks without data do not count.",
	];
	const open: Finding[] = [];
	for (const category of scored.categories) {
		const score = category.score === null ? "no data" : `${category.score}/100, weight ${category.weight}`;
		lines.push("", `${category.label} (${category.id}): ${score}`);
		for (const finding of category.findings) {
			if (finding.severity === "pass") continue;
			if (finding.severity !== "info") open.push(finding);
			lines.push(`  [${finding.severity.toUpperCase()}] ${finding.label} (${finding.score}): ${finding.details ?? ""}`);
			// Names are data of the file: in quotes, a name cannot add lines to the report.
			if (finding.examples?.length) lines.push(`    e.g. ${finding.examples.slice(0, 3).map((name) => JSON.stringify(name)).join(", ")}`);
		}
	}
	if (scored.summary.length) lines.push("", "Top actions:", ...scored.summary.map((action) => `  - ${action}`));
	const fixes = open.flatMap((finding) => {
		const found = fix(finding.id);
		return found ? [`  - ${finding.label}: ${found.fixability}. ${found.how}`] : [];
	});
	if (fixes.length) lines.push("", "Fixes:", ...fixes, "  Ask the user before a fix that needs a design decision.");
	lines.push("", "For all findings of one category, with examples, locations and fixes, call again with category.");
	return lines.join("\n");
}

/** Scores the open file. Without a category: the summary and the scores for the chat. */
export async function auditDesignSystem(
	bridge: Pick<Bridge, "request">,
	{ category }: Static<typeof AUDIT>,
): Promise<{ report: string; details?: AuditDetails & PillDetails }> {
	const [{ result: variables }, { result: components }] = await Promise.all([
		bridge.request("variables", {}),
		bridge.request("components", {}),
	]);
	// node_id: upstream's name for the node of a component in its findings.
	const withNodeId = <T extends { id: string }>(items: T[]) => items.map((item) => ({ ...item, node_id: item.id }));
	if (!components.components.length && !components.componentSets.length && !variables.variables.length)
		return {
			report: `Nothing to audit: ${components.fileName} has no local components and no local variables. The audit scores the file of a design-system library. To check the layers of this file (colors without variables, text without a text style, contrast), use figma_lint.`,
		};
	const scored = withoutEmptyChecks(scoreDesignSystem({
		variables: variables.variables,
		collections: variables.collections,
		components: withNodeId(components.components),
		componentSets: withNodeId(components.componentSets),
		styles: components.styles,
	}));
	if (category) {
		const found = scored.categories.find((item) => item.id === category);
		if (!found) throw new Error(`Unknown category ${category}`);
		const findings = found.findings.map((finding) => ({
			...finding,
			examples: finding.examples?.slice(0, 5),
			locations: finding.locations?.slice(0, 10),
			remediation: fix(finding.id),
		}));
		return { report: JSON.stringify({ file: components.fileName, overall: scored.overall, category: { ...found, findings } }) };
	}
	const categories = scored.categories.map(({ shortLabel, score }) => ({ label: shortLabel, score }));
	// The components of each finding that does not pass. Variables are not layers: the user cannot select them.
	const pills = scored.categories.flatMap((category) =>
		category.findings.flatMap((finding) => {
			const nodeIds = (finding.locations ?? []).flatMap((location) => (location.nodeId ? [location.nodeId] : []));
			return (finding.severity === "fail" || finding.severity === "warning") && nodeIds.length ? [{ label: finding.label, nodeIds }] : [];
		}),
	);
	const details = { audit: { overall: scored.overall, status: scored.status, categories }, pills };
	return { report: summary(scored, components.fileName), details };
}
