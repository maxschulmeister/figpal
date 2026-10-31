// Model credentials in the localStorage of the UI origin, as a pi-ai CredentialStore. Not in figma.clientStorage: code
// from figma_execute runs in the plugin sandbox and can read clientStorage, so a prompt injection could send the tokens
// out. It cannot read the storage of the UI, and the model never sees the tokens.

import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { Bridge } from "./bridge";

const KEY = "figpal.credentials";

type Credentials = Record<string, Credential>;

function isCredentials(value: unknown): value is Credentials {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every(
		(credential) => typeof credential === "object" && credential !== null && ["api_key", "oauth"].includes(credential.type),
	);
}

function load(): Credentials {
	const text = localStorage.getItem(KEY);
	let value: unknown;
	try {
		value = text === null ? undefined : JSON.parse(text);
	} catch {
		// Damaged: as if empty. The user connects again.
	}
	return isCredentials(value) ? value : {};
}

const save = (credentials: Credentials) => localStorage.setItem(KEY, JSON.stringify(credentials));

/**
 * FigPal windows of other files share the storage, so writes run one after the other in a Web Lock: a write cannot
 * lose another one, and an OAuth refresh runs only once. The first use moves the credentials of an older FigPal out of
 * clientStorage.
 */
export function uiCredentials(bridge: Pick<Bridge, "request">): CredentialStore {
	// The signal stops only the wait for the lock, not a write that holds it.
	const serialized = <T>(write: () => T | Promise<T>, signal?: AbortSignal) =>
		navigator.locks.request(KEY, { signal }, write) as Promise<T>;
	let moved: Promise<void> | undefined;
	const moveOld = () =>
		(moved ??= serialized(async () => {
			const { result } = await bridge.request("storage-get", { key: KEY });
			if (result === undefined || result === null) return;
			// Credentials that the UI already has are newer.
			if (localStorage.getItem(KEY) === null && isCredentials(result)) save(result);
			await bridge.request("storage-delete", { key: KEY });
		}).catch((error) => console.error("FigPal could not move the credentials out of clientStorage:", error)));

	return {
		read: async (providerId) => {
			await moveOld();
			return load()[providerId];
		},
		list: async () => {
			await moveOld();
			return Object.entries(load()).map(([providerId, { type }]) => ({ providerId, type }));
		},
		modify: async (providerId, update, options) => {
			await moveOld();
			return serialized(async () => {
				const credentials = load();
				const next = await update(credentials[providerId]);
				if (next === undefined) return credentials[providerId];
				save({ ...credentials, [providerId]: next });
				return next;
			}, options?.signal);
		},
		delete: async (providerId, options) => {
			await moveOld();
			return serialized(() => {
				const { [providerId]: _, ...rest } = load();
				save(rest);
			}, options?.signal);
		},
	};
}
