// Spike results, kept in IndexedDB so that they survive a restart of Figma.

import { copyText, h } from "./ui";

export type Status = "pass" | "fail" | "info" | "todo";
export type CheckResult = { id: string; title: string; status: Status; detail: string; at: string; origin: string };

export const CHECKS: Record<string, string> = {
	"0.0": "Messages between code.js and the UI",
	"0.1": "IndexedDB in the hosted iframe",
	"0.2": "networkAccess with a hosted iframe",
	"0.3": "Claude setup-token from the iframe",
	"0.4": "ChatGPT",
	"0.5": "pi-durable browser bundle",
	"0.6": "Execute",
	"0.7": "Resume",
	"0.8": "Provider-native search",
	"0.9": "createImageAsync",
	"0.10": "figma.fileKey",
	"0.11": "Hidden UI",
	"0.12": "frame-ancestors https://www.figma.com",
	"0.13": "Tailscale DNS in Figma Desktop",
	"0.14": "Tailscale off",
	"0.15": "skills.sh",
	"0.16": "Theme colors in the hosted iframe",
};

const DB_NAME = "figpal:spike";

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore("results", { keyPath: "key" });
			request.result.createObjectStore("visits", { autoIncrement: true });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

const db = open();

async function run<T>(store: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const transaction = (await db).transaction(store, mode);
	const request = action(transaction.objectStore(store));
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve(request.result);
		transaction.onerror = () => reject(transaction.error);
	});
}

/** Adds a visit and returns all visits, oldest first. */
export async function addVisit(): Promise<{ at: string; origin: string }[]> {
	await run("visits", "readwrite", (store) => store.add({ at: new Date().toISOString(), origin: location.origin }));
	return run("visits", "readonly", (store) => store.getAll());
}

const listeners = new Set<() => void>();

/** The check number of an ID such as "0.4 codex-route", as a number for sorting. */
const checkNumber = (id: string) => Number(id.split(" ")[0]?.slice(2));

/** One result per check and origin, so local and hosted runs stay separate. IDs can have a part: "0.4 device". */
export async function record(id: string, status: Status, detail: string): Promise<void> {
	const title = CHECKS[id.split(" ")[0] ?? id] ?? id;
	const result: CheckResult = { id, title, status, detail, at: new Date().toISOString(), origin: location.origin };
	await run("results", "readwrite", (store) => store.put({ ...result, key: `${location.origin} ${id}` }));
	for (const listener of listeners) listener();
	if (import.meta.env.DEV) {
		// Best effort: only the Vite dev server has this route.
		void fetch("/__spike/results", { method: "POST", body: JSON.stringify(await all(), null, 2) }).catch(() => {});
	}
}

export async function all(): Promise<CheckResult[]> {
	const results = await run<CheckResult[]>("results", "readonly", (store) => store.getAll());
	return results.sort(
		(a, b) => checkNumber(a.id) - checkNumber(b.id) || a.id.localeCompare(b.id) || a.origin.localeCompare(b.origin),
	);
}

function markdown(results: CheckResult[]): string {
	const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
	const lines = ["| # | Check | Origin | Status | Detail |", "|---|---|---|---|---|"];
	for (const r of results) lines.push(`| ${r.id} | ${r.title} | ${r.origin} | ${r.status} | ${cell(r.detail)} |`);
	return lines.join("\n");
}

export function resultsView(): HTMLElement {
	const body = h("tbody");
	const render = async () => {
		const results = await all();
		body.replaceChildren(
			...results.map((r) =>
				h(
					"tr",
					{ className: r.status },
					h("td", {}, r.id),
					h("td", {}, r.title, h("br"), h("small", {}, r.origin)),
					h("td", {}, r.status),
					h("td", {}, h("small", {}, r.detail)),
				),
			),
		);
	};
	listeners.add(() => void render());
	void render();
	const copy = h("button", { type: "button" }, "Copy as Markdown");
	copy.onclick = async () => copyText(markdown(await all()));
	return h(
		"div",
		{},
		h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Check"), h("th", {}, "Status"), h("th", {}, "Detail"))), body),
		copy,
	);
}
