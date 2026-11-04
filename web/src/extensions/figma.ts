// The `figma` extension: tools that read and change the open file through code.js, and the rules for the model.

import { awaitWithContext } from "@earendil-works/chord/context";
import type { CredentialStore, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { arr, int, map, num, obj, opt, type Static, str, unknown } from "@earendil-works/pi-schema";
import { type Attachment, EXECUTE_OUTPUT_LIMIT, EXECUTE_TIMEOUT_MS, EXPORT_FORMATS, MODEL_IMAGE_MAX_PX, MODEL_IMAGES } from "@figpal/shared";
import { AUDIT, auditDesignSystem } from "../audit";
import type { Bridge } from "../bridge";
import { type FileDetails, filesNote, keepFiles } from "../files";
import { LINT, lint } from "../lint";
import { literals, nodeIdOf } from "../schema";
import { exportTokens, TOKEN_EXPORT } from "../tokens";
import { DEFAULT_FRAMES, videoFrames } from "../video-frames";
import { formatChangelogMarkdown } from "../vendor/figma-console-mcp/diff/changelog-formatter";
import { type DiffMode, diffNode, diffPageStructure } from "../vendor/figma-console-mcp/diff/diff-engine";

const RULES = `You are FigPal, an agent in a Figma plugin. You read and change the open Figma file.

Each user message starts with a <figma> block (the file and the current page). In the text, <nodes> marks layers that the user selected (name, type, ID): the text next to it is about them.

Check your work: after a visual change with figma_screenshot, after an animation change with figma_animation_frames (a screenshot shows a frame at rest).
Only figma_execute changes the layers: the checks and exports only read them.

Link the layers that you name, so that a click selects them: [Card](#node=1:2), [2 icons](#node=1:3,1:4).

Plugin API rules:
- Pages load on demand. Use the async API: getNodeByIdAsync, setCurrentPageAsync, getMainComponentAsync. Call \`await page.loadAsync()\` before you read another page.
- Before you change text, load all its fonts with figma.loadFontAsync (figma.getRangeAllFontNames gives them). New text uses Inter Regular.
- Colors use the range 0 to 1, not 0 to 255.
- fills, strokes and effects are read-only arrays: copy, change the copy, then assign it.
- Auto layout: set layoutMode first. Append a child to its auto-layout parent before you set its layoutSizingHorizontal or layoutSizingVertical to "FILL". "HUG" works only on auto-layout frames and text.
- Images: \`const image = await figma.createImageAsync(url)\` loads a PNG, JPEG or GIF of at most 4096 px. Then set a fill { type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }.
- Put new top-level frames next to the existing content, not on top of it.
- Never call figma.closePlugin, figma.showUI or figma.ui: they stop FigPal.
- A failed call can have changed part of the file: check it before you run the code again.`;

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** Image attachments go to the model as images. */
function images(attachments: Attachment[]): ImageContent[] {
	return attachments
		.filter((attachment) => MODEL_IMAGES.has(attachment.mime))
		.map((attachment) => ({ type: "image", data: toBase64(attachment.bytes), mimeType: attachment.mime }));
}

const text = (value: string): TextContent => ({ type: "text", text: value });

/** The parameters of figma_export_nodes. */
export const NODE_EXPORT = obj(
	{
		node_ids: arr(str(), { minItems: 1 }),
		format: literals(EXPORT_FORMATS),
		scale: opt(num({ description: "Not for SVG and PDF. MP4, WEBM and GIF: 0.5, 0.75, 1, 1.5, 2, 3 or 4. Default 1." })),
	},
	{ open: true },
);

/** Small and fast: the frames are for the model. 24 fps puts a frame at most 42 ms before the time. */
const FRAMES_VIDEO = { format: "WEBM", fps: 24, quality: "LOW", width: 480 } as const;

/** The parameters of figma_animation_frames. Each image stays in the conversation: Figma's skill uses 4 to 6 frames. */
const ANIMATION_FRAMES = obj(
	{
		node_id: str({ description: "A top-level frame, or a layer in it." }),
		times: opt(
			arr(num({ minimum: 0 }), {
				minItems: 1,
				maxItems: 6,
				description: `In seconds. Default: ${DEFAULT_FRAMES} frames from start to end.`,
			}),
		),
		width: opt(int({ minimum: 120, maximum: 1920, description: `Default ${FRAMES_VIDEO.width}. Larger to read small text.` })),
	},
	{ open: true },
);

const seconds = (value: number) => `${Number(value.toFixed(2))} s`;

/** Exports the nodes as files. Read-only, so the chat can run it again without the agent. */
export async function exportNodes(bridge: Pick<Bridge, "request">, args: Static<typeof NODE_EXPORT>): Promise<Attachment[]> {
	const { attachments } = await bridge.request("export", { nodeIds: args.node_ids.map(nodeIdOf), format: args.format, scale: args.scale });
	return attachments;
}

const REST_API = "https://api.figma.com";
/** The answers of the REST tools and the audit are cut after this. The JSON of a whole file is often megabytes. */
const REST_OUTPUT_BYTES = 40_000;

/** The error for a REST answer that is not OK. A 429 says when to try again: the limits for files are strict. */
function restError(response: Response, detail = ""): Error {
	const retry = response.headers.get("Retry-After");
	return new Error(`Figma answered ${response.status}${detail}.${retry ? ` Try again in ${retry} s.` : ""}`);
}

/** What figma_diff_versions compares, for the model. */
const DIFF_SCOPE =
	"Compared: pages (added, removed, renamed); for node_ids: name, children (added, removed, renamed), component property definitions, and variable bindings to depth 2. Not compared: descriptions, variant options, other layer properties, instances, variable values.";

export function figmaExtension(
	bridge: Pick<Bridge, "request">,
	credentials: Pick<CredentialStore, "read">,
	/** Null if code.js cannot read it. */
	fileKey: string | null,
) {
	const token = async () => {
		const credential = await credentials.read("figma");
		if (credential?.type !== "api_key" || !credential.key)
			throw new Error("No Figma token. Ask the user to add a personal access token in Settings → Access.");
		return credential.key;
	};
	return defineExtension({
		name: "figma",
		sections: [section("figma", () => RULES)],
		tools: [
			defineTool({
				name: "figma_execute",
				description: [
					"Runs Figma Plugin API JavaScript in the open file. Keep each call small, and return the IDs of the nodes that you make or change. The code is the body of an async function: use await,",
					`and \`return\` a JSON value. Nodes in the value become { id, name, type }. The output is cut after ${EXECUTE_OUTPUT_LIMIT.toLocaleString("en-US")} characters.`,
					"`pi.attach(bytes, { mime, name })` sends an image (PNG, JPEG, GIF, WebP) to you; other files go to the user, but for files that the user asks for, use the export tools.",
					"Checks of a component set (node or ID; return their JSON): `pi.auditAccessibility` scores states, focus, target size and color-blind contrast (figma_lint checks text contrast); `pi.analyzeComponentSet` gives the variant axes, the CSS state of each variant and what it changes.",
				].join(" "),
				parameters: obj(
					{
						code: str(),
						timeout_ms: opt(num({ description: `Default ${EXECUTE_TIMEOUT_MS.default}, maximum ${EXECUTE_TIMEOUT_MS.max}.` })),
					},
					{ open: true },
				),
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
					`Returns a PNG of a node or a page. Without node_id: the first selected node, else the current page. The longest side is at most ${MODEL_IMAGE_MAX_PX} px.`,
				parameters: obj({ node_id: opt(str()), scale: opt(num({ description: "Default 1." })) }, { open: true }),
				replay: "safe",
				execute: async ({ node_id, scale }, _api, context) => {
					const request = bridge.request("screenshot", { nodeId: node_id && nodeIdOf(node_id), scale });
					const { result, attachments } = await awaitWithContext(request, context);
					return {
						output: [text(`Screenshot of ${result.nodeId} (${result.width} × ${result.height} px).`), ...images(attachments)],
					};
				},
			}),
			defineTool({
				name: "figma_rest",
				description: [
					"Calls the Figma REST API (https://api.figma.com) with the user's personal access token: comments, versions, and the components and styles of other files and libraries. For the open file, use the Plugin API.",
					"path starts with /v1/ or /v2/ and can have a query, for example /v1/files/KEY/comments. body is JSON for POST and PUT.",
					`The answer is JSON, cut after ${REST_OUTPUT_BYTES.toLocaleString("en-US")} bytes.`,
				].join(" "),
				parameters: obj({ method: literals(["GET", "POST", "PUT", "DELETE"]), path: str(), body: opt(map(unknown())) }, { open: true }),
				// Not safe to run again after a restart: a POST would, for example, add a comment two times.
				// pi-durable keeps the head of the output and tells the model how much it dropped.
				outputLimits: { maxBytes: REST_OUTPUT_BYTES, retain: "head" },
				execute: async ({ method, path, body }, api, context) => {
					// The token goes only to the API: a path such as //host goes to another host.
					const url = new URL(path, REST_API);
					if (url.origin !== REST_API || !/^\/v[12]\//.test(url.pathname)) throw new Error("path must start with /v1/ or /v2/.");
					const headers: Record<string, string> = { "X-Figma-Token": await token() };
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
						throw restError(response);
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
				name: "figma_diff_versions",
				description: `A Markdown changelog between two versions of the open file. ${DIFF_SCOPE} It uses 2 REST calls (4 with node_ids); View and Collab seats get about 20 a month.`,
				parameters: obj(
					{
						from_version: str({
							description: 'The older version: an ID from GET /v1/files/KEY/versions (newest first), or "current".',
						}),
						to_version: opt(str({ description: 'Default "current": the file now.' })),
						node_ids: opt(arr(str(), { description: "For example component sets." })),
						mode: opt(
							literals<DiffMode>(["summary", "standard", "detailed"], {
								description: "summary: counts. standard (default): names and counts. detailed: each property and binding.",
							}),
						),
					},
					{ open: true },
				),
				outputLimits: { maxBytes: REST_OUTPUT_BYTES, retain: "head" },
				// Read-only.
				replay: "safe",
				execute: async ({ from_version, to_version = "current", node_ids = [], mode = "standard" }, _api, context) => {
					if (!fileKey) throw new Error("FigPal cannot read the key of this file, so the REST API cannot read its versions.");
					if (from_version === to_version) throw new Error("from_version and to_version are the same.");
					const headers = { "X-Figma-Token": await token() };
					/** A JSON answer about the file at a version ("current": the file now). */
					const read = async (path: string, version: string, params: Record<string, string>) => {
						const query = new URLSearchParams({ ...params, ...(version === "current" ? {} : { version }) });
						const response = await fetch(`${REST_API}/v1/files/${fileKey}${path}?${query}`, { headers, signal: context.abortSignal });
						if (!response.ok) throw restError(response, `: ${(await response.text()).slice(0, 1000)}`);
						return response.json();
					};
					const now = (file: { lastModified?: string }) => ({ version_id: "current", created_at: file.lastModified ?? null, is_head: true });
					const both = (path: string, params: Record<string, string>) =>
						Promise.all([read(path, from_version, params), read(path, to_version, params)]);
					const ids = node_ids.map(nodeIdOf);
					// All nodes in one call for each version: upstream makes 2 calls for each node.
					const [[from, to], [before, after]] = await Promise.all([
						both("", { depth: "1" }),
						ids.length ? both("/nodes", { ids: ids.join(","), depth: "2" }) : [{}, {}],
					]);
					// The ID that the model gave, also for a node that neither version has.
					const nodes = ids.map((id) => ({
						...diffNode(before.nodes?.[id]?.document ?? null, after.nodes?.[id]?.document ?? null, mode),
						node_id: id,
					}));
					const markdown = formatChangelogMarkdown(
						{
							file_key: fileKey,
							file_name: to.name,
							from_version_id: from_version,
							to_version_id: to_version,
							// The date of the current file, as upstream. A file answer has no label of a past version.
							from_meta: from_version === "current" ? now(from) : null,
							to_meta: to_version === "current" ? now(to) : null,
							page_structure: diffPageStructure(from.document, to.document),
							scoped_nodes: ids.length ? nodes : undefined,
							notes: [DIFF_SCOPE],
						},
						mode,
					);
					return { output: [text(markdown)] };
				},
			}),
			defineTool({
				name: "figma_export_nodes",
				description:
					"Exports layers as files for the user to download from this step, named after the layer. MP4, WEBM and GIF: the Motion animation of the top-level frame of the layer, named after the frame; the render can take some seconds.",
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
				name: "figma_animation_frames",
				description:
					"Shows you still frames of the Motion animation of a top-level frame. Figma renders a video first (some seconds): check after all changes, not after each one.",
				parameters: ANIMATION_FRAMES,
				// Read-only.
				replay: "safe",
				execute: async ({ node_id, times, width = FRAMES_VIDEO.width }, _api, context) => {
					const id = nodeIdOf(node_id);
					const work = async () => {
						const { format, fps, quality } = FRAMES_VIDEO;
						const { attachments } = await bridge.request("export", { nodeIds: [id], format, width, fps, quality });
						// After Stop, do not decode.
						context.abortSignal?.throwIfAborted();
						const video = attachments[0]!;
						return videoFrames(video.bytes, video.mime, times);
					};
					const { duration, frames, ...size } = await awaitWithContext(work(), context);
					return {
						output: [
							text(`The animation of the top-level frame of ${id} is ${seconds(duration)} long. Frames of ${size.width} × ${size.height} px:`),
							...frames.flatMap(({ time, data, mime }): (TextContent | ImageContent)[] => [
								text(seconds(time)),
								{ type: "image", data, mimeType: mime },
							]),
						],
					};
				},
			}),
			defineTool({
				name: "figma_audit_design_system",
				description:
					"Scores the design system of the open file from 0 to 100 for each category, from the local variables, components and styles of all pages, as they are now. Start without category, then get the findings of one category.",
				parameters: AUDIT,
				// Names in the file have no length limit.
				outputLimits: { maxBytes: REST_OUTPUT_BYTES, retain: "head" },
				// Read-only.
				replay: "safe",
				execute: async (args, _api, context) => {
					const { report, details } = await awaitWithContext(auditDesignSystem(bridge, args), context);
					return { output: [text(report)], details };
				},
			}),
			defineTool({
				name: "figma_lint",
				description:
					"Checks the layers of the open file: accessibility (contrast with WCAG 2 and APCA, target size, focus states, ...), design-system use (colors without variables, text without text styles, ...) and layout. When WCAG 2 and APCA disagree on a fix, ask the user which standard to meet, unless they said it. The user can select the layers of each rule from this step.",
				parameters: LINT,
				// Names in the file have no length limit.
				outputLimits: { maxBytes: REST_OUTPUT_BYTES, retain: "head" },
				// Read-only.
				replay: "safe",
				execute: async (args, _api, context) => {
					const { report, details } = await awaitWithContext(lint(bridge, args), context);
					return { output: [text(report)], details };
				},
			}),
			defineTool({
				name: "figma_export_tokens",
				description:
					"Exports the local variables of the open file as design tokens for the user to download from this step; you get a summary and the start of the first file.",
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
