// Rules (user request, like AGENTS.md): text that the agent follows in every chat. The rules for all files are in
// clientStorage, so only this user has them. The rules for this file are in the file (code.js), so everyone with the
// file has them. Both go into each model request, so a change counts from the next message on.

import { MAX_RULES } from "@figpal/shared";
import type { Bridge } from "./bridge";

const KEY = "figpal.rules";

export type Rules = { global: string; file: string };

export async function loadRules(bridge: Pick<Bridge, "request">): Promise<Rules> {
	const [stored, file] = await Promise.all([bridge.request("storage-get", { key: KEY }), bridge.request("rules", {})]);
	// A text from an older FigPal, or from another plugin with the same key, can be longer than the limit.
	const text = (value: unknown) => (typeof value === "string" ? value.slice(0, MAX_RULES) : "");
	return { global: text(stored.result), file: text(file.result) };
}

export async function saveRules(bridge: Pick<Bridge, "request">, scope: keyof Rules, text: string): Promise<void> {
	if (scope === "global") await bridge.request("storage-set", { key: KEY, value: text });
	else await bridge.request("rules", { text });
}

/** The part of the system prompt. None without text. */
export function rulesPrompt({ global, file }: Rules): string | undefined {
	const parts = [
		global.trim() && `<rules for="all files">\n${global.trim()}\n</rules>`,
		file.trim() && `<rules for="this file">\n${file.trim()}\n</rules>`,
	].filter(Boolean);
	if (!parts.length) return undefined;
	return ["Follow the user's rules. If two rules disagree, the rules for this file win.", ...parts].join("\n\n");
}

/**
 * The part of the system prompt, for each model request. A code.js from before the rules does not know the request
 * (the plugin was not built again): then the chat goes on without rules.
 */
export async function readRulesPrompt(bridge: Pick<Bridge, "request">): Promise<string | undefined> {
	const rules = await loadRules(bridge).catch((error) => {
		console.warn("FigPal could not read the rules:", error);
		return { global: "", file: "" };
	});
	return rulesPrompt(rules);
}
