import { InMemoryCredentialStore, InMemoryModelsStore, type ModelsStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localModelsStore, withRemoteCatalog } from "./remote-catalog";

/** A model as pi.dev serves it (the shape of pi-ai's catalog). */
const NEW_MODEL = {
	id: "claude-test-9",
	name: "Claude Test 9",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 500000,
	maxTokens: 64000,
	type: "chat",
};

const LATER = "Wed, 01 Jan 2099 00:00:00 GMT";
const EARLIER = "Mon, 01 Jan 2024 00:00:00 GMT";

function catalogResponse(models: object[], lastModified = LATER): Response {
	return new Response(JSON.stringify(models), { headers: { "content-type": "application/json", "last-modified": lastModified, etag: '"v1"' } });
}

/** pi.dev answers with `respond`; the requests are in the result. */
function piDev(respond: (request: Request) => Response | Promise<Response>) {
	const requests: Request[] = [];
	vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		return respond(request);
	}));
	return requests;
}

/** Claude with a saved API key, so that its catalog refreshes. */
async function claudeModels(modelsStore: ModelsStore = new InMemoryModelsStore()) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-api03-test" }));
	const models = createModels({ credentials, modelsStore });
	models.setProvider(withRemoteCatalog(anthropicProvider()));
	return models;
}

/** The localStorage of the UI origin. Node has none. */
let local: Map<string, string>;
beforeEach(() => {
	local = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => local.get(key) ?? null,
		setItem: (key: string, value: string) => local.set(key, value),
		removeItem: (key: string) => local.delete(key),
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the pi.dev model catalog", () => {
	it("adds the newer models of pi.dev to the bundled models", async () => {
		const requests = piDev(() => catalogResponse([NEW_MODEL]));
		const models = await claudeModels();
		expect(models.getModel("anthropic", "claude-test-9")).toBeUndefined();

		const { errors } = await models.refresh();

		expect(errors.size).toBe(0);
		expect(new URL(requests[0]!.url).href).toBe("https://pi.dev/api/models/providers/anthropic?types=chat%2Cimage%2Cclassifier");
		expect(models.getModel("anthropic", "claude-test-9")).toMatchObject({ name: "Claude Test 9", contextWindow: 500000 });
		expect(models.getModel("anthropic", "claude-sonnet-5-5")).toBeDefined();
	});

	it("keeps the bundled models when the catalog of pi.dev is older", async () => {
		const bundled = (await claudeModels()).getModel("anthropic", "claude-sonnet-5-5")!;
		piDev(() => catalogResponse([NEW_MODEL, { ...bundled, contextWindow: 1 }], EARLIER));
		const models = await claudeModels();

		await models.refresh();

		expect(models.getModel("anthropic", "claude-test-9")).toBeUndefined();
		expect(models.getModel("anthropic", "claude-sonnet-5-5")?.contextWindow).toBe(bundled.contextWindow);
	});

	it("keeps the catalog for the next start, also offline", async () => {
		const store = new InMemoryModelsStore();
		piDev(() => catalogResponse([NEW_MODEL]));
		await (await claudeModels(store)).refresh();

		const requests = piDev(() => Response.error());
		const next = await claudeModels(store);
		await next.refresh({ allowNetwork: false });

		expect(requests).toHaveLength(0);
		expect(next.getModel("anthropic", "claude-test-9")).toBeDefined();
	});

	it("asks pi.dev again after 4 hours, and keeps the catalog when it did not change", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const store = new InMemoryModelsStore();
		piDev(() => catalogResponse([NEW_MODEL]));
		await (await claudeModels(store)).refresh();

		const requests = piDev(() => new Response(null, { status: 304 }));
		await (await claudeModels(store)).refresh();
		expect(requests).toHaveLength(0);

		vi.advanceTimersByTime(4 * 60 * 60 * 1000 + 1);
		const models = await claudeModels(store);
		await models.refresh();
		expect(requests.map((request) => request.headers.get("if-none-match"))).toEqual(['"v1"']);
		expect(models.getModel("anthropic", "claude-test-9")).toBeDefined();
	});

	it("keeps the catalog in localStorage", async () => {
		piDev(() => catalogResponse([NEW_MODEL]));
		await (await claudeModels(localModelsStore())).refresh();

		const next = await claudeModels(localModelsStore());
		await next.refresh({ allowNetwork: false });

		expect(next.getModel("anthropic", "claude-test-9")).toBeDefined();
	});

	it("uses the bundled models when the saved catalog is damaged", async () => {
		local.set("figpal.models.anthropic", "{not json");
		const requests = piDev(() => catalogResponse([NEW_MODEL]));
		const models = await claudeModels(localModelsStore());

		await models.refresh();

		expect(requests).toHaveLength(1);
		expect(models.getModel("anthropic", "claude-test-9")).toBeDefined();
	});

	it("keeps the bundled models when pi.dev cannot answer", async () => {
		piDev(() => new Response("down", { status: 503 }));
		const models = await claudeModels();

		const { errors } = await models.refresh();

		expect(errors.get("anthropic")?.message).toContain("503");
		expect(models.getModel("anthropic", "claude-sonnet-5-5")).toBeDefined();
	});
});
