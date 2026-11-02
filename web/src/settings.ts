// FigPal settings in clientStorage, for all files: the model and thinking level of new threads, and the enabled models
// (like pi's scoped models): the chat's model menu shows them, and the main agent can give them to subagents.

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
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
	/** "provider/modelId" of the model that names chats. Empty: Automatic, see `textModel`. */
	textModel: string;
	/** The thinking level of the text generation model. Each request fits it to the model. */
	textThinking: ModelThinkingLevel;
};

export const THINKING_LABELS: Record<ModelThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
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

/**
 * The model that names chats: the chosen model if its provider is connected, else the cheapest model of the chat's
 * provider (by price, so that it stays right when the catalog changes). None if that provider is not connected either.
 */
export function textModel(models: Models, connected: ReadonlySet<string>, setting: string, chat: ModelRef): Model<Api> | undefined {
	return chosenTextModel(models, connected, setting) ?? cheapest(modelGroups(models, connected).find(({ provider }) => provider.id === chat.provider));
}

function chosenTextModel(models: Models, connected: ReadonlySet<string>, setting: string): Model<Api> | undefined {
	const chosen = parseModelRef(setting);
	return chosen && connected.has(chosen.provider) ? models.getModel(chosen.provider, chosen.modelId) : undefined;
}

const cheapest = (group: ModelGroup | undefined) => group && [...group.models].sort((a, b) => a.cost.input - b.cost.input)[0];

/**
 * The thinking levels of the text generation model. Automatic can use the cheapest model of each connected provider:
 * the levels of all of them.
 */
export function textThinkingLevels(models: Models, connected: ReadonlySet<string>, setting: string): ModelThinkingLevel[] {
	const chosen = chosenTextModel(models, connected, setting);
	const candidates = chosen ? [chosen] : modelGroups(models, connected).flatMap((group) => cheapest(group) ?? []);
	const levels = new Set(candidates.flatMap((model) => getSupportedThinkingLevels(model)));
	return MODEL_THINKING_LEVELS.filter((level) => levels.has(level));
}

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
	textModel: "",
	textThinking: "off",
};

/** The model and thinking level. The other settings came later: loadSettings checks them alone. */
function isSettings(
	value: unknown,
): value is Pick<Settings, "model" | "thinkingLevel"> & Partial<Record<"enabledModels" | "outsideAgents" | "textSize" | "textModel" | "textThinking", unknown>> {
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
	const { model, thinkingLevel, enabledModels, outsideAgents, textSize, textModel, textThinking } = result;
	const list = Array.isArray(enabledModels) ? enabledModels : [];
	return {
		model,
		thinkingLevel,
		enabledModels: list.filter((item): item is string => typeof item === "string" && parseModelRef(item) !== undefined),
		outsideAgents: outsideAgents === true,
		textSize: TEXT_SIZES.find((size) => size === textSize) ?? "medium",
		textModel: typeof textModel === "string" && parseModelRef(textModel) ? textModel : "",
		textThinking: MODEL_THINKING_LEVELS.find((level) => level === textThinking) ?? "off",
	};
}

export async function saveSettings(bridge: Pick<Bridge, "request">, settings: Settings): Promise<void> {
	await bridge.request("storage-set", { key: KEY, value: settings });
}
