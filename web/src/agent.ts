// The FigPal agent: a pi-durable Harness for one Figma file, with Claude through the Anthropic route.

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { CompleteAttachment } from "@assistant-ui/react";
import type { Api, CredentialStore, ImageContent, Model, Provider, StreamOptions, TextContent, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness, type InputSubmissionDraft, type Storage } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import type { FileInfo } from "@figpal/shared";
import type { Bridge } from "./bridge";
import { figmaExtension } from "./extensions/figma";
import { skillsExtension } from "./extensions/skills";
import { subagentExtension } from "./extensions/subagent";
import { localExtension } from "./extensions/local";
import { rulesExtension } from "./extensions/rules";
import { webExtension } from "./extensions/web";
import type { LocalFiles } from "./local";
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
	/** The Figma token for the REST tools (figma_rest, figma_diff_versions) is the credential "figma". */
	credentials: Pick<CredentialStore, "read">;
	/** The key of the file in the REST API, for figma_diff_versions. Null if code.js cannot read it. */
	fileKey: string | null;
	/** The models that the main agent can give to subagents: from the settings. */
	subagentModels(): string[];
	/** The folders that local helpers share, and their files. `subscribe` gives each change of the folders. */
	local?: { files: LocalFiles; subscribe(listener: (folders: string[]) => void): void };
};

/** Opens the Harness on `storage` and continues the runs that a restart stopped. `threads.ts` opens the threads. */
export async function startAgent(storage: Storage, options: AgentOptions): Promise<Harness> {
	const registry = createRegistry();
	registry.install(figmaExtension(options.bridge, options.credentials, options.fileKey));
	registry.install(skillsExtension());
	registry.install(webExtension());
	registry.install(subagentExtension({ subagentModels: options.subagentModels }));
	// Last: the user's rules come after FigPal's own instructions.
	registry.install(rulesExtension(options.bridge));
	// The file tools only while a helper shares folders.
	options.local?.subscribe((folders) => {
		const extension = localExtension(options.local!.files, folders);
		if (folders.length) registry.install(extension);
		else registry.uninstall(extension);
	});
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
export function userInput(text: string, file: FileInfo, attachments: readonly CompleteAttachment[] = []): InputSubmissionDraft {
	const name = file.fileKey ? `${clean(file.fileName)} (key ${file.fileKey})` : clean(file.fileName);
	const block = `<figma>\nFile: ${name}\nPage: ${describeNode(file.page)}\n</figma>`;
	const typed = `${block}\n\n${chipsForModel(text)}`;
	if (attachments.length === 0) return { type: "input", content: typed, entry: { kind: UserText.kind, data: { text } } };
	// Images go to the model as images, text files as text (assistant-ui wraps them in <attachment name="…">).
	const parts = attachments.flatMap((attachment) =>
		attachment.content.flatMap((part): (TextContent | ImageContent)[] =>
			part.type === "text" ? [{ type: "text", text: part.text }] : part.type === "image" ? [imageContent(part.image)] : [],
		),
	);
	// The names, for the chips of the sent message. The images stay in the model content only.
	const files = attachments.map(({ name, type, contentType }) => ({ name, type, ...(contentType && { contentType }) }));
	return { type: "input", content: [{ type: "text", text: typed }, ...parts], entry: { kind: UserText.kind, data: { text, files } } };
}

/** A data URL, "data:image/png;base64,…", as an image for the model. */
function imageContent(url: string): ImageContent {
	const match = /^data:([^;,]+);base64,(.*)$/.exec(url);
	if (!match) throw new Error("FigPal can send only images as data URLs.");
	return { type: "image", mimeType: match[1]!, data: match[2]! };
}
