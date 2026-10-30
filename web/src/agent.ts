// The FigPal agent: a pi-durable Harness for one Figma file, with Claude through the Anthropic route.

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Api, CredentialStore, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness, type InputSubmissionDraft, type Storage } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import type { FileInfo, NodeSummary } from "@figpal/shared";
import type { Bridge } from "./bridge";
import { figmaExtension } from "./extensions/figma";
import { ANTHROPIC_ROUTE, fetchAsServer } from "./providers/anthropic-route";
import { CHATGPT_ROUTE, chatgptProvider } from "./providers/chatgpt";
import { wrapAnthropicProvider } from "./providers/pi-black";
import { UserText } from "./transcript";

/** Sends the requests of `provider` to the route at `baseUrl`, with an extra stream option. */
function throughRoute(provider: Provider, baseUrl: string, extra: Pick<StreamOptions, "fetch" | "transport">): Provider {
	return {
		...provider,
		stream: (model, context, options) => provider.stream({ ...model, baseUrl } as Model<Api>, context, { ...options, ...extra }),
		streamSimple: (model, context, options) => provider.streamSimple({ ...model, baseUrl }, context, { ...options, ...extra }),
	};
}

/** Claude and ChatGPT. Both go through routes on the page origin: their APIs refuse these browser requests. */
export function createAgentModels(credentials: CredentialStore, origin: string): Models {
	const models = createModels({ credentials });
	// Around Pi Black, so that Pi Black wraps fetchAsServer.
	const claude = wrapAnthropicProvider(anthropicProvider());
	models.setProvider(throughRoute(claude, `${origin}${ANTHROPIC_ROUTE}`, { fetch: fetchAsServer }));
	// A browser WebSocket cannot send headers, so ChatGPT uses SSE.
	models.setProvider(throughRoute(chatgptProvider(), `${origin}${CHATGPT_ROUTE}`, { transport: "sse" }));
	return models;
}

/** Opens the Harness on `storage` and continues the runs that a restart stopped. `threads.ts` opens the threads. */
export async function startAgent(storage: Storage, options: { models: Models; bridge: Pick<Bridge, "request"> }): Promise<Harness> {
	const registry = createRegistry();
	registry.install(figmaExtension(options.bridge));
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
export function openAgent(fileId: string, options: { models: Models; bridge: Pick<Bridge, "request"> }): Promise<Harness | "locked"> {
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

const describeNode = (node: NodeSummary) => `${node.name} (${node.type}, ${node.id})`;

/** The model gets the file, the page and the selection before the text. The transcript shows only the text. */
export function userInput(text: string, file: FileInfo): InputSubmissionDraft {
	const selection = file.selection.length ? file.selection.map(describeNode).join(", ") : "none";
	const block = `<figma>\nFile: ${file.fileName}\nPage: ${describeNode(file.page)}\nSelection: ${selection}\n</figma>`;
	return { type: "input", content: `${block}\n\n${text}`, entry: { kind: UserText.kind, data: { text } } };
}
