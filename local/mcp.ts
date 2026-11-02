// The MCP server of the helper: an outside agent (Claude Code, Codex, pi) acts on the open Figma file through FigPal.
// FigPal runs each request in code.js, as for its own agent, when the user allows outside agents.

import type { WireAttachment } from "@figpal/shared/local";
import { EXECUTE_TIMEOUT_MS, MODEL_IMAGES, nodeIdOf } from "@figpal/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Helper } from "./server.ts";

const files = (attachments: WireAttachment[]) =>
	attachments.map((file) =>
		MODEL_IMAGES.has(file.mime)
			? { type: "image" as const, data: file.data, mimeType: file.mime }
			: { type: "resource" as const, resource: { uri: `figpal:attachment/${file.name}`, mimeType: file.mime, blob: file.data } },
	);

/** The error of FigPal, for the agent: for example "MCP is off in FigPal". */
async function answer(run: () => Promise<CallToolResult["content"]>): Promise<CallToolResult> {
	try {
		return { content: await run() };
	} catch (error) {
		return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
	}
}

export function mcpServer(helper: Pick<Helper, "request">): McpServer {
	const server = new McpServer({ name: "figpal", version: "1.0.0" });
	server.registerTool(
		"figma_execute",
		{
			description: [
				"Runs Figma Plugin API JavaScript in the file that is open in FigPal. The code is the body of an async function: use await, and `return` a JSON value.",
				"Use the async API (getNodeByIdAsync, setCurrentPageAsync). `pi.attach(bytes, { mime, name })` returns a file (for example from exportAsync) with the result.",
			].join(" "),
			inputSchema: {
				code: z.string(),
				timeout_ms: z
					.number()
					.int()
					.min(1)
					.max(EXECUTE_TIMEOUT_MS.max)
					.optional()
					.describe(`Default ${EXECUTE_TIMEOUT_MS.default}.`),
			},
		},
		({ code, timeout_ms }) =>
			answer(async () => {
				const { result, attachments } = await helper.request("execute", { code, ...(timeout_ms && { timeoutMs: timeout_ms }) });
				return [{ type: "text" as const, text: (result as { value: string }).value }, ...files(attachments)];
			}),
	);
	server.registerTool(
		"figma_screenshot",
		{
			description: "Returns a PNG of a node, or of the current page, in the file that is open in FigPal. Without node_id: the first selected node, else the page.",
			inputSchema: { node_id: z.string().optional(), scale: z.number().positive().optional() },
		},
		({ node_id, scale }) =>
			answer(async () => {
				const { result, attachments } = await helper.request("screenshot", { ...(node_id && { nodeId: nodeIdOf(node_id) }), ...(scale && { scale }) });
				const { nodeId, width, height } = result as { nodeId: string; width: number; height: number };
				return [{ type: "text" as const, text: `Screenshot of ${nodeId} (${width} × ${height} px).` }, ...files(attachments)];
			}),
	);
	return server;
}
