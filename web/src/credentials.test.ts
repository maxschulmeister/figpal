import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "./bridge";
import { uiCredentials } from "./credentials";

const KEY = "figpal.credentials";

/** A bridge with only the clientStorage requests, like code.js. */
function fakeClientStorage(initial?: unknown) {
	const data = new Map<string, unknown>(initial === undefined ? [] : [[KEY, initial]]);
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

const saved = () => JSON.parse(local.get(KEY) ?? "null");

describe("uiCredentials", () => {
	it("keeps a token in the storage of the UI, where code from figma_execute cannot read it, and pi-ai uses it", async () => {
		const { data, bridge } = fakeClientStorage();
		await uiCredentials(bridge).modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-oat01-test" }));
		expect(saved()).toEqual({ anthropic: { type: "api_key", key: "sk-ant-oat01-test" } });
		expect(data.has(KEY)).toBe(false);

		const models = createModels({ credentials: uiCredentials(bridge) });
		models.setProvider(anthropicProvider());
		expect((await models.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-oat01-test");
	});

	it("moves the credentials of an older FigPal out of clientStorage, once", async () => {
		const old = { anthropic: { type: "api_key", key: "sk-ant-oat01-old" } };
		const { data, bridge } = fakeClientStorage(old);
		const store = uiCredentials(bridge);
		expect(await store.read("anthropic")).toEqual(old.anthropic);
		expect(saved()).toEqual(old);
		expect(data.has(KEY)).toBe(false);
	});

	it("keeps the credentials of the UI when clientStorage still has older ones, and removes the older ones", async () => {
		local.set(KEY, JSON.stringify({ anthropic: { type: "api_key", key: "new" } }));
		const { data, bridge } = fakeClientStorage({ anthropic: { type: "api_key", key: "old" } });
		expect(await uiCredentials(bridge).read("anthropic")).toEqual({ type: "api_key", key: "new" });
		expect(data.has(KEY)).toBe(false);
	});

	it("lists and deletes credentials", async () => {
		const { bridge } = fakeClientStorage();
		const store = uiCredentials(bridge);
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

	it("does not lose a write when two FigPal windows write at the same time", async () => {
		const { bridge } = fakeClientStorage();
		// Two windows: two stores on the same storage. Each update takes a moment, as an OAuth refresh does.
		const slowly = <T>(value: T) => async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return value;
		};
		await Promise.all([
			uiCredentials(bridge).modify("anthropic", slowly({ type: "api_key" as const, key: "a" })),
			uiCredentials(bridge).modify("openai-codex", slowly({ type: "oauth" as const, access: "b", refresh: "c", expires: 1 })),
		]);
		expect((await uiCredentials(bridge).list()).map((info) => info.providerId)).toEqual(["anthropic", "openai-codex"]);
	});

	it("stops waiting for the lock when the caller stops, and then writes nothing", async () => {
		const { bridge } = fakeClientStorage();
		const store = uiCredentials(bridge);
		await store.list();
		// Another window holds the lock.
		let release = () => {};
		const held = navigator.locks.request(KEY, () => new Promise<void>((resolve) => (release = resolve)));
		const controller = new AbortController();
		const write = store.modify("anthropic", async () => ({ type: "api_key", key: "a" }), { signal: controller.signal });
		controller.abort();
		await expect(write).rejects.toThrow();
		release();
		await held;
		expect(local.has(KEY)).toBe(false);
	});
});
