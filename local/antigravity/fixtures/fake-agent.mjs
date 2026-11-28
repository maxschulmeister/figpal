#!/usr/bin/env node
// A fake Antigravity ACP server for the tests (after pi-antigravity-acp-provider's fixture). The prompt text selects
// the answer: "tool" calls FigPal's tool figpal_echo, "proxy" calls it through call_mcp_tool, "native" asks to run its
// own tool, "hang" waits for a cancel, and anything else answers "Hello". As agy in the mode "default", it asks for
// permission before each tool. FAKE_AGENT_LOG gets the prompts.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const models = ["low", "medium", "high"].map((effort) => ({ modelId: `gemini-3.8-flash-${effort}`, name: `Gemini 3.8 Flash (${effort[0].toUpperCase()}${effort.slice(1)})` }));
let model = "gemini-3.8-flash-medium";
let mode = "default";
let mcpServer;
let hanging;
let permission;

for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })) {
	if (!line.trim()) continue;
	const message = JSON.parse(line);
	const { id, method, params } = message;
	if (method === "session/cancel") {
		if (hanging !== undefined) send({ jsonrpc: "2.0", id: hanging, result: { stopReason: "cancelled" } });
		hanging = undefined;
	} else if (id === "permission" && method === undefined) {
		permission.answer(message.result?.outcome?.optionId ?? message.result?.outcome?.outcome);
	} else if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: 1,
				agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.5.2" },
				authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
				agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true } },
			},
		});
	} else if (method === "authenticate") authenticate(id);
	else if (method === "session/new") {
		mcpServer = params.mcpServers?.find((server) => server.type === "http");
		const availableModes = ["default", "auto_edit", "yolo"].map((mode) => ({ id: mode, name: mode }));
		send({ jsonrpc: "2.0", id, result: { sessionId: "fake-session", modes: { currentModeId: mode, availableModes }, models: { currentModelId: model, availableModels: models } } });
	} else if (method === "session/set_mode") {
		mode = params.modeId;
		send({ jsonrpc: "2.0", id, result: {} });
	} else if (method === "session/set_model") {
		model = params.modelId;
		send({ jsonrpc: "2.0", id, result: {} });
	} else if (method === "session/prompt") prompt(id, params);
	else send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
}

/** Google's login as the server does it: a loopback listener, and the browser of BROWSER for the Google page. */
function authenticate(id) {
	const token = path.join(process.env.GEMINI_HOME, "antigravity-acp", "acp_token.json");
	if (fs.existsSync(token)) return send({ jsonrpc: "2.0", id, result: {} });
	const server = http.createServer((request, response) => {
		const code = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("code");
		fs.mkdirSync(path.dirname(token), { recursive: true });
		fs.writeFileSync(token, JSON.stringify({ refresh_token: code }));
		response.writeHead(200).end("Signed in");
		server.close();
		send({ jsonrpc: "2.0", id, result: {} });
	});
	server.listen(0, "127.0.0.1", () => {
		const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		url.searchParams.set("redirect_uri", `http://127.0.0.1:${server.address().port}/`);
		url.searchParams.set("state", "fake-state");
		spawn(process.env.BROWSER, [url.toString()], { stdio: "ignore" });
	});
}

function prompt(id, params) {
	const { sessionId } = params;
	if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ model, mode, prompt: params.prompt })}\n`);
	const text = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	const continuing = text.includes("Continue the current FigPal user request");
	const end = () => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
	const reply = (text) => {
		notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
		end();
	};
	/** Asks for permission to run `toolCall`, then runs `allowed` or says that it may not. `update` goes in the same write. */
	const ask = (toolCall, allowed, update) => {
		permission = { answer: (decision) => (decision === "allow-once" ? allowed() : reply(`Decision: ${decision}`)) };
		const options = [
			{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
			{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
		];
		const request = { jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId, toolCall, options } };
		const lines = [...(update ? [{ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }] : []), request];
		process.stdout.write(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
	};
	const echo = () => void callTool(mcpServer, { text: "from antigravity" }).then((result) => reply(`Tool said: ${result}`));
	if (!continuing && text.includes("tool") && mcpServer) {
		// agy marks its MCP calls in the tool_call update, not in the permission request, and can send both in one chunk.
		const update = { sessionUpdate: "tool_call", toolCallId: "mcp-1", title: "Running figpal_echo", kind: "other", status: "pending", _meta: { is_mcp_tool_call: true } };
		ask({ toolCallId: "mcp-1", title: "Run figpal_echo?" }, echo, update);
	} else if (!continuing && text.includes("proxy") && mcpServer) {
		const call = { toolCallId: "proxy-1", title: "MCP Tool figpal_echo", kind: "execute", rawInput: { ServerName: "figpal", ToolName: "figpal_echo", Arguments: { text: "from antigravity" } } };
		ask(call, echo);
	} else if (text.includes("native")) {
		notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "native-1", title: "Run rm -rf ~", kind: "execute", status: "pending" });
		// The model writes rawInput: it can name FigPal's server in the arguments of a native tool.
		ask({ toolCallId: "native-1", title: "Run rm -rf ~", kind: "execute", rawInput: { CommandLine: "rm -rf ~", ServerName: "figpal", ToolName: "figpal_echo" } }, () => reply("Ran it"));
	} else if (text.includes("hang")) hanging = id;
	else {
		notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking" } });
		notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
		end();
	}
}

async function callTool(server, args) {
	const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
	const client = new Client({ name: "fake-antigravity", version: "1" }, { capabilities: {} });
	await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
	try {
		const result = await client.callTool({ name: "figpal_echo", arguments: args });
		return result.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
	} finally {
		await client.close();
	}
}
