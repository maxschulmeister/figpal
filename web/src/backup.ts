// A backup of FigPal's data on this origin: the IndexedDB databases "figpal:…", that is the chats of each file and the
// skills. The data belongs to the origin of the UI, so a new origin starts empty: export on the old one, import on the
// new one. The keys stay out (the file has no secrets). Settings and the rules are in clientStorage and in the files:
// they do not belong to the origin.
//
// The file has one JSON line for each record (pi-durable keeps JSON records: it also has a JSONL storage). Line 1 is
// the header. A database line has the schema, and the record lines after it go into that database.

const PREFIX = "figpal:";
const HEADER = { figpal: "backup", version: 1 } as const;
/** Records for each write transaction. */
const PAGE = 500;
/** The import waits here while FigPal starts again: nothing has the databases open then. Not "figpal:": not exported. */
const STAGE = "figpal-import";
/** The import writes each database here first, next to the old one: a failure keeps the old data. Not exported. */
const scratch = (name: string) => `figpal-import:${name}`;

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

/** Deletes a database. `onBlocked`: another FigPal window has it open, and the delete waits until it closes. */
function remove(factory: IDBFactory, name: string, onBlocked?: () => void) {
	const request = factory.deleteDatabase(name);
	request.onblocked = () => onBlocked?.();
	return done(request);
}

/** A new database `name` with the schema of `line`, in place of a database of that name. */
async function create(factory: IDBFactory, name: string, line: DatabaseLine, onBlocked?: () => void) {
	await remove(factory, name, onBlocked);
	return open(factory, name, line.version, (created) => {
		for (const store of line.stores) {
			const made = created.createObjectStore(store.name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement });
			for (const { name, keyPath, unique, multiEntry } of store.indexes) made.createIndex(name, keyPath, { unique, multiEntry });
		}
	});
}

/** IndexedDB keeps more than JSON. A value that JSON would change must stop the export, not go out as "{}". */
function json(value: unknown): string {
	return JSON.stringify(value, (_key, item) => {
		if (item instanceof Blob || item instanceof ArrayBuffer || ArrayBuffer.isView(item) || item instanceof Map || item instanceof Set)
			throw new Error(`FigPal cannot put a ${item.constructor.name} in a backup.`);
		return item;
	});
}

/**
 * The schema and all records of a database, in one transaction: one state of the data. Separate transactions could
 * give a task without the entry that it names, when the agent writes during the export.
 */
async function snapshot(database: IDBDatabase): Promise<{ line: DatabaseLine; records: RecordLine[] }> {
	const names = [...database.objectStoreNames];
	const line: DatabaseLine = { database: database.name, version: database.version, stores: [] };
	if (!names.length) return { line, records: [] };
	const transaction = database.transaction(names, "readonly");
	const reads = names.map((name) => {
		const store = transaction.objectStore(name);
		const indexes = [...store.indexNames].map((indexName) => {
			const { keyPath, unique, multiEntry } = store.index(indexName);
			return { name: indexName, keyPath, unique, multiEntry };
		});
		line.stores.push({ name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes });
		return Promise.all([done(store.getAllKeys()), done(store.getAll())]);
	});
	const results = await Promise.all(reads);
	const records = line.stores.flatMap((store, index) => {
		const [keys, values] = results[index]!;
		return values.map((value, at): RecordLine => (store.keyPath === null ? { store: store.name, key: keys[at]!, value } : { store: store.name, value }));
	});
	return { line, records };
}

/** All FigPal databases of this origin, as a backup file. */
export async function exportData(factory: IDBFactory = indexedDB): Promise<Blob> {
	const lines = [json(HEADER)];
	const names = (await factory.databases()).flatMap(({ name }) => (name?.startsWith(PREFIX) ? [name] : [])).sort();
	for (const name of names) {
		const database = await open(factory, name);
		try {
			const { line, records } = await snapshot(database);
			lines.push(json(line), ...records.map(json));
		} finally {
			database.close();
		}
	}
	return new Blob(lines.map((line) => `${line}\n`), { type: "application/jsonl" });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isKeyPath = (value: unknown): value is string | string[] =>
	typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
/** A key that JSON can hold: a number, a string, or a list of keys. */
const isKey = (value: unknown): boolean =>
	(typeof value === "number" && !Number.isNaN(value)) || typeof value === "string" || (Array.isArray(value) && value.every(isKey));
/** The value at a key path such as "a.b"; "" is the value itself. */
const at = (value: unknown, path: string) => (path ? path.split(".").reduce<unknown>((item, part) => (isRecord(item) ? item[part] : undefined), value) : value);

/** A record has its key: in the line for a store without a key path, else in its value (a generated key can be absent). */
function hasKey(store: Store, record: Record<string, unknown>): boolean {
	if (store.keyPath === null) return isKey(record.key);
	if ("key" in record) return false;
	const paths = Array.isArray(store.keyPath) ? store.keyPath : [store.keyPath];
	return store.autoIncrement || paths.every((path) => isKey(at(record.value, path)));
}

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

/** The lines of a backup file, checked. */
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
		if (!store || !("value" in record) || !hasKey(store, record)) throw new Error(`The backup is damaged (line ${number}).`);
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

/** Writes records in transactions of PAGE records. */
async function fill(database: IDBDatabase, records: AsyncIterable<RecordLine> | Iterable<RecordLine>) {
	let batch: RecordLine[] = [];
	const write = async () => {
		if (!batch.length) return;
		const transaction = database.transaction([...new Set(batch.map((record) => record.store))], "readwrite");
		for (const record of batch) transaction.objectStore(record.store).put(record.value, record.key);
		batch = [];
		await committed(transaction);
	};
	for await (const record of records) {
		batch.push(record);
		if (batch.length === PAGE) await write();
	}
	await write();
}

/** The record lines up to the next database line, which goes to `next`. */
async function* recordsOf(source: AsyncIterator<DatabaseLine | RecordLine>, next: { line?: DatabaseLine }): AsyncGenerator<RecordLine> {
	for (;;) {
		const { value, done: end } = await source.next();
		if (end) return;
		if ("database" in value) {
			next.line = value;
			return;
		}
		yield value;
	}
}

/**
 * Writes the databases of a backup. Each one replaces the database of the same name; other databases stay. Nothing
 * may have them open: run it before FigPal opens its storage (see `stageImport`). First all databases go into new
 * databases next to the old ones; a damaged record or a full disk stops there, and the old data stays.
 */
export async function importData(file: Blob, options: { factory?: IDBFactory; onBlocked?(): void } = {}): Promise<void> {
	const factory = options.factory ?? indexedDB;
	const written: DatabaseLine[] = [];
	try {
		const source = lines(file);
		const next: { line?: DatabaseLine } = {};
		await recordsOf(source, next).next();
		while (next.line) {
			const line = next.line;
			next.line = undefined;
			written.push(line);
			const database = await create(factory, scratch(line.database), line);
			try {
				await fill(database, recordsOf(source, next));
			} finally {
				database.close();
			}
		}
	} catch (error) {
		for (const line of written) await remove(factory, scratch(line.database));
		throw error;
	}
	for (const line of written) {
		const source = await open(factory, scratch(line.database));
		const { records } = await snapshot(source).finally(() => source.close());
		const database = await create(factory, line.database, line, options.onBlocked);
		try {
			await fill(database, records);
		} finally {
			database.close();
		}
		await remove(factory, scratch(line.database));
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
 * each start would fail again; the old data stays then). `onStart` runs only when there is a file.
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
