// FigPal settings in clientStorage, for all files: the model and thinking level of new threads.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { Bridge } from "./bridge";

const KEY = "figpal.settings";

export type Settings = { model: ModelRef; thinkingLevel: ModelThinkingLevel };

/** The providers of FigPal, in this order, with the model of new threads until the user picks one. */
export const PROVIDERS = [
	{ id: "anthropic", label: "Claude", defaultModel: "claude-sonnet-5-5" },
	{ id: "openai-codex", label: "ChatGPT", defaultModel: "gpt-6.1-sol" },
] as const;

export const DEFAULT_SETTINGS: Settings = {
	model: { provider: PROVIDERS[0].id, modelId: PROVIDERS[0].defaultModel },
	thinkingLevel: "medium",
};

function isSettings(value: unknown): value is Settings {
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
	return isSettings(result) ? result : DEFAULT_SETTINGS;
}

export async function saveSettings(bridge: Pick<Bridge, "request">, settings: Settings): Promise<void> {
	await bridge.request("storage-set", { key: KEY, value: settings });
}
