import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpikeModels, requestSettings } from "../spike/agent";
import { wrapAnthropicProvider } from "./pi-black";

const context: Context = {
	systemPrompt: "FigPal rules",
	messages: [{ role: "user", content: "Reply with exactly: PROBE_OK", timestamp: 1 }],
};

function response(): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PROBE_OK" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

type RequestBody = {
	model: string;
	max_tokens: number;
	system: { type: string; text: string; cache_control?: unknown }[];
	messages: unknown[];
	tools?: { type?: string; name: string; description?: string; input_schema?: unknown }[];
};

function captureRequests() {
	const requests: { url: string; headers: Headers; body: RequestBody }[] = [];
	vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
		requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		return response();
	}));
	return requests;
}

async function send(options: SimpleStreamOptions = {}) {
	const models = createSpikeModels();
	const model = models.getModel("anthropic", "claude-sonnet-5-5")!;
	return models.streamSimple(model, context, { maxTokens: 32, maxRetries: 0, sessionId: "durable-conversation", ...options }).result();
}

afterEach(() => {
	requestSettings.keys = {};
	requestSettings.anthropicBaseUrl = undefined;
	requestSettings.nativeSearch = false;
	vi.unstubAllGlobals();
});

describe("Pi Black in the pi-durable model collection", () => {
	it("sends Claude OAuth compatibility fields and keeps the streamed answer and usage", async () => {
		requestSettings.keys.anthropic = "sk-ant-oat01-test";
		const requests = captureRequests();
		const result = await send();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "PROBE_OK" }]);
		expect(result.usage).toMatchObject({ input: 10, output: 3 });
		expect(requests).toHaveLength(1);
		const { body, headers } = requests[0]!;
		expect(body.system[0]!.text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.280\.022; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/);
		expect(body.system[0]!.text).not.toContain("cch=00000");
		expect(body.system[1]).toEqual({ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." });
		expect(body.system[2]!.text).toBe("FigPal rules");
		expect(body).not.toHaveProperty("metadata");
		expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-test");
		expect(headers.get("user-agent")).toBe("claude-cli/2.1.280 (external, sdk-cli)");
		expect(headers.get("x-app")).toBe("cli");
		expect(headers.get("x-claude-code-session-id")).toBe("durable-conversation");
		expect(headers.get("x-client-request-id")).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("leaves API-key requests equal to the built-in provider", async () => {
		requestSettings.keys.anthropic = "sk-ant-api03-test";
		const requests = captureRequests();
		await send();
		const baseline = createModels();
		baseline.setProvider(anthropicProvider());
		await baseline.streamSimple(baseline.getModel("anthropic", "claude-sonnet-5-5")!, context, {
			apiKey: "sk-ant-api03-test", maxTokens: 32, maxRetries: 0, sessionId: "durable-conversation",
		}).result();
		expect(requests).toHaveLength(2);
		expect(requests[0]!.body).toEqual(requests[1]!.body);
		expect(requests[0]!.headers).toEqual(requests[1]!.headers);
		expect(requests[0]!.headers.get("x-api-key")).toBe("sk-ant-api03-test");
		expect(requests[0]!.headers.has("x-client-request-id")).toBe(false);
	});

	it("keeps native search in OAuth requests", async () => {
		requestSettings.keys.anthropic = "sk-ant-oat01-test";
		requestSettings.nativeSearch = true;
		const requests = captureRequests();
		await send();
		expect(requests[0]!.body.tools).toContainEqual({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
		expect(requests[0]!.body.system[0]!.text).toMatch(/cch=[0-9a-f]{5};$/);
	});

	it.each(["stream", "streamSimple"] as const)("%s matches the upstream checksum after a caller payload hook", async (method) => {
		const requests = captureRequests();
		const models = createModels();
		models.setProvider(wrapAnthropicProvider(anthropicProvider()));
		const fixture = {
			model: "claude-opus-5",
			messages: [{ role: "user", content: "cch=00000", model: "nested-model", max_tokens: 7 }],
			max_tokens: 64000,
			stream: true,
			system: [{ type: "text", text: "Pi system", cache_control: { type: "ephemeral" } }],
			tools: [{ name: "probe", description: "model max_tokens cch=00000", input_schema: { type: "object" } }],
		};
		const model = models.getModel("anthropic", "claude-sonnet-5-5")!;
		const result = await models[method](model, context, {
			apiKey: "sk-ant-oat01-test", maxRetries: 0, onPayload: async () => fixture,
		}).result();
		expect(result.stopReason).toBe("stop");
		// Generated with unmodified pi-black 036a8a7, not with this port.
		expect(requests[0]!.body).toEqual({
			...fixture,
			system: [
				{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.280.022; cc_entrypoint=sdk-cli; cch=ad5cd;" },
				{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
				...fixture.system,
			],
		});
	});

	it("does not duplicate billing blocks when a payload is transformed again", async () => {
		const requests = captureRequests();
		const models = createModels();
		models.setProvider(wrapAnthropicProvider(anthropicProvider()));
		const model = models.getModel("anthropic", "claude-sonnet-5-5")!;
		await models.streamSimple(model, context, { apiKey: "sk-ant-oat01-test", maxRetries: 0 }).result();
		await models.streamSimple(model, context, {
			apiKey: "sk-ant-oat01-test", maxRetries: 0, onPayload: () => requests[0]!.body,
		}).result();
		expect(requests[1]!.body).toEqual(requests[0]!.body);
		expect(requests[0]!.headers.get("x-client-request-id")).not.toBe(requests[1]!.headers.get("x-client-request-id"));
	});

	it("sends OAuth requests through the local route with the Claude Code user-agent", async () => {
		requestSettings.keys.anthropic = "sk-ant-oat01-test";
		requestSettings.anthropicBaseUrl = "http://localhost:5173/api/anthropic";
		const requests = captureRequests();
		const result = await send();
		expect(result.content).toEqual([{ type: "text", text: "PROBE_OK" }]);
		expect(requests[0]!.url).toMatch(/^http:\/\/localhost:5173\/api\/anthropic\/v1\/messages(\?|$)/);
		expect(requests[0]!.headers.get("x-figpal-user-agent")).toMatch(/^claude-cli\/2\.1\.280 /);
		expect(requests[0]!.body.system[0]!.text).toMatch(/^x-anthropic-billing-header: /);
	});

	// The SDK turns an error from fetch into "Connection error.", which pi-ai retries. A Pi Black error stays.
	it("gives a Pi Black error back as a request error, without a retry", async () => {
		const requests = captureRequests();
		const models = createModels();
		models.setProvider(wrapAnthropicProvider(anthropicProvider()));
		const model = models.getModel("anthropic", "claude-sonnet-5-5")!;
		// Without max_tokens, the checksum step in the fetch wrapper fails.
		const withoutMaxTokens = (payload: unknown) => {
			const { max_tokens: _, ...rest } = payload as Record<string, unknown>;
			return rest;
		};
		const result = await models
			.streamSimple(model, context, { apiKey: "sk-ant-oat01-test", maxRetries: 1, onPayload: withoutMaxTokens })
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Pi Black OAuth request is missing model or max_tokens");
		expect(requests).toHaveLength(0);
	});

	it("keeps other providers available without the Anthropic transport", async () => {
		requestSettings.keys.faux = "sk-ant-oat01-test";
		const requests = captureRequests();
		const models = createSpikeModels();
		const result = await models.streamSimple(models.getModel("faux", "script")!, context).result();
		expect(result.content).toEqual([{ type: "text", text: "Echo: Reply with exactly: PROBE_OK" }]);
		expect(requests).toHaveLength(0);
	});

	it("uses the same pi-durable session header for later messages in a conversation", async () => {
		requestSettings.keys.anthropic = "sk-ant-oat01-test";
		const requests = captureRequests();
		const harness = await Harness.open(new MemoryStorage(), { models: createSpikeModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
		try {
			const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } } });
			for (const content of ["Reply with exactly: PROBE_OK", "Again"]) {
				const submission = await root.submit({ type: "input", content }, BACKGROUND_CONTEXT);
				expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
			}
			expect(requests).toHaveLength(2);
			const sessionId = requests[0]!.headers.get("x-claude-code-session-id");
			expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
			expect(requests[1]!.headers.get("x-claude-code-session-id")).toBe(sessionId);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
