import { describe, expect, it } from "vitest";
import type { Bridge } from "./bridge";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { chatgptProvider } from "./providers/chatgpt";
import { DEFAULT_SETTINGS, enabledModelGroups, loadSettings, saveSettings, textModel, textThinkingLevels } from "./settings";

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

	it("keeps a text generation model that is a model name, and uses Automatic (empty) for any other value", async () => {
		const settings = (textModel: unknown) => ({ model: DEFAULT_SETTINGS.model, thinkingLevel: "high", enabledModels: [], textModel });
		expect((await loadSettings(storage(settings("anthropic/claude-haiku-5-5")).bridge)).textModel).toBe("anthropic/claude-haiku-5-5");
		expect((await loadSettings(storage(settings("haiku")).bridge)).textModel).toBe("");
		expect((await loadSettings(storage(settings(3)).bridge)).textModel).toBe("");
	});

	it("keeps a known thinking level of the text generation model, and uses Off for any other value", async () => {
		const settings = (textThinking: unknown) => ({ model: DEFAULT_SETTINGS.model, thinkingLevel: "high", textThinking });
		expect((await loadSettings(storage(settings("low")).bridge)).textThinking).toBe("low");
		expect((await loadSettings(storage(settings("huge")).bridge)).textThinking).toBe("off");
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
			textModel: "anthropic/claude-haiku-5-5",
			textThinking: "low",
		} as const;
		await saveSettings(bridge, { ...settings, enabledModels: [...settings.enabledModels] });
		expect(await loadSettings(bridge)).toEqual(settings);
	});

	it("loads the settings of Phase 2 without enabled models, and leaves out values that are not model names", async () => {
		const phase2 = { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, thinkingLevel: "low" };
		// Older settings have no MCP setting: it stays off.
		expect(await loadSettings(storage(phase2).bridge)).toEqual({ ...phase2, enabledModels: [], outsideAgents: false, textSize: "medium", textModel: "", textThinking: "off" });
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

	describe("text generation model", () => {
		const models = createModels();
		models.setProvider(anthropicProvider());
		models.setProvider(chatgptProvider());
		const both = new Set(["anthropic", "openai-codex"]);
		const claude = { provider: "anthropic", modelId: "claude-opus-5-5" };
		const chatgpt = { provider: "openai-codex", modelId: "gpt-6.1-sol" };
		const id = (setting: string, chat = claude, connected = both) => textModel(models, connected, setting, chat)?.id;

		it("is the cheapest model of the chat's provider when the setting is Automatic", () => {
			expect(id("")).toBe("claude-haiku-5-5");
			expect(id("", chatgpt)).toBe("gpt-6-luna");
		});

		it("is the chosen model, of any connected provider", () => {
			expect(id("openai-codex/gpt-6-luna")).toBe("gpt-6-luna");
		});

		it("is Automatic when the chosen model is gone or its provider is not connected", () => {
			expect(id("anthropic/claude-gone")).toBe("claude-haiku-5-5");
			expect(id("openai-codex/gpt-6-luna", claude, new Set(["anthropic"]))).toBe("claude-haiku-5-5");
		});

		it("is none when the chat's provider is not connected either", () => {
			expect(id("", chatgpt, new Set(["anthropic"]))).toBeUndefined();
		});

		it("has the thinking levels of the chosen model; with Automatic, of the cheapest model of each connected provider", () => {
			expect(textThinkingLevels(models, both, "anthropic/claude-sonnet-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
			expect(textThinkingLevels(models, new Set(["anthropic"]), "")).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
			expect(textThinkingLevels(models, both, "")).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		});
	});
});
