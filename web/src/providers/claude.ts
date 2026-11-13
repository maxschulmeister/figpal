/**
 * @license
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { Message, Provider, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { CLAUDE_CONFIG_ROUTE, type ClaudeConfig, isClaudeIdentity, isClaudeVersion, isObject } from "@figpal/shared/claude";

const SDK_PROMPT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const LEGACY_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

type JsonObject = Record<string, unknown>;

async function loadClaudeConfig(origin: string): Promise<ClaudeConfig> {
	const response = await fetch(`${origin}${CLAUDE_CONFIG_ROUTE}`, { cache: "no-store" });
	if (!response.ok) throw new Error(`FigPal could not load Claude settings (${response.status})`);
	const data: unknown = await response.json();
	if (!isObject(data) || !isClaudeVersion(data.version) || (data.identity !== undefined && !isClaudeIdentity(data.identity))) {
		throw new Error("FigPal received invalid Claude settings");
	}
	return { version: data.version, ...(data.identity !== undefined && { identity: data.identity }) };
}

async function billingHeader(messages: Message[], version: string): Promise<string> {
	const message = messages.find((message) => message.role === "user");
	const prompt = typeof message?.content === "string" ? message.content : message?.content
		.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "";
	const selected = [4, 7, 20].map((index) => prompt[index] || "0").join("");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`59cf53e54c78${selected}${version}`));
	const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 3);
	return `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=sdk-cli; cch=00000;`;
}

async function transformPayload(
	payload: unknown, messages: Message[], sessionId: string | undefined, { version, identity }: ClaudeConfig,
): Promise<JsonObject> {
	if (!isObject(payload)) throw new Error("Expected an Anthropic request object");
	const system = Array.isArray(payload.system) ? payload.system : [];
	const firstText = isObject(system[0]) ? system[0].text : undefined;
	const secondText = isObject(system[1]) ? system[1].text : undefined;
	let remaining = system;
	if (
		typeof firstText === "string" &&
		firstText.startsWith("x-anthropic-billing-header: ") && secondText === SDK_PROMPT
	) remaining = system.slice(2);
	else if (firstText === LEGACY_PROMPT) remaining = system.slice(1);
	const transformed: JsonObject = {
		...payload,
		system: [
			{ type: "text", text: await billingHeader(messages, version) },
			{ type: "text", text: SDK_PROMPT },
			...remaining,
		],
	};
	if (identity && sessionId) {
		transformed.metadata = {
			...(isObject(payload.metadata) ? payload.metadata : {}),
			user_id: JSON.stringify({
				device_id: identity.deviceId,
				account_uuid: identity.accountUuid,
				session_id: sessionId,
			}),
		};
	}
	return transformed;
}

function mergeOptions<T extends StreamOptions>(
	options: T | undefined, context: TranscriptContext, config: () => Promise<ClaudeConfig>,
): T | undefined {
	if (!options?.apiKey?.includes("sk-ant-oat")) return options;
	const transport = options.fetch ?? globalThis.fetch;
	return {
		...options,
		headers: {
			...options.headers,
			"x-app": "cli",
			...(options.sessionId ? { "x-claude-code-session-id": options.sessionId } : {}),
		},
		fetch: async (input, init) => {
			const { version } = await config();
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
			headers.set("user-agent", `claude-cli/${version} (external, sdk-cli)`);
			if (!headers.has("x-client-request-id")) headers.set("x-client-request-id", crypto.randomUUID());
			return transport(input, { ...init, headers });
		},
		onPayload: async (payload, model) => {
			const prior = await options.onPayload?.(payload, model);
			return transformPayload(prior ?? payload, context.messages, options.sessionId, await config());
		},
	};
}

export function claudeProvider(origin: string): Provider {
	const provider: Provider = anthropicProvider();
	let configuration: Promise<ClaudeConfig> | undefined;
	const config = () => configuration ??= loadClaudeConfig(origin);
	return {
		...provider,
		stream: (model, context, options) => provider.stream(model, context, mergeOptions(options, context, config)),
		streamSimple: (model, context, options) => provider.streamSimple(model, context, mergeOptions(options, context, config)),
	};
}
