// Token export: the local variables of the file, as design tokens in a format for code. The converter and the
// formatters are copied from figma-console-mcp (vendor/figma-console-mcp/tokens). The export is read-only, so the chat
// can run it again without the agent after a restart.

import { type Static, Type } from "@earendil-works/pi-ai";
import type { Attachment } from "@figpal/shared";
import type { Bridge } from "./bridge";
import { filesNote } from "./files";
import { literals } from "./schema";
import { type FigmaVariablesPayload, convertFigmaVariablesToDocument } from "./vendor/figma-console-mcp/tokens/figma-converter";
import { format } from "./vendor/figma-console-mcp/tokens/formatters/index";

/** The parameters of figma_export_tokens. Less is not offered: upstream has only a stub. */
export const TOKEN_EXPORT = Type.Object({
	format: literals([
		"dtcg",
		"tokens-studio",
		"css-vars",
		"tailwind-v4",
		"tailwind-v3",
		"scss",
		"ts-module",
		"json-flat",
		"json-nested",
		"style-dictionary-v3",
	] as const),
	collections: Type.Optional(Type.Array(Type.String(), { description: "Names or IDs. Default: all." })),
	modes: Type.Optional(Type.Array(Type.String(), { description: "Mode names. Default: all." })),
	prefix: Type.Optional(Type.String({ description: "Goes before each name in css-vars, scss, tailwind-v4, json-flat and ts-module." })),
	split_by_mode: Type.Optional(Type.Boolean({ description: "One file for each mode: dtcg, tokens-studio, css-vars, tailwind-v4, scss, style-dictionary-v3." })),
	split_by_collection: Type.Optional(Type.Boolean()),
	dtcg_dialect: Type.Optional(literals(["legacy", "2025"] as const)),
});
export type TokenExport = Static<typeof TOKEN_EXPORT>;

/** The model gets the start of the first file, to describe it. */
const PREVIEW_CHARS = 2000;
const MAX_WARNINGS = 20;

const MIME: Record<string, string> = { json: "application/json", css: "text/css", scss: "text/x-scss", js: "text/javascript", ts: "text/typescript" };

/** The item of `all` with this name, without case. */
const byName = <T extends { name: string }>(all: T[], name: string) => all.find((item) => item.name.toLowerCase() === name.toLowerCase());

export async function exportTokens(bridge: Pick<Bridge, "request">, args: TokenExport) {
	const { result } = await bridge.request("variables", {});
	if (!result.variables.length) throw new Error("The file has no local variables to export.");
	const warnings: string[] = [];
	// The token formats cannot express a collection that keeps only its changes to another one.
	const extended = result.collections.filter((collection) => collection.isExtension);
	const all = result.collections.filter((collection) => !collection.isExtension);
	if (!args.collections)
		for (const collection of extended) warnings.push(`Extended collection "${collection.name}" was not exported: the token formats cannot express it.`);

	let collections = (args.collections ?? all.map((c) => c.id)).map((wanted) => {
		const found = all.find((c) => c.id === wanted) ?? byName(all, wanted);
		if (found) return found;
		const parent = extended.find((c) => c.id === wanted) ?? byName(extended, wanted);
		if (parent)
			throw new Error(`"${parent.name}" is an extended collection. The token formats cannot express it: export the collection that it extends.`);
		throw new Error(`No collection "${wanted}". The collections are: ${all.map((c) => c.name).join(", ")}.`);
	});
	// The converter compares mode names exactly: use the names in the file.
	const modeNames = [...new Set(collections.flatMap((c) => c.modes.map((mode) => mode.name)))];
	const modes = args.modes?.map((wanted) => {
		const found = modeNames.find((name) => name.toLowerCase() === wanted.toLowerCase());
		if (!found) throw new Error(`No mode "${wanted}". The modes are: ${modeNames.join(", ")}.`);
		return found;
	});
	if (modes) {
		const without = collections.filter((c) => !c.modes.some((mode) => modes.includes(mode.name)));
		for (const c of without) warnings.push(`Collection "${c.name}" has none of the modes ${modes.join(", ")}: it was not exported.`);
		collections = collections.filter((c) => !without.includes(c));
	}

	// The protocol type is wider than the converter's types: code.js gives Figma's values as they are.
	const payload = { collections: all, variables: result.variables } as unknown as FigmaVariablesPayload;
	// No `stripPrefix`, unlike upstream: it removes the prefix as plain text, so "c" makes "color/primary" "olor/primary".
	const converted = convertFigmaVariablesToDocument(payload, { collectionIds: collections.map((c) => c.id), modes });
	warnings.push(...converted.warnings);
	const document = converted.document;
	const tokens = document.sets.reduce((count, set) => count + set.tokens.length, 0);
	if (!tokens) throw new Error("No tokens match the collections and modes.");

	const formatted = format(document, {
		target: {
			format: args.format,
			prefix: args.prefix,
			splitByMode: args.split_by_mode,
			splitByCollection: args.split_by_collection,
			dtcgDialect: args.dtcg_dialect,
		},
	});
	// Formatters warn once for each token and mode: keep each message once.
	for (const warning of formatted.warnings) if (!warnings.includes(warning)) warnings.push(warning);
	const encoder = new TextEncoder();
	const files: Attachment[] = formatted.files.map((file) => ({
		// A download has no folders.
		name: file.path.replaceAll("/", "-"),
		mime: MIME[file.path.split(".").pop() ?? ""] ?? "text/plain",
		bytes: encoder.encode(file.content),
	}));

	const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
	const first = formatted.files[0]?.content ?? "";
	const summary = [
		`Exported ${plural(tokens, "token")} from ${plural(document.sets.length, "collection")} as ${args.format}. ${filesNote(files.map((file) => ({ name: file.name, size: file.bytes.length })))}`,
		...(warnings.length
			? [`Warnings:\n${warnings.slice(0, MAX_WARNINGS).join("\n")}${warnings.length > MAX_WARNINGS ? `\n… and ${warnings.length - MAX_WARNINGS} more` : ""}`]
			: []),
		`Start of ${files[0]?.name}:\n${first.slice(0, PREVIEW_CHARS)}${first.length > PREVIEW_CHARS ? "\n…" : ""}`,
	].join("\n\n");
	return { files, summary };
}
