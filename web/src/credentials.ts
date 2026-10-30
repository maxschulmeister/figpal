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

/** All credentials are one clientStorage value. Writes run one after the other, so a write cannot lose another one. */
export function clientStorageCredentials(bridge: Pick<Bridge, "request">): CredentialStore {
	const load = async (): Promise<Credentials> => {
		const { result } = await bridge.request("storage-get", { key: KEY });
		return isCredentials(result) ? result : {};
	};
	const save = (credentials: Credentials) => bridge.request("storage-set", { key: KEY, value: credentials });

	let writes: Promise<unknown> = Promise.resolve();
	const serialized = <T>(write: () => Promise<T>): Promise<T> => {
		const run = writes.then(write);
		writes = run.catch(() => undefined);
		return run;
	};

	return {
		read: async (providerId) => (await load())[providerId],
		list: async () => Object.entries(await load()).map(([providerId, { type }]) => ({ providerId, type })),
		modify: (providerId, update) =>
			serialized(async () => {
				const credentials = await load();
				const next = await update(credentials[providerId]);
				if (next === undefined) return credentials[providerId];
				await save({ ...credentials, [providerId]: next });
				return next;
			}),
		delete: (providerId) =>
			serialized(async () => {
				const { [providerId]: _, ...rest } = await load();
				await save(rest);
			}),
	};
}
