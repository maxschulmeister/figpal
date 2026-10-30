// pi-durable Harness for the spike: one root conversation for each file, one hard-coded tool (figma_execute).

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	envApiKeyAuth,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
	type SimpleStreamOptions,
	Type,
} from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
	type Conversation,
	type ConversationView,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	section,
} from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import type { Bridge } from "../bridge";
import { wrapAnthropicProvider } from "../providers/pi-black";

export type ProviderId = "anthropic" | "openai" | "openai-codex" | "faux";
export const PROVIDERS: ProviderId[] = ["anthropic", "openai", "openai-codex", "faux"];

/** Request settings that the spike page changes at runtime. */
export const requestSettings: {
	keys: Partial<Record<ProviderId, string>>;
	/** Base URL for openai-codex. Undefined: the direct chatgpt.com URL. */
	codexBaseUrl?: string;
	nativeSearch: boolean;
} = { keys: {}, nativeSearch: false };

/** Adds the provider's own web search tool to the request (spike 0.8). */
export function addNativeSearch(payload: unknown, provider: string): unknown {
	const body = payload as { tools?: unknown[] };
	const tool =
		provider === "anthropic" ? { type: "web_search_20250305", name: "web_search", max_uses: 3 } : { type: "web_search" };
	return { ...body, tools: [...(body.tools ?? []), tool] };
}

/**
 * pi-durable does not pass request options to pi-ai. This wrapper adds the API key, the Codex route and the
 * native search tool to every request.
 */
function withRequestSettings(models: Models): Models {
	return new Proxy(models, {
		get(target, property) {
			if (property === "streamSimple") {
				const streamSimple: Models["streamSimple"] = (model, request, options) => {
					const provider = model.provider as ProviderId;
					const baseUrl = provider === "openai-codex" ? requestSettings.codexBaseUrl : undefined;
					return target.streamSimple(baseUrl ? { ...model, baseUrl } : model, request, {
						...options,
						apiKey: requestSettings.keys[provider],
						// A browser WebSocket cannot send headers, so Codex must use SSE.
						transport: "sse",
						onPayload: requestSettings.nativeSearch ? (payload) => addNativeSearch(payload, provider) : undefined,
					} as SimpleStreamOptions);
				};
				return streamSimple;
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * A scripted model without a network, to test the agent loop and resume without a token.
 * "run: <code>" calls figma_execute with the code. Other messages get an echo.
 */
function fauxScript() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "script" }], tokensPerSecond: 200 });
	const step: FauxResponseFactory = (request) => {
		const last = request.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`Tool result: ${contentText(last.content)}`));
		const prompt = last?.role === "user" ? contentText(last.content) : "";
		if (prompt.startsWith("run:"))
			return fauxAssistantMessage(fauxToolCall("figma_execute", { code: prompt.slice(4).trim() }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxText(`Echo: ${prompt}`));
	};
	faux.setResponses(Array.from({ length: 500 }, () => step));
	return faux.provider;
}

/**
 * pi-ai's Codex provider has only OAuth auth, and its OAuth module needs Node. Without API key auth, pi-ai ignores
 * the explicit `apiKey` ("Provider is not configured"). This adds API key auth that takes the access token.
 */
function browserCodexProvider() {
	return { ...openaiCodexProvider(), auth: { apiKey: envApiKeyAuth("ChatGPT access token", []) } };
}

export function createSpikeModels(): Models {
	const models = createModels();
	models.setProvider(wrapAnthropicProvider(anthropicProvider()));
	models.setProvider(openaiProvider());
	models.setProvider(browserCodexProvider());
	models.setProvider(fauxScript());
	return withRequestSettings(models);
}

const RULES = `You are FigPal, an agent inside a Figma plugin. You read and change the open Figma file with the figma_execute tool.
Write Plugin API JavaScript. Load fonts before you change text. Colors use the range 0 to 1. Return node IDs of what you create.`;

function figmaExtension(bridge: Bridge) {
	return defineExtension({
		name: "figma",
		sections: [section("figma", () => RULES)],
		tools: [
			defineTool({
				name: "figma_execute",
				description:
					"Run Figma Plugin API JavaScript in the open file. Top-level await works. Use `return` to send a JSON value back. `figma` is the Plugin API.",
				parameters: Type.Object({
					code: Type.String({ description: "JavaScript. The body of an async function." }),
					timeout_ms: Type.Optional(Type.Number({ description: "Default 30000, maximum 300000." })),
				}),
				execute: async (args) => {
					const { result } = await bridge.request("execute", { code: args.code, timeoutMs: args.timeout_ms });
					return { output: [{ type: "text", text: result.value }] };
				},
			}),
		],
	});
}

export type Agent = { harness: Harness; root: Conversation; models: Models };

/**
 * Opens the file's storage inside a Web Lock: IndexedDbStorage needs one owner at a time.
 * Returns "locked" if another window has the storage open.
 */
export function openAgent(
	fileId: string,
	bridge: Bridge,
	onView: (view: ConversationView) => void,
): Promise<Agent | "locked"> {
	const name = `figpal:spike:file:${fileId}`;
	return new Promise((resolve, reject) => {
		void navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
			if (!lock) {
				resolve("locked");
				return;
			}
			try {
				const storage = await IndexedDbStorage.open(name);
				const registry = createRegistry();
				registry.install(figmaExtension(bridge));
				const models = createSpikeModels();
				const harness = await Harness.open(storage, { models, registry }, context);
				const root = await harness.root(context, {
					agent: { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } },
				});
				const view = await root.viewState(context);
				view.subscribe((value) => onView(value));
				harness.resume();
				resolve({ harness, root, models });
			} catch (error) {
				reject(error);
				return;
			}
			// Keep the lock while the page lives.
			await new Promise(() => {});
		});
	});
}

export async function setModel(agent: Agent, provider: ProviderId, modelId: string): Promise<void> {
	await agent.root.configure({ model: { provider, modelId } }, context);
}

export async function send(agent: Agent, text: string): Promise<{ status: string; detail: string }> {
	const submission = await agent.root.submit({ type: "input", content: text }, context);
	const settled = await submission.wait(context);
	return { status: settled.status, detail: JSON.stringify(settled).slice(0, 500) };
}

export async function abort(agent: Agent): Promise<void> {
	await agent.root.abort(context);
}

function contentText(content: Message["content"] | undefined): string {
	if (typeof content === "string") return content;
	if (!content) return "";
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return `(thinking) ${block.thinking.slice(0, 200)}`;
			if (block.type === "toolCall") return `→ ${block.name}(${JSON.stringify(block.arguments)})`;
			if (block.type === "image") return `[image ${block.mimeType}]`;
			return `[${(block as { type: string }).type}]`;
		})
		.join("\n");
}

export function formatMessage(message: Message): string {
	if (message.role === "system")
		return `SYSTEM: sections ${Object.keys(message.sections ?? {}).join(", ") || "none"}; tools ${(message.toolsAdded ?? []).map((tool) => tool.name).join(", ") || "none"}`;
	if (message.role === "user") return `USER: ${contentText(message.content)}`;
	if (message.role === "toolResult")
		return `TOOL ${message.toolName}${message.isError ? " (error)" : ""}: ${contentText(message.content).slice(0, 1000)}`;
	const assistant = message as AssistantMessage;
	const error = assistant.errorMessage ? `\n[${assistant.stopReason}] ${assistant.errorMessage}` : "";
	return `ASSISTANT (${assistant.provider}/${assistant.model}): ${contentText(assistant.content)}${error}`;
}

/** Transcript lines and the facts for the resume check (0.7). */
export function describeView(view: ConversationView): { lines: string[]; interrupted: boolean; continuedAfter: boolean; busy: boolean } {
	const messages = view.entries.flatMap((entry) => (entry.model ?? []) as Message[]);
	const lines = messages.map(formatMessage);
	const live = view.docs["pi.live"] as { run?: unknown; generation?: { message?: Message }; tools?: unknown[] } | undefined;
	if (live?.generation?.message) lines.push(`(streaming) ${formatMessage(live.generation.message)}`);
	if (live?.tools?.length) lines.push(`(tools) ${JSON.stringify(live.tools).slice(0, 500)}`);
	const index = messages.findIndex(
		(m) => m.role === "toolResult" && m.isError && /interrupt/i.test(contentText(m.content)),
	);
	return {
		lines,
		interrupted: index >= 0,
		continuedAfter: index >= 0 && messages.slice(index + 1).some((m) => m.role === "assistant"),
		busy: live?.run !== undefined,
	};
}
