// Request and event channel from the hosted UI to code.js (the plugin main thread).

import {
	type Attachment,
	type EventMessage,
	FIGMA_ORIGIN,
	isPluginToUi,
	type Params,
	PLUGIN_ID,
	type RequestType,
	type Result,
	type UiToPlugin,
} from "@figpal/shared";

export type Reply<T extends RequestType> = { result: Result<T>; attachments: Attachment[] };

export type Bridge = {
	request<T extends RequestType>(type: T, params: Params<T>): Promise<Reply<T>>;
	onEvent(listener: (event: EventMessage) => void): () => void;
	/** Tells code.js that the UI loaded. code.js answers with an `init` event. */
	ready(): void;
	diagnostics(): Diagnostics;
};

/** What the bridge saw, to find out how Figma delivers messages. */
export type Diagnostics = { accepted: number; fromParent: boolean | undefined; ignoredOrigins: string[] };

export function createBridge(host: Window = window, parent: Window = window.parent, targetOrigin = FIGMA_ORIGIN): Bridge {
	const pending = new Map<string, { resolve(reply: Reply<RequestType>): void; reject(error: Error): void }>();
	const listeners = new Set<(event: EventMessage) => void>();
	const diagnostics: Diagnostics = { accepted: 0, fromParent: undefined, ignoredOrigins: [] };
	let nextId = 0;

	host.addEventListener("message", (event: MessageEvent) => {
		const message: unknown = event.data?.pluginMessage;
		if (!isPluginToUi(message)) return;
		// Only a figma.com window can send with this origin. Do not require `event.source === parent`:
		// in Figma Desktop, messages from code.js did not arrive with that check.
		if (event.origin !== targetOrigin) {
			if (!diagnostics.ignoredOrigins.includes(event.origin)) diagnostics.ignoredOrigins.push(event.origin);
			return;
		}
		diagnostics.accepted++;
		diagnostics.fromParent = event.source === parent;
		if (message.kind === "event") {
			for (const listener of listeners) listener(message);
			return;
		}
		const call = pending.get(message.id);
		if (!call) return;
		pending.delete(message.id);
		if (message.ok) call.resolve({ result: message.result as Result<RequestType>, attachments: message.attachments });
		else call.reject(new Error(message.error));
	});

	const post = (message: UiToPlugin) =>
		parent.postMessage({ pluginMessage: message, pluginId: PLUGIN_ID }, targetOrigin);

	return {
		request(type, params) {
			const id = `${Date.now().toString(36)}-${nextId++}`;
			return new Promise((resolve, reject) => {
				// Replies come in a later task. If the send throws, no pending entry stays behind.
				post({ kind: "request", id, type, params });
				pending.set(id, { resolve: resolve as (reply: Reply<RequestType>) => void, reject });
			});
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		ready: () => post({ kind: "ready" }),
		diagnostics: () => ({ ...diagnostics, ignoredOrigins: [...diagnostics.ignoredOrigins] }),
	};
}
