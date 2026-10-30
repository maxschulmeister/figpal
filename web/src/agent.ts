// The FigPal agent: a pi-durable Harness for one Figma file, with Claude through the Anthropic route.

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
	type Conversation,
	createRegistry,
	Harness,
	type InputSubmissionDraft,
	type ModelRef,
	type Storage,
} from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import type { FileInfo, NodeSummary } from "@figpal/shared";
import type { Bridge } from "./bridge";
import { figmaExtension } from "./extensions/figma";
import { ANTHROPIC_ROUTE, throughRoute } from "./providers/anthropic-route";
import { wrapAnthropicProvider } from "./providers/pi-black";
import { UserText } from "./transcript";

export const DEFAULT_MODEL: ModelRef = { provider: "anthropic", modelId: "claude-sonnet-5-5" };

export type Agent = { harness: Harness; root: Conversation };

/** Anthropic refuses browser requests for subscription accounts, so Claude requests go through the route. */
export function createAgentModels(credentials: CredentialStore, origin: string): Models {
	const models = createModels({ credentials });
	models.setProvider(throughRoute(wrapAnthropicProvider(anthropicProvider()), `${origin}${ANTHROPIC_ROUTE}`));
	return models;
}

/** Opens the Harness on `storage` and continues the runs that a restart stopped. */
export async function startAgent(
	storage: Storage,
	options: { models: Models; bridge: Pick<Bridge, "request">; model?: ModelRef },
): Promise<Agent> {
	const registry = createRegistry();
	registry.install(figmaExtension(options.bridge));
	// pi-durable reports failures of the storage, tasks and extensions here, and nowhere else.
	const onReport = (error: unknown, info: unknown) => console.error("FigPal agent:", info, error);
	const harness = await Harness.open(storage, { models: options.models, registry, onReport }, context);
	const root = await harness.root(context, { agent: { model: options.model ?? DEFAULT_MODEL } });
	harness.resume();
	return { harness, root };
}

/**
 * Opens the agent of a file in the browser. The storage of a file can have one owner at a time, so a Web Lock guards
 * it while the page lives. Returns "locked" if another FigPal window has the file open.
 */
export function openAgent(fileId: string, options: { models: Models; bridge: Pick<Bridge, "request"> }): Promise<Agent | "locked"> {
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
