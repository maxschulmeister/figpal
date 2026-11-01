// The `figma` extension: tools that read and change the open file through code.js, and the rules for the model.

import { awaitWithContext } from "@earendil-works/chord/context";
import { type CredentialStore, type ImageContent, type Static, type TextContent, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type Attachment, EXECUTE_OUTPUT_LIMIT, EXECUTE_TIMEOUT_MS, EXPORT_FORMATS, SCREENSHOT_MAX_PX } from "@figpal/shared";
import type { Bridge } from "../bridge";
import { type FileDetails, filesNote, keepFiles } from "../files";
import { exportTokens, TOKEN_EXPORT } from "../tokens";

const RULES = `You are FigPal, an agent in a Figma plugin. You read and change the open Figma file.

Each user message starts with a <figma> block: the file and the current page. In the text, <nodes> marks the layers that the user selected at that point (name, type, ID): the text next to it is about them.

Tools:
- figma_execute runs Plugin API JavaScript. Keep each call small. Return the IDs of the nodes that you make or change.
- figma_screenshot shows a node. After a visual change, use it to check the result.
- figma_rest calls the Figma REST API with the user's token: comments, versions, and the components and styles of other files and libraries. For the open file, use the Plugin API.
- figma_export_tokens exports the local variables as design tokens (DTCG, CSS, Tailwind, ...), and figma_export_nodes exports layers as SVG, PDF, PNG or JPG. The user downloads the files from the step. Use them for files the user wants, not pi.attach: the user can download their files again later.

Plugin API rules:
- Pages load on demand. Use the async API: getNodeByIdAsync, setCurrentPageAsync, getMainComponentAsync. Call \`await page.loadAsync()\` before you read another page.
- Before you change text, load all its fonts with figma.loadFontAsync (figma.getRangeAllFontNames gives them). New text uses Inter Regular.
- Colors use the range 0 to 1, not 0 to 255.
- fills, strokes and effects are read-only arrays: copy, change the copy, then assign it.
- Auto layout: set layoutMode first. Append a child to its auto-layout parent before you set its layoutSizingHorizontal or layoutSizingVertical to "FILL". "HUG" works only on auto-layout frames and text.
- Images: \`const image = await figma.createImageAsync(url)\` loads a PNG, JPEG or GIF of at most 4096 px. Then set a fill { type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }.
- Put new top-level frames next to the existing content, not on top of it.
- Never call figma.closePlugin, figma.showUI or figma.ui: they stop FigPal.
- If a call fails, read the error and fix the code. A call that failed can have changed part of the file: check before you run it again.`;

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** The image types that models read. Other files, such as SVG, go to the user. */
const MODEL_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Image attachments go to the model as images. */
function images(attachments: Attachment[]): ImageContent[] {
	return attachments
		.filter((attachment) => MODEL_IMAGES.has(attachment.mime))
		.map((attachment) => ({ type: "image", data: toBase64(attachment.bytes), mimeType: attachment.mime }));
}

const text = (value: string): TextContent => ({ type: "text", text: value });

/** The parameters of figma_export_nodes. */
export const NODE_EXPORT = Type.Object({
	node_ids: Type.Array(Type.String(), { minItems: 1 }),
	format: Type.Unsafe<(typeof EXPORT_FORMATS)[number]>(Type.Union(EXPORT_FORMATS.map((name) => Type.Literal(name)))),
	scale: Type.Optional(Type.Number({ description: "PNG and JPG only. Default 1." })),
});

/** Exports the nodes as files. Read-only, so the chat can run it again without the agent. */
export async function exportNodes(bridge: Pick<Bridge, "request">, args: Static<typeof NODE_EXPORT>): Promise<Attachment[]> {
	const { attachments } = await bridge.request("export", { nodeIds: args.node_ids, format: args.format, scale: args.scale });
	return attachments;
}

const REST_API = "https://api.figma.com";
/** The answer of figma_rest is cut after this. The JSON of a whole file is often megabytes. */
const REST_OUTPUT_BYTES = 40_000;

export function figmaExtension(bridge: Pick<Bridge, "request">, credentials: Pick<CredentialStore, "read">) {
	return defineExtension({
		name: "figma",
		sections: [section("figma", () => RULES)],
		tools: [
			defineTool({
				name: "figma_execute",
				description: [
					"Runs Figma Plugin API JavaScript in the open file. The code is the body of an async function: use await,",
					`and \`return\` a JSON value. Nodes in the value become { id, name, type }. The output is cut after ${EXECUTE_OUTPUT_LIMIT.toLocaleString("en-US")} characters.`,
					"`pi.attach(bytes, { mime, name })` sends a PNG, JPEG, GIF or WebP image (for example from exportAsync) to you with the result; other files (SVG, PDF, ...) go to the user as downloads.",
					"Checks (node or ID; return their JSON):",
					'`pi.lint(node?, { rules?, maxFindings? })` finds accessibility (WCAG) and design-system problems; rules are "wcag", "design-system", "layout", "best-practice" or "all", default the first three; without node, the page.',
					"`pi.auditAccessibility(componentSet)` scores states, focus, target size and contrast loss under color-blind simulation. Use `pi.lint` for baseline text contrast.",
					"`pi.analyzeComponentSet(componentSet)` gives its variant axes, the CSS state of each variant, and what each variant changes.",
				].join(" "),
				parameters: Type.Object({
					code: Type.String(),
					timeout_ms: Type.Optional(
						Type.Number({ description: `Default ${EXECUTE_TIMEOUT_MS.default}, maximum ${EXECUTE_TIMEOUT_MS.max}.` }),
					),
				}),
				// When the run stops, stop the wait. code.js cannot stop the code, and it runs the next call after it.
				execute: async ({ code, timeout_ms }, _api, context) => {
					const request = bridge.request("execute", { code, timeoutMs: timeout_ms });
					const { result, attachments } = await awaitWithContext(request, context);
					const shown = images(attachments);
					const files = keepFiles(attachments.filter((attachment) => !MODEL_IMAGES.has(attachment.mime)));
					const note = files.length ? `\n${filesNote(files)}` : "";
					return { output: [text(result.value + note), ...shown], ...(files.length && { details: { files } satisfies FileDetails }) };
				},
			}),
			defineTool({
				name: "figma_screenshot",
				description:
					`Returns a PNG of a node or a page, to check your work. Without node_id: the first selected node, else the current page. The longest side is at most ${SCREENSHOT_MAX_PX} px.`,
				parameters: Type.Object({
					node_id: Type.Optional(Type.String()),
					scale: Type.Optional(Type.Number({ description: "Default 1." })),
				}),
				replay: "safe",
				execute: async ({ node_id, scale }, _api, context) => {
					const request = bridge.request("screenshot", { nodeId: node_id, scale });
					const { result, attachments } = await awaitWithContext(request, context);
					return {
						output: [text(`Screenshot of ${result.nodeId} (${result.width} × ${result.height} px).`), ...images(attachments)],
					};
				},
			}),
			defineTool({
				name: "figma_rest",
				description: [
					"Calls the Figma REST API (https://api.figma.com) with the user's personal access token.",
					"path starts with /v1/ or /v2/ and can have a query, for example /v1/files/KEY/comments. body is JSON for POST and PUT.",
					`The answer is JSON, cut after ${REST_OUTPUT_BYTES.toLocaleString("en-US")} bytes.`,
				].join(" "),
				parameters: Type.Object({
					method: Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("DELETE")]),
					path: Type.String(),
					body: Type.Optional(Type.Object({}, { additionalProperties: true })),
				}),
				// Not safe to run again after a restart: a POST would, for example, add a comment two times.
				// pi-durable keeps the head of the output and tells the model how much it dropped.
				outputLimits: { maxBytes: REST_OUTPUT_BYTES, retain: "head" },
				execute: async ({ method, path, body }, api, context) => {
					// The token goes only to the API: a path such as //host goes to another host.
					const url = new URL(path, REST_API);
					if (url.origin !== REST_API || !/^\/v[12]\//.test(url.pathname)) throw new Error("path must start with /v1/ or /v2/.");
					const credential = await credentials.read("figma");
					if (credential?.type !== "api_key" || !credential.key)
						throw new Error("No Figma token. Ask the user to add a personal access token in Settings → Figma.");
					const headers: Record<string, string> = { "X-Figma-Token": credential.key };
					if (body) headers["Content-Type"] = "application/json";
					const response = await fetch(url.href, {
						method,
						headers,
						body: body && JSON.stringify(body),
						signal: context.abortSignal,
					});
					// Stop after the part that the model gets: the JSON of a whole file can be many megabytes.
					let received = 0;
					const reader = response.body?.getReader();
					if (reader) {
						try {
							while (received <= REST_OUTPUT_BYTES) {
								const { value, done } = await reader.read();
								if (done) break;
								received += value.byteLength;
								api.output(value);
							}
							if (received > REST_OUTPUT_BYTES) await reader.cancel();
						} finally {
							reader.releaseLock();
						}
					}
					// On an error, the output has the error of Figma.
					if (!response.ok) {
						const retry = response.headers.get("Retry-After");
						throw new Error(`Figma answered ${response.status}.${retry ? ` Try again in ${retry} s.` : ""}`);
					}
					// The note of pi-durable counts only the bytes that FigPal read.
					if (api.retainedOutput().truncated)
						api.diagnostic({
							severity: "info",
							message: `FigPal stopped reading after ${REST_OUTPUT_BYTES.toLocaleString("en-US")} bytes, and the answer is longer. Ask for less, for example with depth=1, ids=…, or /v1/files/KEY/nodes?ids=….`,
						});
					return {};
				},
			}),
			defineTool({
				name: "figma_export_nodes",
				description:
					"Exports layers as files for the user, who downloads them from this step. The file name is the layer name. It does not change the file.",
				parameters: NODE_EXPORT,
				// Read-only.
				replay: "safe",
				execute: async (args, _api, context) => {
					const files = keepFiles(await awaitWithContext(exportNodes(bridge, args), context));
					const count = `Exported ${files.length} file${files.length === 1 ? "" : "s"}.`;
					return { output: [text(`${count} ${filesNote(files)}`)], details: { files } satisfies FileDetails };
				},
			}),
			defineTool({
				name: "figma_export_tokens",
				description:
					"Exports the local variables of the open file as design tokens. The user downloads the files from this step; you get a summary and the start of the first file. dtcg_dialect 2025 gives DTCG 2025.10 colors and dimensions (Style Dictionary v5) in dtcg and json formats.",
				parameters: TOKEN_EXPORT,
				// Read-only.
				replay: "safe",
				execute: async (args, _api, context) => {
					const { files, summary } = await awaitWithContext(exportTokens(bridge, args), context);
					return { output: [text(summary)], details: { files: keepFiles(files) } satisfies FileDetails };
				},
			}),
		],
	});
}
