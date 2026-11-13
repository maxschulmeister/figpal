// The installed skills, for all files: IndexedDB "figpal:global" on the UI origin. The files of a skill are in their
// own store, so that the list does not load them (one skill can have 650 KB of references). Version 2 adds "meta":
// it records that the default skills were installed, next to the skills, so a cleared database gets them again.

/** A folder in a GitHub repository. `path` is "" for a skill at the top of the repository. */
export type GitHubFolder = { owner: string; repo: string; ref: string; path: string };

export type SkillSource = { kind: "skills.sh"; id: string } | ({ kind: "github" } & GitHubFolder) | { kind: "zip"; file: string };

export type SkillFile = { path: string; contents: string };

export type Skill = {
	name: string;
	description: string;
	source: SkillSource;
	/** From the source: the skills.sh hash, or the GitHub tree SHA of the folder. An update compares it. */
	hash: string;
	enabled: boolean;
};

const SKILLS = "skills";
const FILES = "files";
const META = "meta";

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
	const opened =
		database ??
		new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("figpal:global", 3);
			request.onupgradeneeded = (event) => {
				if (event.oldVersion < 1) {
					request.result.createObjectStore(SKILLS, { keyPath: "name" });
					request.result.createObjectStore(FILES);
				}
				if (event.oldVersion < 2) request.result.createObjectStore(META);
				// Agent profiles (a later idea) added this store. It stays, so that all databases are the same:
				// a database cannot go back to a lower version.
				if (event.oldVersion < 3) request.result.createObjectStore("agents", { keyPath: "name" });
			};
			request.onsuccess = () => {
				// A newer FigPal in another window upgrades the database: let it, and open it again on the next use.
				request.result.onversionchange = () => {
					request.result.close();
					database = undefined;
				};
				resolve(request.result);
			};
			request.onblocked = () => reject(new Error("Another FigPal window blocks the skills database. Close it."));
			request.onerror = () => reject(request.error);
		}).catch((error: unknown): never => {
			database = undefined;
			throw error;
		});
	database = opened;
	return opened;
}

/** Runs `work` in one transaction and resolves with its request's result (if any) when the transaction commits. */
async function transaction<T>(
	stores: string[],
	mode: IDBTransactionMode,
	work: (transaction: IDBTransaction) => IDBRequest<T> | undefined,
): Promise<T> {
	const db = await open();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(stores, mode);
		const request = work(tx);
		tx.oncomplete = () => resolve(request?.result as T);
		// An error aborts the transaction. On abort, tx.error has the cause (on error, it can still be null).
		tx.onabort = () => reject(tx.error);
	});
}

export async function listSkills(): Promise<Skill[]> {
	const skills = await transaction<Skill[]>([SKILLS], "readonly", (tx) => tx.objectStore(SKILLS).getAll());
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillFiles(name: string): Promise<SkillFile[] | undefined> {
	return transaction([FILES], "readonly", (tx) => tx.objectStore(FILES).get(name));
}

/** Adds the skill, or replaces it with its files. */
export function saveSkill(skill: Skill, files: SkillFile[]): Promise<void> {
	return transaction([SKILLS, FILES], "readwrite", (tx) => {
		tx.objectStore(SKILLS).put(skill);
		tx.objectStore(FILES).put(files, skill.name);
		return undefined;
	});
}

export function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
	return transaction([SKILLS], "readwrite", (tx) => {
		const store = tx.objectStore(SKILLS);
		const request = store.get(name);
		request.onsuccess = () => {
			if (request.result) store.put({ ...request.result, enabled });
		};
		return undefined;
	});
}

export function removeSkill(name: string): Promise<void> {
	return transaction([SKILLS, FILES], "readwrite", (tx) => {
		tx.objectStore(SKILLS).delete(name);
		tx.objectStore(FILES).delete(name);
		return undefined;
	});
}

export async function defaultSkillsInstalled(): Promise<boolean> {
	return (await transaction([META], "readonly", (tx) => tx.objectStore(META).get("defaultSkills"))) === true;
}

export function markDefaultSkillsInstalled(): Promise<void> {
	return transaction([META], "readwrite", (tx) => {
		tx.objectStore(META).put(true, "defaultSkills");
		return undefined;
	});
}
