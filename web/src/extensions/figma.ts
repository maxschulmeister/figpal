// The `figma` extension: tools that read and change the open file through code.js, and the rules for the model.

import { awaitWithContext } from "@earendil-works/chord/context";
import { type ImageContent, type TextContent, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type Attachment, EXECUTE_OUTPUT_LIMIT, EXECUTE_TIMEOUT_MS, SCREENSHOT_MAX_PX } from "@figpal/shared";
import type { Bridge } from "../bridge";

const RULES = `You are FigPal, an agent in a Figma plugin. You read and change the open Figma file.

Each user message starts with a <figma> block: the file, the current page and the selected nodes (name, type, ID).

Tools:
- figma_execute runs Plugin API JavaScript. Keep each call small. Return the IDs of the nodes that you make or change.
- figma_screenshot shows a node. After a visual change, use it to check the result.

Plugin API rules:
- Pages load on demand. Use the async API: getNodeByIdAsync, setCurrentPageAsync, getMainComponentAsync. Call \`await page.loadAsync()\` before you read another page.
- Before you change text, load all its fonts with figma.loadFontAsync (figma.getRangeAllFontNames gives them). New text uses Inter Regular.
- Colors use the range 0 to 1, not 0 to 255.
- fills, strokes and effects are read-only arrays: copy, change the copy, then assign it.
- Auto layout: set layoutMode first. Append a child to its auto-layout parent before you set its layoutSizingHorizontal or layoutSizingVertical to "FILL". "HUG" works only on auto-layout frames and text.
- Put new top-level frames next to the existing content, not on top of it.
- Never call figma.closePlugin, figma.showUI or figma.ui: they stop FigPal.
- If a call fails, read the error and fix the code. A call that failed can have changed part of the file: check before you run it again.`;

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** Image attachments go to the model as images. */
function images(attachments: Attachment[]): ImageContent[] {
	return attachments
		.filter((attachment) => attachment.mime.startsWith("image/"))
		.map((attachment) => ({ type: "image", data: toBase64(attachment.bytes), mimeType: attachment.mime }));
}

const text = (value: string): TextContent => ({ type: "text", text: value });

export function figmaExtension(bridge: Pick<Bridge, "request">) {
	return defineExtension({
		name: "figma",
		sections: [section("figma", () => RULES)],
		tools: [
			defineTool({
				name: "figma_execute",
				description: [
					"Runs Figma Plugin API JavaScript in the open file. The code is the body of an async function: use await,",
					`and \`return\` a JSON value. Nodes in the value become { id, name, type }. The output is cut after ${EXECUTE_OUTPUT_LIMIT.toLocaleString("en-US")} characters.`,
					"`pi.attach(bytes, { mime, name })` sends an image (for example from exportAsync) to you with the result.",
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
					return { output: [text(result.value), ...images(attachments)] };
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
		],
	});
}
