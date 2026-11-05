import { type AuthPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it, vi } from "vitest";
import { apiKeyProviders, forwardFetch } from "./catalog";

/** A setup in the UI: each answer in order, as the user types it. */
async function setUp(id: string, answers: string[]) {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	for (const provider of apiKeyProviders()) models.setProvider(provider);
	const prompts: AuthPrompt[] = [];
	const answer = [...answers];
	await models.login(id, "api_key", {
		prompt: async (prompt) => {
			prompts.push(prompt);
			return answer.shift()!;
		},
		notify() {},
	});
	return { credential: await credentials.read(id), prompts };
}

describe("providers with an API key", () => {
	it("are pi-ai's providers with chat models, without Claude and ChatGPT (their own cards) and Bedrock (it needs Node)", () => {
		const ids = apiKeyProviders().map((provider) => provider.id);
		expect(ids).toEqual(expect.arrayContaining(["openai", "google", "openrouter", "mistral", "azure", "google-vertex", "cloudflare-ai-gateway"]));
		for (const id of ["anthropic", "openai-codex", "amazon-bedrock", "typesafe"]) expect(ids).not.toContain(id);
	});

	it("set up with pi-ai's own questions", async () => {
		const { credential, prompts } = await setUp("cloudflare-ai-gateway", ["cf-key", "account", "gateway"]);
		expect(prompts.map((prompt) => prompt.type)).toEqual(["secret", "text", "text"]);
		expect(credential).toMatchObject({ type: "api_key", key: "cf-key" });
	});

	// pi-ai asks only for the key: the endpoint comes from the environment in Node.
	it("Azure also asks for the endpoint or the resource name", async () => {
		const url = await setUp("azure", ["az-key", "https://studio.openai.azure.com"]);
		expect(url.prompts[1]).toMatchObject({ type: "text" });
		expect(url.credential).toEqual({ type: "api_key", key: "az-key", env: { AZURE_OPENAI_BASE_URL: "https://studio.openai.azure.com" } });
		const name = await setUp("azure", ["az-key", "studio"]);
		expect(name.credential).toEqual({ type: "api_key", key: "az-key", env: { AZURE_OPENAI_RESOURCE_NAME: "studio" } });
	});

	// A browser cannot read Application Default Credentials or a credentials file.
	it("Vertex uses an API key, without the question for the method", async () => {
		const { credential, prompts } = await setUp("google-vertex", ["vertex-key"]);
		expect(prompts.map((prompt) => prompt.type)).toEqual(["secret"]);
		expect(credential).toEqual({ type: "api_key", key: "vertex-key" });
	});
});

describe("forwardFetch", () => {
	it("sends https requests to other hosts through the forward route of the page", async () => {
		const calls: Request[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input, init) => {
				calls.push(new Request(input, init));
				return new Response("ok");
			}),
		);
		try {
			const send = forwardFetch("http://127.0.0.1:9310");
			await send("https://api.mistral.ai/v1/chat?x=1", { method: "POST", headers: { authorization: "Bearer k" }, body: "{}" });
			await send(new Request("https://studio.openai.azure.com/openai/v1/responses", { method: "POST", body: "{}" }));
			await send("http://127.0.0.1:9310/api/skills/search");
			expect(calls.map((call) => call.url)).toEqual([
				"http://127.0.0.1:9310/api/forward/api.mistral.ai/v1/chat?x=1",
				"http://127.0.0.1:9310/api/forward/studio.openai.azure.com/openai/v1/responses",
				"http://127.0.0.1:9310/api/skills/search",
			]);
			expect(calls[0]!.headers.get("authorization")).toBe("Bearer k");
			expect(calls[1]!.method).toBe("POST");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
