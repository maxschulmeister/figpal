// Newer model catalogs from pi.dev, as Pi gets them (pi-coding-agent's remote-catalog-provider.ts, ported to the
// browser): FigPal shows new models without a new release. A catalog that pi.dev gave stays in localStorage, also offline.

import { type AnyModel, type Api, getModelType, isModelType, type Model, type ModelsStore, type ModelsStoreEntry, type Provider } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";

const CATALOG_URL = "https://pi.dev/api/models/providers/";
/** Pi checks pi.dev at most every 4 hours. */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** The model types that FigPal reads: pi.dev sends all of them only when it gets this list. */
const MODEL_TYPES = ["chat", "image", "classifier"];

/** The bundled models, with the models of pi.dev in place of bundled models with the same ID. */
function merge(bundled: readonly AnyModel[], remote: readonly AnyModel[]): AnyModel[] {
	const merged = new Map<string, AnyModel>();
	for (const model of [...bundled, ...remote]) merged.set(`${getModelType(model)}\0${model.id}`, model);
	return [...merged.values()];
}

/** The models of a pi.dev response: a list of pi-ai models. Entries of model types that FigPal does not know stay out. */
function parseCatalog(providerId: string, value: unknown): AnyModel[] {
	if (!Array.isArray(value)) throw new Error(`pi.dev sent an invalid model catalog for ${providerId}`);
	return value
		.filter((entry): entry is AnyModel => typeof entry === "object" && entry !== null && typeof entry.id === "string")
		.filter((model) => model.type === undefined || MODEL_TYPES.includes(model.type))
		.map((model) => ({ ...model, provider: providerId }));
}

/** The models of a saved catalog that is newer than the bundled catalog. */
function newerModels(entry: ModelsStoreEntry | undefined, generatedAt: number | undefined): readonly AnyModel[] {
	const newer = generatedAt === undefined || (entry?.lastModified !== undefined && entry.lastModified > generatedAt);
	return entry && newer ? entry.models : [];
}

/** The saved catalogs, one localStorage item for each provider. A damaged item is as if FigPal had none. */
export function localModelsStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage): ModelsStore {
	const key = (providerId: string) => `figpal.models.${providerId}`;
	return {
		read: async (providerId) => {
			let value: unknown;
			try {
				value = JSON.parse(storage.getItem(key(providerId)) ?? "null");
			} catch {
				return undefined;
			}
			const valid = typeof value === "object" && value !== null && Array.isArray((value as ModelsStoreEntry).models);
			return valid ? (value as ModelsStoreEntry) : undefined;
		},
		write: async (providerId, entry) => storage.setItem(key(providerId), JSON.stringify(entry)),
		delete: async (providerId) => storage.removeItem(key(providerId)),
	};
}

/** Adds the newer models of pi.dev to a provider with a bundled catalog. */
export function withRemoteCatalog<TApi extends Api>(provider: Provider<TApi>, generatedAt = getBuiltinModelDataGeneratedAt()): Provider<TApi> {
	let remote: readonly AnyModel[] = [];
	return {
		...provider,
		getModels: () => merge(provider.getModels(), remote.filter((model) => isModelType(model, "chat"))) as Model<TApi>[],
		getAllModels: () => merge(provider.getAllModels?.() ?? provider.getModels(), remote) as ReturnType<NonNullable<Provider<TApi>["getAllModels"]>>,
		// pi.dev serves the catalog: an old Claude or ChatGPT login must not stop or fail the refresh.
		refreshModelsAuth: "configured",
		refreshModels: async (context) => {
			const stored = context.stored;
			const restored = newerModels(stored, generatedAt).filter((model) => model.provider === provider.id);
			if (!(await context.publish({ update: () => (remote = restored) }))) return;
			if (!context.allowNetwork || context.signal.aborted) return;
			const fresh = stored?.checkedAt !== undefined && stored.lastModified !== undefined && Date.now() - stored.checkedAt < REFRESH_INTERVAL_MS;
			if (fresh && !context.force) return;

			const url = new URL(encodeURIComponent(provider.id), CATALOG_URL);
			url.searchParams.set("types", MODEL_TYPES.join(","));
			// The ETag only when a saved list backs it: a 304 must not leave the list empty.
			const etag = stored && stored.models.length > 0 ? stored.etag : undefined;
			const response = await fetch(url, { headers: { accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) }, signal: context.signal });
			const checkedAt = Date.now();
			if (response.status === 304 && stored) {
				await context.publish({ persist: { ...stored, checkedAt } });
				return;
			}
			// pi.dev has no catalog for this provider.
			if (response.status === 404 || response.status === 501) {
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt, lastModified: 0, etag: undefined } });
				return;
			}
			if (!response.ok) {
				// The saved list and its ETag stay: the next refresh asks again.
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
				throw new Error(`pi.dev did not send the model catalog of ${provider.id}: ${response.status}`);
			}
			const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
			const entry: ModelsStoreEntry = {
				models: parseCatalog(provider.id, await response.json()),
				lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
				etag: response.headers.get("etag") ?? undefined,
				checkedAt,
			};
			const models = newerModels(entry, generatedAt);
			await context.publish({ persist: entry, update: () => (remote = models) });
		},
	};
}
