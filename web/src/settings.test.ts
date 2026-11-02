import { describe, expect, it } from "vitest";
import type { Bridge } from "./bridge";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { chatgptProvider } from "./providers/chatgpt";
import { DEFAULT_SETTINGS, enabledModelGroups, loadSettings, saveSettings } from "./settings";

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
	it("keeps a known text size, and uses medium for any other value", async () => {
		const settings = (textSize: unknown) => ({ model: DEFAULT_SETTINGS.model, thinkingLevel: "high", enabledModels: [], textSize });
		expect((await loadSettings(storage(settings("small")).bridge)).textSize).toBe("small");
		expect((await loadSettings(storage(settings("huge")).bridge)).textSize).toBe("medium");
	});

	it("saves and loads the model and thinking level for new threads", async () => {
		const { bridge } = storage();
		expect(await loadSettings(bridge)).toEqual(DEFAULT_SETTINGS);
		const settings = {
			model: { provider: "openai-codex", modelId: "gpt-6.1-sol" },
			thinkingLevel: "high",
			enabledModels: ["anthropic/claude-haiku-5"],
			outsideAgents: true,
			textSize: "large",
		} as const;
		await saveSettings(bridge, { ...settings, enabledModels: [...settings.enabledModels] });
		expect(await loadSettings(bridge)).toEqual(settings);
	});

	it("loads the settings of Phase 2 without enabled models, and leaves out values that are not model names", async () => {
		const phase2 = { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, thinkingLevel: "low" };
		// Older settings have no MCP setting: it stays off.
		expect(await loadSettings(storage(phase2).bridge)).toEqual({ ...phase2, enabledModels: [], outsideAgents: false, textSize: "medium" });
		const mixed = { ...phase2, enabledModels: ["anthropic/claude-haiku-5", 3, "no-slash"] };
		expect((await loadSettings(storage(mixed).bridge)).enabledModels).toEqual(["anthropic/claude-haiku-5"]);
	});

	it.each([
		["not an object", "x"],
		["no model", { thinkingLevel: "high" }],
		["an unknown thinking level", { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, thinkingLevel: "huge" }],
	])("uses the defaults when the saved value has %s", async (_case, value) => {
		expect(await loadSettings(storage(value).bridge)).toEqual(DEFAULT_SETTINGS);
	});

	describe("enabled models", () => {
		const models = createModels();
		models.setProvider(anthropicProvider());
		models.setProvider(chatgptProvider());
		const both = new Set(["anthropic", "openai-codex"]);
		const names = (enabled: string[], connected = both) =>
			enabledModelGroups(models, connected, enabled).map((group) => [group.provider.id, group.models.map((model) => model.id)]);

		it("are all models of the connected providers without a choice, without dated IDs", () => {
			const all = names([]);
			expect(all.map(([provider]) => provider)).toEqual(["anthropic", "openai-codex"]);
			expect(all[0]![1]).toContain("claude-sonnet-5-5");
			expect((all[0]![1] as string[]).some((id) => /-\d{8}$/.test(id))).toBe(false);
			expect(names([], new Set(["anthropic"])).map(([provider]) => provider)).toEqual(["anthropic"]);
		});

		it("are the chosen models, by provider", () => {
			expect(names(["openai-codex/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"])).toEqual([
				["anthropic", ["claude-sonnet-5-5"]],
				["openai-codex", ["gpt-6.1-sol"]],
			]);
		});

		it("are all models when no chosen model is of a connected provider: the menu is never empty", () => {
			const onlyClaude = new Set(["anthropic"]);
			expect(names(["openai-codex/gpt-6.1-sol"], onlyClaude)).toEqual(names([], onlyClaude));
		});
	});
});
