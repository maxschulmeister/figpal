import { describe, expect, it } from "vitest";
import type { Bridge } from "./bridge";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";

function storage(value?: unknown) {
	const data = new Map<string, unknown>(value === undefined ? [] : [["figpal.settings", value]]);
	return {
		data,
		bridge: {
			async request(type: string, params: { key: string; value?: unknown }) {
				if (type === "storage-get") return { result: data.get(params.key), attachments: [] };
				data.set(params.key, params.value);
				return { result: null, attachments: [] };
			},
		} as unknown as Pick<Bridge, "request">,
	};
}

describe("settings", () => {
	it("saves and loads the model and thinking level for new threads", async () => {
		const { bridge } = storage();
		expect(await loadSettings(bridge)).toEqual(DEFAULT_SETTINGS);
		const settings = { model: { provider: "openai-codex", modelId: "gpt-6.1-sol" }, thinkingLevel: "high" } as const;
		await saveSettings(bridge, settings);
		expect(await loadSettings(bridge)).toEqual(settings);
	});

	it.each([
		["not an object", "x"],
		["no model", { thinkingLevel: "high" }],
		["an unknown thinking level", { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, thinkingLevel: "huge" }],
	])("uses the defaults when the saved value has %s", async (_case, value) => {
		expect(await loadSettings(storage(value).bridge)).toEqual(DEFAULT_SETTINGS);
	});
});
