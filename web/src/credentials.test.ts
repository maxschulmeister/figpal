import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { describe, expect, it } from "vitest";
import type { Bridge } from "./bridge";
import { clientStorageCredentials } from "./credentials";

/** A bridge with only the clientStorage requests, like code.js. */
function fakeStorage() {
	const data = new Map<string, unknown>();
	const bridge = {
		async request(type: string, params: { key: string; value?: unknown }) {
			if (type === "storage-get") return { result: structuredClone(data.get(params.key)), attachments: [] };
			if (type === "storage-set") data.set(params.key, structuredClone(params.value));
			else if (type === "storage-delete") data.delete(params.key);
			else throw new Error(`Unexpected request ${type}`);
			return { result: null, attachments: [] };
		},
	} as unknown as Pick<Bridge, "request">;
	return { data, bridge };
}

describe("clientStorageCredentials", () => {
	it("keeps a saved token in clientStorage, so pi-ai uses it after a restart", async () => {
		const { data, bridge } = fakeStorage();
		await clientStorageCredentials(bridge).modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-oat01-test" }));
		expect(data.get("figpal.credentials")).toEqual({ anthropic: { type: "api_key", key: "sk-ant-oat01-test" } });

		const models = createModels({ credentials: clientStorageCredentials(bridge) });
		models.setProvider(anthropicProvider());
		const auth = await models.getAuth("anthropic");
		expect(auth?.auth.apiKey).toBe("sk-ant-oat01-test");
	});

	it("lists and deletes credentials", async () => {
		const { bridge } = fakeStorage();
		const store = clientStorageCredentials(bridge);
		await store.modify("anthropic", async () => ({ type: "api_key", key: "a" }));
		await store.modify("openai-codex", async () => ({ type: "oauth", access: "b", refresh: "c", expires: 1 }));
		expect(await store.list()).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "openai-codex", type: "oauth" },
		]);
		await store.delete("anthropic");
		expect(await store.read("anthropic")).toBeUndefined();
		expect(await store.read("openai-codex")).toMatchObject({ access: "b" });
	});

	it("runs writes one after the other, so no write gets lost", async () => {
		const { bridge } = fakeStorage();
		const store = clientStorageCredentials(bridge);
		await Promise.all([
			store.modify("anthropic", async () => ({ type: "api_key", key: "a" })),
			store.modify("openai", async () => ({ type: "api_key", key: "b" })),
		]);
		expect((await store.list()).map((info) => info.providerId)).toEqual(["anthropic", "openai"]);
	});

	it("does not lose a write when two FigPal windows write at the same time", async () => {
		const { bridge } = fakeStorage();
		// Two windows: two stores on the same clientStorage. Each read takes a moment, as a round trip to code.js does.
		const slow = { request: async (type: string, params: never) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return bridge.request(type as never, params);
		} } as unknown as Pick<Bridge, "request">;
		await Promise.all([
			clientStorageCredentials(slow).modify("anthropic", async () => ({ type: "api_key", key: "a" })),
			clientStorageCredentials(slow).modify("openai-codex", async () => ({ type: "oauth", access: "b", refresh: "c", expires: 1 })),
		]);
		expect((await clientStorageCredentials(bridge).list()).map((info) => info.providerId)).toEqual(["anthropic", "openai-codex"]);
	});

	it("stops waiting for the lock when the caller stops, and then writes nothing", async () => {
		const { data, bridge } = fakeStorage();
		// Another window holds the lock.
		let release = () => {};
		const held = navigator.locks.request("figpal.credentials", () => new Promise<void>((resolve) => (release = resolve)));
		const controller = new AbortController();
		const write = clientStorageCredentials(bridge).modify("anthropic", async () => ({ type: "api_key", key: "a" }), {
			signal: controller.signal,
		});
		controller.abort();
		await expect(write).rejects.toThrow();
		release();
		await held;
		expect(data.has("figpal.credentials")).toBe(false);
	});
});
