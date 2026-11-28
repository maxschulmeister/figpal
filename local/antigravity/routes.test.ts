import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AssistantMessage, type Context, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AntigravityRoutes, antigravityRoutes } from "./routes.ts";

const AGENT = fileURLToPath(new URL("fixtures/fake-agent.mjs", import.meta.url));
chmodSync(AGENT, 0o755);

let root: string;
let routes: AntigravityRoutes;
let server: Server;
let base: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "figpal-antigravity-"));
	process.env.AGY_ACP_BIN = AGENT;
	process.env.FAKE_AGENT_LOG = join(root, "prompts.jsonl");
	routes = antigravityRoutes({ root });
	server = createServer((incoming, response) => routes.handle(incoming, response, new URL(incoming.url!, "http://x").pathname));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
	await routes.close();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	delete process.env.AGY_ACP_BIN;
	delete process.env.FAKE_AGENT_LOG;
	rmSync(root, { recursive: true, force: true });
});


/** Signs in as the user does: FigPal opens the Google page, and Google sends the browser to the server's listener. */
async function signIn(): Promise<string> {
	const response = await fetch(`${base}/login`, { method: "POST" });
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	let text = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`The login ended: ${text}`);
		text += value;
		const blocks = text.split("\n\n");
		text = blocks.pop()!;
		for (const block of blocks) {
			const event = JSON.parse(block.slice("data: ".length));
			if (event.type === "auth_url") {
				const redirect = new URL(event.url).searchParams.get("redirect_uri")!;
				await fetch(`${redirect}?code=refresh-1&state=fake-state`);
			}
			if (event.type === "done") return event.marker;
			if (event.type === "error") throw new Error(event.message);
		}
	}
}

const model = (id = "gemini-3.8-flash"): Model<"pi-messages"> => ({
	id,
	name: id,
	api: "pi-messages",
	provider: "antigravity-acp",
	baseUrl: base,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

const echo = {
	name: "echo",
	description: "Echoes the text.",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

function context(text: string, tools: (typeof echo)[] = []): Context {
	return {
		messages: [
			{ role: "system", content: "You are FigPal.", toolsAdded: tools, timestamp: 1 } as Context["messages"][number],
			{ role: "user", content: text, timestamp: 2 },
		],
	};
}

/** A request as FigPal's agent sends it, through pi-ai's client of the route. */
function ask(apiKey: string, messages: Context, signal?: AbortSignal): Promise<AssistantMessage> {
	return piMessagesApi()
		.streamSimple(model(), normalizeContext(messages), { apiKey, sessionId: "thread-1", reasoning: "high", signal })
		.result();
}

const prompts = () =>
	readFileSync(process.env.FAKE_AGENT_LOG!, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { model: string; mode: string; prompt: { type: string; text?: string; resource?: { text: string } }[] });

// Each test starts the fake server a few times.
describe("Antigravity routes", { timeout: 20_000 }, () => {
	it("signs in with Google: FigPal opens the Google page, and the server keeps the login", async () => {
		const marker = await signIn();
		expect(marker).toMatch(/^figpal-antigravity:/);
		expect(existsSync(join(root, "gemini", "antigravity-acp", "acp_token.json"))).toBe(true);
	});

	it("refuses model requests before the sign-in", async () => {
		const answer = await ask("figpal-antigravity:managed-by-antigravity:x", context("Hi"));
		expect(answer.stopReason).toBe("error");
		expect(answer.errorMessage).toContain("Sign in to Antigravity");
	});

	it("streams the answer of Antigravity, with the model of the thinking level, in the default permission mode", async () => {
		const answer = await ask(await signIn(), context("Hi"));
		expect(answer.stopReason).toBe("stop");
		expect(answer.content).toEqual([
			{ type: "thinking", thinking: "Checking" },
			{ type: "text", text: "Hello" },
		]);
		const [sent] = prompts();
		expect(sent).toMatchObject({ model: "gemini-3.8-flash-high", mode: "default" });
		expect(sent!.prompt[0]!.resource!.text).toContain("You are FigPal.");
	});

	it("gives Antigravity FigPal's tools: a tool call ends the stream, and the result continues the Antigravity turn", async () => {
		const marker = await signIn();
		const first = context("Use the tool", [echo]);
		const call = await ask(marker, first);
		expect(call.stopReason).toBe("toolUse");
		const toolCall = call.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({ name: "echo", arguments: { text: "from antigravity" } });
		const result = { role: "toolResult" as const, toolCallId: toolCall!.id, toolName: "echo", content: [{ type: "text" as const, text: "echoed" }], isError: false, timestamp: 3 };
		const answer = await ask(marker, { messages: [...first.messages, call, result] });
		expect(answer.content).toEqual([{ type: "text", text: "Tool said: echoed" }]);
		// One Antigravity turn: the result went to the waiting tool call, not into a new prompt.
		expect(prompts()).toHaveLength(1);
		expect(prompts()[0]!.prompt[0]!.resource!.text).toContain("the tool figma_execute is figpal_figma_execute");
	});

	it("lets Antigravity call FigPal's tools through call_mcp_tool", async () => {
		const marker = await signIn();
		const first = context("Use the proxy", [echo]);
		const call = await ask(marker, first);
		const toolCall = call.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({ name: "echo", arguments: { text: "from antigravity" } });
		const result = { role: "toolResult" as const, toolCallId: toolCall!.id, toolName: "echo", content: [{ type: "text" as const, text: "echoed" }], isError: false, timestamp: 3 };
		const answer = await ask(marker, { messages: [...first.messages, call, result] });
		expect(answer.content.at(-1)).toEqual({ type: "text", text: "Tool said: echoed" });
	});

	it("refuses Antigravity's own tools", async () => {
		const answer = await ask(await signIn(), context("Run a native command"));
		expect(answer.content.at(-1)).toEqual({ type: "text", text: "Decision: reject-once" });
		expect(JSON.stringify(answer.content)).toContain("FigPal refused Antigravity's own tool: Run rm -rf ~");
	});

	it("stops the Antigravity turn when FigPal stops the request", async () => {
		const marker = await signIn();
		const controller = new AbortController();
		const answer = ask(marker, context("hang"), controller.signal);
		await expect.poll(() => existsSync(process.env.FAKE_AGENT_LOG!), { timeout: 10_000 }).toBe(true);
		controller.abort();
		expect((await answer).stopReason).toBe("aborted");
		// The session is free for the next request.
		expect((await ask(marker, context("Hi"))).content.at(-1)).toEqual({ type: "text", text: "Hello" });
	});

	it("lists the models of the account, one for each family, with the levels of thinking", async () => {
		const marker = await signIn();
		const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${marker}` } });
		const models = (await response.json()) as Model<string>[];
		expect(models.map((model) => [model.id, model.name, model.thinkingLevelMap?.high])).toEqual([["gemini-3.8-flash", "Gemini 3.8 Flash", "gemini-3.8-flash-high"]]);
	});

	it("signs out: the server forgets the login", async () => {
		const marker = await signIn();
		expect((await fetch(`${base}/logout`, { method: "POST" })).status).toBe(200);
		expect(existsSync(join(root, "gemini", "antigravity-acp", "acp_token.json"))).toBe(false);
		expect((await fetch(`${base}/models`, { headers: { authorization: `Bearer ${marker}` } })).status).toBe(401);
	});
});
