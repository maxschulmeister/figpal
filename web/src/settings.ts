// FigPal settings in clientStorage, for all files: the model and thinking level of new threads, and the enabled models
// (like pi's scoped models): the chat's model menu shows them, and the main agent can give them to subagents.

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { Bridge } from "./bridge";

const KEY = "figpal.settings";

export type Settings = {
	model: ModelRef;
	thinkingLevel: ModelThinkingLevel;
	/** "provider/modelId". Empty: all models. */
	enabledModels: string[];
	/** An outside agent can run code in the file through the local helper. */
	outsideAgents: boolean;
	/** The size of the text in the chat. */
	textSize: TextSize;
};

export const TEXT_SIZES = ["small", "medium", "large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** The providers of FigPal, in this order, with the model of new threads until the user picks one. */
export const PROVIDERS = [
	{ id: "anthropic", label: "Claude", defaultModel: "claude-sonnet-5-5" },
	{ id: "openai-codex", label: "ChatGPT", defaultModel: "gpt-6.1-sol" },
] as const;

/** "provider/modelId" as a model reference. */
export function parseModelRef(text: string): ModelRef | undefined {
	const slash = text.indexOf("/");
	return slash > 0 && slash < text.length - 1 ? { provider: text.slice(0, slash), modelId: text.slice(slash + 1) } : undefined;
}

export type ModelGroup = { provider: (typeof PROVIDERS)[number]; models: Model<Api>[] };

/** The models of the connected providers. A dated ID repeats a model that is also in the list without a date. */
export const modelGroups = (models: Models, connected: ReadonlySet<string>): ModelGroup[] =>
	PROVIDERS.filter((provider) => connected.has(provider.id)).map((provider) => ({
		provider,
		models: models.getModels(provider.id).filter((model) => !/-\d{8}$/.test(model.id)),
	}));

/** The enabled models of the connected providers. If none of them is enabled, all: the model menu is never empty. */
export function enabledModelGroups(models: Models, connected: ReadonlySet<string>, enabled: string[]): ModelGroup[] {
	const all = modelGroups(models, connected);
	const chosen = all
		.map((group) => ({ ...group, models: group.models.filter((model) => enabled.includes(`${group.provider.id}/${model.id}`)) }))
		.filter((group) => group.models.length);
	return chosen.length ? chosen : all;
}

export const DEFAULT_SETTINGS: Settings = {
	model: { provider: PROVIDERS[0].id, modelId: PROVIDERS[0].defaultModel },
	thinkingLevel: "medium",
	enabledModels: [],
	outsideAgents: false,
	textSize: "medium",
};

/** The model and thinking level. The other settings came later: loadSettings checks them alone. */
function isSettings(
	value: unknown,
): value is Pick<Settings, "model" | "thinkingLevel"> & Partial<Record<"enabledModels" | "outsideAgents" | "textSize", unknown>> {
	if (typeof value !== "object" || value === null) return false;
	const { model, thinkingLevel } = value as Partial<Record<keyof Settings, unknown>>;
	const ref = model as Partial<Record<keyof ModelRef, unknown>> | null | undefined;
	return (
		typeof ref?.provider === "string" &&
		typeof ref.modelId === "string" &&
		typeof thinkingLevel === "string" &&
		(MODEL_THINKING_LEVELS as readonly string[]).includes(thinkingLevel)
	);
}

export async function loadSettings(bridge: Pick<Bridge, "request">): Promise<Settings> {
	const { result } = await bridge.request("storage-get", { key: KEY });
	if (!isSettings(result)) return DEFAULT_SETTINGS;
	const { model, thinkingLevel, enabledModels, outsideAgents, textSize } = result;
	const list = Array.isArray(enabledModels) ? enabledModels : [];
	return {
		model,
		thinkingLevel,
		enabledModels: list.filter((item): item is string => typeof item === "string" && parseModelRef(item) !== undefined),
		outsideAgents: outsideAgents === true,
		textSize: TEXT_SIZES.find((size) => size === textSize) ?? "medium",
	};
}

export async function saveSettings(bridge: Pick<Bridge, "request">, settings: Settings): Promise<void> {
	await bridge.request("storage-set", { key: KEY, value: settings });
}
