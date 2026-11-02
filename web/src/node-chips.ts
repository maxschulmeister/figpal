// Node chips: when the user selects layers in Figma while typing, the composer puts a chip into the text. The text
// keeps each chip as an assistant-ui directive, `:node{label="…" name="<JSON of the page and nodes>"}`. Quote chips
// (Reply) work the same way: `:quote{label="…" name="{\"quote\":…}"}`.

import { defaultDirectiveFormatter, type TriggerItem } from "@assistant-ui/react";
import type { NodeSummary } from "@figpal/shared";
import { nodeIdOf } from "./schema";

export const CHIP_TYPE = "node";
export const QUOTE_TYPE = "quote";

/** `nodes`: at most 50 (code.js sends no more). `count`: all selected nodes. */
type Chip = { page: NodeSummary; nodes: NodeSummary[]; count: number };

export type ChipSegment =
	| { kind: "text"; text: string }
	| ({ kind: "chip"; label: string } & Chip)
	| { kind: "quote"; label: string; text: string };

/** The plural of a node type: "Frames" for FRAME, "Component sets" for COMPONENT_SET. */
function typePlural(type: string): string {
	if (type === "TEXT") return "Text layers";
	const words = type.toLowerCase().replaceAll("_", " ");
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}s`;
}

/**
 * The chip of a selection on a page: the name of one node, "2 Frames" for nodes of one type, else "5 Nodes". The types
 * of nodes that code.js did not send are not known, so a larger selection is "300 Nodes".
 */
export function chipItem(nodes: NodeSummary[], page: NodeSummary, count = nodes.length): TriggerItem {
	const types = new Set(nodes.map((node) => node.type));
	const label =
		count === 1 ? shorten(nodes[0]!.name) : `${count} ${types.size === 1 && count === nodes.length ? typePlural(nodes[0]!.type) : "Nodes"}`;
	// assistant-ui reads at most 1024 characters of a directive's label and of its name, so the chip keeps the nodes that
	// fit. The model gets the count of the others.
	const data = { page: short(page), nodes: nodes.map(short), count };
	while (JSON.stringify(data).length > MAX_DATA) data.nodes.pop();
	return { id: JSON.stringify(data), type: CHIP_TYPE, label };
}

const MAX_DATA = 1024;
const MAX_NAME = 40;
/** Figma names a text layer with its text. */
const shorten = (name: string) => (name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name);
const short = (node: NodeSummary) => ({ ...node, name: shorten(node.name) });

const isNode = (value: unknown): value is NodeSummary =>
	typeof value === "object" &&
	value !== null &&
	["id", "name", "type"].every((key) => typeof (value as Record<string, unknown>)[key] === "string");

/** The page and nodes of a chip. Undefined for a directive that is not a chip: the user can type one. */
export function readChip(id: string): Chip | undefined {
	let value: unknown;
	try {
		value = JSON.parse(id);
	} catch {
		return undefined;
	}
	const { page, nodes, count } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
	if (!isNode(page) || !Array.isArray(nodes) || nodes.length === 0 || !nodes.every(isNode)) return undefined;
	// Chips of earlier versions have no count.
	return { page, nodes, count: typeof count === "number" ? count : nodes.length };
}

/** assistant-ui reads at most 1,024 characters of a directive's name: a longer quote stays Markdown text. */
const MAX_QUOTE = 900;
const MAX_QUOTE_LABEL = 60;

/**
 * The chip of a quote, or undefined when it is too long for a chip. The ID is JSON: the name of a directive can have a
 * line break only in its quoted form, which assistant-ui uses for an ID with "}".
 */
export function quoteItem(text: string): TriggerItem | undefined {
	if (text.length > MAX_QUOTE) return undefined;
	const line = text.replace(/\s+/g, " ").trim();
	const label = line.length > MAX_QUOTE_LABEL ? `${line.slice(0, MAX_QUOTE_LABEL - 1)}…` : line;
	return { id: JSON.stringify({ quote: text }), type: QUOTE_TYPE, label };
}

/** The text as Markdown quote lines. */
export const quoteLines = (text: string) =>
	text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");

function readQuote(id: string): string | undefined {
	try {
		const quote = (JSON.parse(id) as { quote?: unknown } | null)?.quote;
		return typeof quote === "string" ? quote : undefined;
	} catch {
		return undefined;
	}
}

/** The text and the chips of a message, in order. */
export function chipSegments(text: string): ChipSegment[] {
	return defaultDirectiveFormatter.parse(text).map((segment) => {
		if (segment.kind === "text") return segment;
		const chip = segment.type === CHIP_TYPE ? readChip(segment.id) : undefined;
		if (chip) return { kind: "chip", label: segment.label, ...chip };
		const quote = segment.type === QUOTE_TYPE ? readQuote(segment.id) : undefined;
		if (quote !== undefined) return { kind: "quote", label: segment.label, text: quote };
		return { kind: "text", text: defaultDirectiveFormatter.serialize(segment) };
	});
}

/** "1:2", "1-2" from a Figma link, or "I1:5;3:4" for a layer in an instance. */
const NODE_ID = /^I?\d+[:-]\d+(;\d+[:-]\d+)*$/;
const LINK = "#node=";
/** A model links a few layers. Longer lists are not layer links: code.js looks up each ID. */
const MAX_LINK_IDS = 200;

/**
 * The node IDs of a layer link in an answer of the agent, `[Card](#node=1:2,1:3)`. Undefined for other links. A
 * fragment, because the Markdown renderer removes links with an unknown scheme.
 */
export function nodeIdsOfLink(href: string | undefined): string[] | undefined {
	if (!href?.startsWith(LINK)) return undefined;
	const ids = href.slice(LINK.length).split(",", MAX_LINK_IDS + 1);
	if (ids.length > MAX_LINK_IDS || !ids.every((id) => NODE_ID.test(id))) return undefined;
	return [...new Set(ids.map(nodeIdOf))];
}

/** A name without < and >, so it cannot close a tag. */
export const clean = (name: string) => name.replace(/[<>]/g, "");

export const describeNode = (node: NodeSummary) => `${clean(node.name)} (${node.type}, ${node.id})`;

/**
 * The text for the model: each chip becomes a <nodes> tag with its page and nodes, at its place in the text, and each
 * quote Markdown quote lines on their own lines.
 */
export function chipsForModel(text: string): string {
	return chipSegments(text)
		.map((segment, index, all) => {
			if (segment.kind === "text") return segment.text;
			if (segment.kind === "quote") {
				// A quote starts a line.
				const previous = all[index - 1];
				const atLineStart = !previous || previous.kind === "quote" || (previous.kind === "text" && previous.text.endsWith("\n"));
				const before = atLineStart ? "" : "\n";
				// One empty line after it, also when the text after it starts a line.
				const next = all[index + 1];
				const after = next?.kind === "text" && next.text.startsWith("\n") ? "\n" : "\n\n";
				return `${before}${quoteLines(segment.text)}${after}`;
			}
			const more = segment.count > segment.nodes.length ? `, and ${segment.count - segment.nodes.length} more` : "";
			const nodes = segment.nodes.map(describeNode).join(", ");
			return `<nodes page="${clean(segment.page.name)} (${segment.page.id})">${nodes}${more}</nodes>`;
		})
		.join("");
}

/** The text with the labels of the chips, for a thread title. */
export function chipLabels(text: string): string {
	return chipSegments(text)
		.map((segment) => (segment.kind === "text" ? segment.text : segment.kind === "quote" ? `“${segment.label}”` : segment.label))
		.join("");
}
