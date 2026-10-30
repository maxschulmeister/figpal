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

const REMOTE = location.hostname !== "localhost";

/** What must pass on this origin, and how to run it. Other results (for example "0.4 codex-direct") are facts. */
const TODO: [id: string, how: string][] = [
	["0.0", "Automatic when the page opens."],
	["0.1 restart", "Click “0.1 Before restart”. Quit Figma, start it again, run FigPal."],
	["0.2", "Click “0.2 Network”."],
	["0.3", "Save the Claude token. Select a Claude model, click “Quick test”."],
	["0.4 device-login", "Click “A: Device login”."],
	["0.4 codex-route", "Click “A: Test route”."],
	["0.6", "Click “Run all checks” (Execute)."],
	["0.7", "Click “Resume test”, then “Send”. Close the plugin while the tool runs. Run FigPal again."],
	["0.8 anthropic", "Click “0.8 Search (Claude)”."],
	["0.8 openai-codex", "Click “0.8 Search (ChatGPT)”."],
	["0.9", "Click “0.9 Images”."],
	["0.10", "Automatic when the page opens."],
	["0.11", "Click “0.11 Hide for 10 s”."],
	...(REMOTE
		? ([
				["0.12", "Click “0.12 Reload with frame-ancestors”."],
				["0.13", "Automatic when the page opens."],
				["0.14", "Turn off Tailscale, run FigPal: the error page must show. Turn on Tailscale, click “0.14 Error page showed”."],
			] satisfies [string, string][])
		: []),
	["0.15", "Click “0.15 Skills”."],
	["0.16", "Automatic when the page opens."],
];

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

/** A check is done when it passed, or when it recorded a fact (info). */
const done = (result: CheckResult | undefined) => result?.status === "pass" || result?.status === "info";

export function resultsView(): HTMLElement {
	const open = h("ol", { className: "open" });
	const body = h("tbody");
	const table = h("table", { hidden: true });
	const toggle = h("button", { type: "button" });
	toggle.onclick = () => {
		table.hidden = !table.hidden;
		void render();
	};
	const render = async () => {
		const results = await all();
		const byId = new Map(results.map((r) => [r.id, r]));
		const missing = TODO.filter(([id]) => !done(byId.get(id)));
		open.replaceChildren(
			...missing.map(([id, how]) => {
				const last = byId.get(id);
				return h(
					"li",
					{},
					h("strong", {}, `${id} ${CHECKS[id.split(" ")[0] ?? id] ?? ""}`),
					h("br"),
					how,
					last && h("br"),
					last && h("small", { className: "fail" }, `Last result (${last.status}): ${last.detail}`),
				);
			}),
		);
		if (missing.length === 0) open.replaceChildren(h("li", {}, "All checks on this origin are done."));
		toggle.textContent = table.hidden ? `Show all results (${results.length})` : "Hide all results";
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
	table.append(h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Check"), h("th", {}, "Status"), h("th", {}, "Detail"))), body);
	return h("div", {}, h("p", { className: "muted" }, "Open checks on this origin:"), open, h("div", { className: "row" }, toggle, copy), table);
}
