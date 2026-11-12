// The MCP server for an outside agent (Claude Code, Codex, pi): `figpal mcp`. The agent acts on the open Figma file
// through FigPal. The requests go through the bridge of `figpal`, which starts at login. When no bridge runs, this
// process is the bridge itself, as figma-console-mcp. FigPal runs the requests in code.js, as for its own agent, when
// the user allows outside agents.

import type { WireAttachment } from "@figpal/shared/local";
import { isUiToHelper } from "@figpal/shared/local";
import { EXECUTE_TIMEOUT_MS, MODEL_IMAGES, nodeIdOf } from "@figpal/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket } from "ws";
import { z } from "zod";
import { AGENT_PATH, type AgentMessage, type AgentResult, type Helper, parse } from "./server.ts";

type Bridge = Pick<Helper, "request">;

/** The requests through the bridge of another process. When that process stops, `onClose` runs. */
function remote(socket: WebSocket, onClose: () => void): Bridge {
	const pending = new Map<string, { resolve(answer: AgentResult): void; reject(error: Error): void }>();
	let nextId = 0;
	socket.on("error", () => {});
	socket.on("message", (data) => {
		const message = parse(data);
		if (!isUiToHelper(message) || message.kind !== "response") return;
		const waiting = pending.get(message.id);
		pending.delete(message.id);
		if (message.ok) waiting?.resolve({ result: message.result, attachments: message.attachments });
		else waiting?.reject(new Error(message.error));
	});
	socket.on("close", () => {
		const error = new Error("The FigPal bridge stopped before it answered: the code may have run. Check the file before you try again.");
		for (const waiting of pending.values()) waiting.reject(error);
		pending.clear();
		onClose();
	});
	return {
		request(type, params, file) {
			const id = String(++nextId);
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				const message: AgentMessage = { kind: "request", id, type, params, ...(file !== undefined && { file }) };
				socket.send(JSON.stringify(message), (error) => {
					if (!error) return;
					pending.delete(id);
					reject(error);
				});
			});
		},
	};
}

/**
 * The bridge to FigPal: a running bridge on one of `ports` of `host`, or else this process starts one with `start`.
 * Without `start` (a bridge on another computer), the agent gets an error. It connects at once, so that FigPal shows
 * the agent, and again when the other bridge stops.
 */
export function joinBridge(
	ports: readonly number[],
	{ host = "127.0.0.1", start }: { host?: string; start?: (port: number) => Promise<Helper> },
): Bridge {
	let bridge: Promise<Bridge> | undefined;
	const open = (port: number) =>
		new Promise<WebSocket | undefined>((resolve) => {
			// Another program on the port can accept the connection and never answer.
			const socket = new WebSocket(`ws://${host}:${port}${AGENT_PATH}`, { handshakeTimeout: 2000 });
			socket.once("open", () => resolve(socket));
			socket.once("error", () => resolve(undefined));
		});
	const reconnect = () => {
		bridge = undefined;
		void ready();
	};
	const connect = async (): Promise<Bridge> => {
		// First a running bridge on any port: a second bridge would split the agents.
		for (const port of ports) {
			const socket = await open(port);
			if (socket) return remote(socket, reconnect);
		}
		if (!start)
			throw new Error(
				`FigPal does not answer on ${host} (ports ${ports[0]} to ${ports.at(-1)}). On that computer, open Figma Desktop and run FigPal.`,
			);
		for (const port of ports) {
			const own = await start(port).catch(() => undefined);
			if (own) return own;
			// Another agent started a bridge on this port at the same moment.
			const socket = await open(port);
			if (socket) return remote(socket, reconnect);
		}
		throw new Error(`FigPal needs one of the ports ${ports[0]} to ${ports.at(-1)}: other programs use them.`);
	};
	const ready = () => {
		if (!bridge) {
			bridge = connect();
			bridge.catch(() => (bridge = undefined));
		}
		return bridge;
	};
	void ready();
	return { request: async (type, params, file) => (await ready()).request(type, params, file) };
}

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

/** FigPal opens once for each Figma file. */
const file = z.string().optional().describe("The name of the Figma file, when FigPal is open in several files.");

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
				file,
			},
		},
		({ code, timeout_ms, file }) =>
			answer(async () => {
				const { result, attachments } = await helper.request("execute", { code, ...(timeout_ms && { timeoutMs: timeout_ms }) }, file);
				return [{ type: "text" as const, text: (result as { value: string }).value }, ...files(attachments)];
			}),
	);
	server.registerTool(
		"figma_screenshot",
		{
			description: "Returns a PNG of a node, or of the current page, in the file that is open in FigPal. Without node_id: the first selected node, else the page.",
			inputSchema: { node_id: z.string().optional(), scale: z.number().positive().optional(), file },
		},
		({ node_id, scale, file }) =>
			answer(async () => {
				const params = { ...(node_id && { nodeId: nodeIdOf(node_id) }), ...(scale && { scale }) };
				const { result, attachments } = await helper.request("screenshot", params, file);
				const { nodeId, width, height } = result as { nodeId: string; width: number; height: number };
				return [{ type: "text" as const, text: `Screenshot of ${nodeId} (${width} × ${height} px).` }, ...files(attachments)];
			}),
	);
	return server;
}
