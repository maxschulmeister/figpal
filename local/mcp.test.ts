import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { mcpServer } from "./mcp.ts";
import type { Helper } from "./server.ts";

/** An MCP client of the server, with a fake helper that gives `answer` and keeps the requests. */
async function connect(answer: Awaited<ReturnType<Helper["request"]>> | Error) {
	const requests: unknown[] = [];
	const helper: Pick<Helper, "request"> = {
		request: async (type, params, file) => {
			requests.push({ type, params, ...(file && { file }) });
			if (answer instanceof Error) throw answer;
			return answer;
		},
	};
	const [client, server] = InMemoryTransport.createLinkedPair();
	await mcpServer(helper).connect(server);
	const mcp = new Client({ name: "test", version: "1" });
	await mcp.connect(client);
	return { mcp, requests };
}

describe("MCP server of the helper", () => {
	it("has the tools of FigPal for outside agents", async () => {
		const { mcp } = await connect({ result: null, attachments: [] });
		expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(["figma_execute", "figma_screenshot"]);
	});

	it("runs code in the open file through FigPal: the value, images, and other files", async () => {
		const { mcp, requests } = await connect({
			result: { value: '{"id":"1:2"}' },
			attachments: [
				{ name: "card.png", mime: "image/png", data: "iVBO" },
				{ name: "logo.svg", mime: "image/svg+xml", data: "PHN2Zy8+" },
			],
		});
		const result = await mcp.callTool({ name: "figma_execute", arguments: { code: "return figma.currentPage.selection[0]", timeout_ms: 5000 } });
		expect(requests).toEqual([{ type: "execute", params: { code: "return figma.currentPage.selection[0]", timeoutMs: 5000 } }]);
		expect(result.content).toEqual([
			{ type: "text", text: '{"id":"1:2"}' },
			{ type: "image", data: "iVBO", mimeType: "image/png" },
			{ type: "resource", resource: { uri: "figpal:attachment/logo.svg", mimeType: "image/svg+xml", blob: "PHN2Zy8+" } },
		]);
	});

	it("gives a screenshot as an image", async () => {
		const { mcp, requests } = await connect({
			result: { nodeId: "1:2", width: 200, height: 100 },
			attachments: [{ name: "Card.png", mime: "image/png", data: "iVBO" }],
		});
		const result = await mcp.callTool({ name: "figma_screenshot", arguments: { node_id: "1-2" } });
		expect(requests).toEqual([{ type: "screenshot", params: { nodeId: "1:2" } }]);
		expect(result.content).toEqual([
			{ type: "text", text: "Screenshot of 1:2 (200 × 100 px)." },
			{ type: "image", data: "iVBO", mimeType: "image/png" },
		]);
	});

	// FigPal can be open in several files.
	it("passes the file that the agent names", async () => {
		const { mcp, requests } = await connect({ result: { value: "1", nodeId: "1:2", width: 1, height: 1 }, attachments: [] });
		await mcp.callTool({ name: "figma_execute", arguments: { code: "return 1", file: "Icons" } });
		await mcp.callTool({ name: "figma_screenshot", arguments: { file: "Icons" } });
		expect(requests).toEqual([
			{ type: "execute", params: { code: "return 1" }, file: "Icons" },
			{ type: "screenshot", params: {}, file: "Icons" },
		]);
	});

	it("gives the error of FigPal to the agent", async () => {
		const { mcp } = await connect(new Error("MCP is off in FigPal."));
		const result = await mcp.callTool({ name: "figma_execute", arguments: { code: "return 1" } });
		expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "MCP is off in FigPal." }] });
	});
});
