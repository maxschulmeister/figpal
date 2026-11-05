// A backup of FigPal's data on this origin: the IndexedDB databases "figpal:…", that is the chats of each file and the
// skills. The data belongs to the origin of the UI, so a new origin starts empty: export on the old one, import on the
// new one. The keys stay out (the file has no secrets). Settings and the rules are in clientStorage and in the files:
// they do not belong to the origin.
//
// The file has one JSON line for each record (pi-durable keeps JSON records: it also has a JSONL storage). Line 1 is
// the header. A database line has the schema, and the record lines after it go into that database.

const PREFIX = "figpal:";
const HEADER = { figpal: "backup", version: 1 } as const;
/** Records for each read or write transaction. */
const PAGE = 500;
/** The import waits here while FigPal starts again: nothing has the databases open then. Not "figpal:": not exported. */
const STAGE = "figpal-import";

type Index = { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean };
type Store = { name: string; keyPath: string | string[] | null; autoIncrement: boolean; indexes: Index[] };
type DatabaseLine = { database: string; version: number; stores: Store[] };
/** `key` only for a store without a key path. */
type RecordLine = { store: string; key?: IDBValidKey; value: unknown };

export type BackupSummary = { files: number; skills: boolean };

const done = <T>(request: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
const committed = (transaction: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		// On abort, the error has the cause.
		transaction.onabort = () => reject(transaction.error);
	});

function open(factory: IDBFactory, name: string, version?: number, upgrade?: (database: IDBDatabase) => void) {
	const request = factory.open(name, version);
	if (upgrade) request.onupgradeneeded = () => upgrade(request.result);
	return done(request);
}

/** IndexedDB keeps more than JSON. A value that JSON would change must stop the export, not go out as "{}". */
function json(value: unknown): string {
	return JSON.stringify(value, (_key, item) => {
		if (item instanceof Blob || item instanceof ArrayBuffer || ArrayBuffer.isView(item) || item instanceof Map || item instanceof Set)
			throw new Error(`FigPal cannot put a ${item.constructor.name} in a backup.`);
		return item;
	});
}

function schema(database: IDBDatabase): Store[] {
	const names = [...database.objectStoreNames];
	if (!names.length) return [];
	const transaction = database.transaction(names, "readonly");
	return names.map((name) => {
		const store = transaction.objectStore(name);
		const indexes = [...store.indexNames].map((indexName) => {
			const { keyPath, unique, multiEntry } = store.index(indexName);
			return { name: indexName, keyPath, unique, multiEntry };
		});
		return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes };
	});
}

/** The records of a store, a page at a time: a transaction ends while the code waits for something else. */
async function* records(database: IDBDatabase, store: Store): AsyncGenerator<RecordLine> {
	let after: IDBValidKey | undefined;
	for (;;) {
		const transaction = database.transaction(store.name, "readonly");
		const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
		const [keys, values] = await Promise.all([
			done(transaction.objectStore(store.name).getAllKeys(range, PAGE)),
			done(transaction.objectStore(store.name).getAll(range, PAGE)),
		]);
		for (const [index, value] of values.entries())
			yield store.keyPath === null ? { store: store.name, key: keys[index]!, value } : { store: store.name, value };
		if (keys.length < PAGE) return;
		after = keys.at(-1);
	}
}

/** All FigPal databases of this origin, as a backup file. */
export async function exportData(factory: IDBFactory = indexedDB): Promise<Blob> {
	const lines = [json(HEADER)];
	const names = (await factory.databases()).flatMap(({ name }) => (name?.startsWith(PREFIX) ? [name] : [])).sort();
	for (const name of names) {
		const database = await open(factory, name);
		try {
			const stores = schema(database);
			lines.push(json({ database: name, version: database.version, stores } satisfies DatabaseLine));
			for (const store of stores) for await (const record of records(database, store)) lines.push(json(record));
		} finally {
			database.close();
		}
	}
	return new Blob(lines.map((line) => `${line}\n`), { type: "application/jsonl" });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isKeyPath = (value: unknown): value is string | string[] =>
	typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));

function isDatabaseLine(value: Record<string, unknown>): value is DatabaseLine {
	return (
		typeof value.database === "string" &&
		value.database.startsWith(PREFIX) &&
		Number.isInteger(value.version) &&
		(value.version as number) > 0 &&
		Array.isArray(value.stores) &&
		value.stores.every(
			(store) =>
				isRecord(store) &&
				typeof store.name === "string" &&
				(store.keyPath === null || isKeyPath(store.keyPath)) &&
				typeof store.autoIncrement === "boolean" &&
				Array.isArray(store.indexes) &&
				store.indexes.every(
					(index) =>
						isRecord(index) &&
						typeof index.name === "string" &&
						isKeyPath(index.keyPath) &&
						typeof index.unique === "boolean" &&
						typeof index.multiEntry === "boolean",
				),
		)
	);
}

/** The lines of a backup file, checked. The UI checks the whole file (`checkBackup`) before an import changes anything. */
async function* lines(file: Blob): AsyncGenerator<DatabaseLine | RecordLine> {
	const notBackup = () => new Error("This file is not a FigPal backup.");
	let number = 0;
	let database: DatabaseLine | undefined;
	let rest = "";
	const parse = (text: string): DatabaseLine | RecordLine | undefined => {
		number++;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			throw number === 1 ? notBackup() : new Error(`The backup is damaged (line ${number}).`);
		}
		if (number === 1) {
			if (!isRecord(value) || value.figpal !== HEADER.figpal) throw notBackup();
			if (value.version !== HEADER.version) throw new Error("This backup is from a newer FigPal. Update FigPal, then import it.");
			return undefined;
		}
		if (isRecord(value) && "database" in value) {
			if (!isDatabaseLine(value)) throw new Error(`The backup is damaged (line ${number}).`);
			database = value;
			return value;
		}
		const record = isRecord(value) ? value : {};
		const store = database?.stores.find((item) => item.name === record.store);
		if (!store || !("value" in record) || (store.keyPath === null) !== ("key" in record)) throw new Error(`The backup is damaged (line ${number}).`);
		return record as RecordLine;
	};
	const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
	for (;;) {
		const { value, done: end } = await reader.read();
		if (end) break;
		const parts = (rest + value).split("\n");
		rest = parts.pop()!;
		for (const part of parts) {
			const line = part && parse(part);
			if (line) yield line;
		}
	}
	const line = rest && parse(rest);
	if (line) yield line;
	if (number === 0) throw notBackup();
}

/** Checks the whole file, and says what is in it: the count of files with chats, and whether the skills are in it. */
export async function checkBackup(file: Blob): Promise<BackupSummary> {
	const summary: BackupSummary = { files: 0, skills: false };
	for await (const line of lines(file)) {
		if (!("database" in line)) continue;
		if (line.database.startsWith(`${PREFIX}file:`)) summary.files++;
		if (line.database === `${PREFIX}global`) summary.skills = true;
	}
	return summary;
}

/** Deletes a database. `onBlocked`: another FigPal window has it open, and the delete waits until it closes. */
function remove(factory: IDBFactory, name: string, onBlocked?: () => void) {
	const request = factory.deleteDatabase(name);
	request.onblocked = () => onBlocked?.();
	return done(request);
}

async function write(database: IDBDatabase, batch: RecordLine[]) {
	if (!batch.length) return;
	const transaction = database.transaction([...new Set(batch.map((record) => record.store))], "readwrite");
	for (const record of batch) transaction.objectStore(record.store).put(record.value, record.key);
	await committed(transaction);
}

/**
 * Writes the databases of a backup. Each one replaces the database of the same name; other databases stay. Nothing
 * may have them open: run it before FigPal opens its storage (see `stageImport`).
 */
export async function importData(file: Blob, options: { factory?: IDBFactory; onBlocked?(): void } = {}): Promise<void> {
	const factory = options.factory ?? indexedDB;
	let database: IDBDatabase | undefined;
	let batch: RecordLine[] = [];
	try {
		for await (const line of lines(file)) {
			if ("store" in line) {
				batch.push(line);
				if (batch.length === PAGE) {
					await write(database!, batch);
					batch = [];
				}
				continue;
			}
			if (database) {
				await write(database, batch);
				batch = [];
				database.close();
			}
			await remove(factory, line.database, options.onBlocked);
			database = await open(factory, line.database, line.version, (created) => {
				for (const store of line.stores) {
					const made = created.createObjectStore(store.name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement });
					for (const { name, keyPath, unique, multiEntry } of store.indexes) made.createIndex(name, keyPath, { unique, multiEntry });
				}
			});
		}
		if (database) await write(database, batch);
	} finally {
		database?.close();
	}
}

/** Keeps the file until FigPal starts again (`applyStagedImport`): until then, FigPal has its databases open. */
export async function stageImport(file: Blob, factory: IDBFactory = indexedDB): Promise<void> {
	const database = await open(factory, STAGE, 1, (created) => created.createObjectStore("file"));
	try {
		const transaction = database.transaction("file", "readwrite");
		transaction.objectStore("file").put(file, "file");
		await committed(transaction);
	} finally {
		database.close();
	}
}

/**
 * At the start, before FigPal opens its storage: imports a staged file, then deletes it, also after a failure (else
 * each start would fail again). `onStart` runs only when there is a file.
 */
export async function applyStagedImport(options: { factory?: IDBFactory; onStart?(): void; onBlocked?(): void } = {}): Promise<boolean> {
	const factory = options.factory ?? indexedDB;
	if (!(await factory.databases()).some(({ name }) => name === STAGE)) return false;
	const database = await open(factory, STAGE, 1, (created) => created.createObjectStore("file"));
	let file: unknown;
	try {
		file = await done(database.transaction("file", "readonly").objectStore("file").get("file"));
	} finally {
		database.close();
	}
	try {
		if (!(file instanceof Blob)) return false;
		options.onStart?.();
		await importData(file, options);
		return true;
	} finally {
		await remove(factory, STAGE);
	}
}
