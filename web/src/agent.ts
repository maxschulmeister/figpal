// The FigPal agent: a pi-durable Harness for one Figma file, with Claude through the Anthropic route.

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Api, CredentialStore, Model, Provider, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness, type InputSubmissionDraft, type Storage } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import type { FileInfo } from "@figpal/shared";
import type { Bridge } from "./bridge";
import { figmaExtension } from "./extensions/figma";
import { skillsExtension } from "./extensions/skills";
import { subagentExtension } from "./extensions/subagent";
import { webExtension } from "./extensions/web";
import { ANTHROPIC_ROUTE, fetchAsServer } from "./providers/anthropic-route";
import { CHATGPT_ROUTE, chatgptProvider } from "./providers/chatgpt";
import { chipsForModel, clean, describeNode } from "./node-chips";
import { wrapAnthropicProvider } from "./providers/pi-black";
import { UserText } from "./transcript";

/**
 * Sends the requests of `provider` to the route at `baseUrl`, with extra stream options, and adds the provider's own
 * web search tool (spike 0.8). pi-ai keeps the answer text, not the search results or the citations.
 */
function throughRoute(
	provider: Provider,
	baseUrl: string,
	searchTool: object,
	extra: Pick<StreamOptions, "fetch" | "transport">,
): Provider {
	const withSearch = (context: TranscriptContext, options: StreamOptions | undefined): StreamOptions => {
		// A request without tools is a compaction summary: a search there costs time, and its text would go into the
		// summary that later turns trust. The tools are in the system messages for every provider.
		const hasTools = context.messages.some((message) => message.role === "system" && message.toolsAdded?.length);
		if (!hasTools) return { ...options, ...extra };
		return {
			...options,
			...extra,
			onPayload: async (payload, model) => {
				const body = ((await options?.onPayload?.(payload, model)) ?? payload) as { tools?: unknown[] };
				return { ...body, tools: [...(body.tools ?? []), searchTool] };
			},
		};
	};
	return {
		...provider,
		stream: (model, context, options) => provider.stream({ ...model, baseUrl } as Model<Api>, context, withSearch(context, options)),
		streamSimple: (model, context, options) => provider.streamSimple({ ...model, baseUrl }, context, withSearch(context, options)),
	};
}

/** Claude and ChatGPT. Both go through routes on the page origin: their APIs refuse these browser requests. */
export function createAgentModels(credentials: CredentialStore, origin: string): Models {
	const models = createModels({ credentials });
	// Around Pi Black, so that Pi Black wraps fetchAsServer.
	const claude = wrapAnthropicProvider(anthropicProvider());
	const claudeSearch = { type: "web_search_20250305", name: "web_search", max_uses: 5 };
	models.setProvider(throughRoute(claude, `${origin}${ANTHROPIC_ROUTE}`, claudeSearch, { fetch: fetchAsServer }));
	// A browser WebSocket cannot send headers, so ChatGPT uses SSE.
	const chatgptSearch = { type: "web_search" };
	models.setProvider(throughRoute(chatgptProvider(), `${origin}${CHATGPT_ROUTE}`, chatgptSearch, { transport: "sse" }));
	return models;
}

type AgentOptions = {
	models: Models;
	bridge: Pick<Bridge, "request">;
	/** The Figma token for figma_rest is the credential "figma". */
	credentials: Pick<CredentialStore, "read">;
	/** The models that the main agent can give to subagents: from the settings. */
	subagentModels(): string[];
};

/** Opens the Harness on `storage` and continues the runs that a restart stopped. `threads.ts` opens the threads. */
export async function startAgent(storage: Storage, options: AgentOptions): Promise<Harness> {
	const registry = createRegistry();
	registry.install(figmaExtension(options.bridge, options.credentials));
	registry.install(skillsExtension());
	registry.install(webExtension());
	registry.install(subagentExtension({ subagentModels: options.subagentModels }));
	// pi-durable reports failures of the storage, tasks and extensions here, and nowhere else.
	const onReport = (error: unknown, info: unknown) => console.error("FigPal agent:", info, error);
	const harness = await Harness.open(storage, { models: options.models, registry, onReport }, context);
	harness.resume();
	return harness;
}

/**
 * Opens the agent of a file in the browser. The storage of a file can have one owner at a time, so a Web Lock guards
 * it while the page lives. Returns "locked" if another FigPal window has the file open.
 */
export function openAgent(fileId: string, options: AgentOptions): Promise<Harness | "locked"> {
	const name = `figpal:file:${fileId}`;
	// Without this, the browser can clear IndexedDB (and the threads) when the disk is full.
	navigator.storage.persist().catch((error) => console.error("FigPal storage:", error));
	return new Promise((resolve, reject) => {
		void navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
			if (!lock) {
				resolve("locked");
				return;
			}
			try {
				resolve(await startAgent(await IndexedDbStorage.open(name), options));
			} catch (error) {
				reject(error);
				return;
			}
			await new Promise(() => {});
		});
	});
}

/**
 * The model gets the file and the page before the text, and the nodes of each chip in the text. The selection goes
 * only as chips: a chip that the user removed is not sent. The transcript shows the text with its chips.
 */
export function userInput(text: string, file: FileInfo): InputSubmissionDraft {
	const name = file.fileKey ? `${clean(file.fileName)} (key ${file.fileKey})` : clean(file.fileName);
	const block = `<figma>\nFile: ${name}\nPage: ${describeNode(file.page)}\n</figma>`;
	return { type: "input", content: `${block}\n\n${chipsForModel(text)}`, entry: { kind: UserText.kind, data: { text } } };
}
