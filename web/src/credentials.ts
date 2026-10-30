// Model credentials in figma.clientStorage (through code.js), as a pi-ai CredentialStore.

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

/**
 * All credentials are one clientStorage value. FigPal windows of other files share it, so writes run one after the
 * other in a Web Lock: a write cannot lose another one, and an OAuth refresh runs only once.
 */
export function clientStorageCredentials(bridge: Pick<Bridge, "request">): CredentialStore {
	const load = async (): Promise<Credentials> => {
		const { result } = await bridge.request("storage-get", { key: KEY });
		return isCredentials(result) ? result : {};
	};
	const save = (credentials: Credentials) => bridge.request("storage-set", { key: KEY, value: credentials });
	// The signal stops only the wait for the lock, not a write that holds it.
	const serialized = <T>(write: () => Promise<T>, signal?: AbortSignal) =>
		navigator.locks.request(KEY, { signal }, write) as Promise<T>;

	return {
		read: async (providerId) => (await load())[providerId],
		list: async () => Object.entries(await load()).map(([providerId, { type }]) => ({ providerId, type })),
		modify: (providerId, update, options) =>
			serialized(async () => {
				const credentials = await load();
				const next = await update(credentials[providerId]);
				if (next === undefined) return credentials[providerId];
				await save({ ...credentials, [providerId]: next });
				return next;
			}, options?.signal),
		delete: (providerId, options) =>
			serialized(async () => {
				const { [providerId]: _, ...rest } = await load();
				await save(rest);
			}, options?.signal),
	};
}
