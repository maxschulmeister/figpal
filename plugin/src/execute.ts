// Runs Plugin API JavaScript from the model. Pure logic, so tests can run it without Figma.

import type { Attachment, Result } from "@figpal/shared";

export const OUTPUT_LIMIT = 20_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;

export type Helpers = {
	/** Sends a file to the UI with the result. */
	attach(bytes: Uint8Array, options: { mime: string; name: string }): void;
};

export type ExecuteResult = Result<"execute"> & { attachments: Attachment[] };

/** The wait timed out. The sandbox cannot stop the code: `running` settles when the code ends, if it ends. */
export class ExecuteTimeout extends Error {
	constructor(
		timeoutMs: number,
		readonly running: Promise<unknown>,
	) {
		super(`Timed out after ${timeoutMs} ms. The code can still be running.`);
		this.name = "ExecuteTimeout";
	}
}

/**
 * Compiles the code into an async function, so top-level `await` and `return` work.
 * Indirect `eval` runs in the global scope, so the code cannot see the locals of the plugin.
 */
export function compile(code: string): (figma: unknown, pi: Helpers) => Promise<unknown> {
	const indirectEval = eval;
	return indirectEval(`(async function (figma, pi) {\n${code}\n})`);
}

export async function execute(
	code: string,
	options: { figma: unknown; timeoutMs?: number },
): Promise<ExecuteResult> {
	const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
	const attachments: Attachment[] = [];
	const pi: Helpers = {
		attach(bytes, { mime, name }) {
			if (!(bytes instanceof Uint8Array)) throw new TypeError("pi.attach needs a Uint8Array");
			attachments.push({ bytes, mime, name });
		},
	};
	const run = compile(code)(options.figma, pi);
	let timer = 0;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ExecuteTimeout(timeoutMs, run)), timeoutMs);
	});
	try {
		const value = await Promise.race([run, timeout]);
		return { ...serialize(value), attachments };
	} finally {
		clearTimeout(timer);
	}
}

/** JSON for the model, with nodes as `{ id, name, type }` and an output limit. */
export function serialize(value: unknown, limit = OUTPUT_LIMIT): Result<"execute"> {
	if (value === undefined) return { value: "undefined (use `return` to send a value)", truncated: false };
	const json = JSON.stringify(value, replacer, 2) ?? String(value);
	if (json.length <= limit) return { value: json, truncated: false };
	return {
		value: `${json.slice(0, limit)}\n… [output truncated: ${json.length} characters, limit ${limit}]`,
		truncated: true,
	};
}

function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) return { type: "Uint8Array", length: value.length };
	if (typeof value === "bigint") return value.toString();
	if (isNode(value)) return { id: value.id, name: value.name, type: value.type };
	return value;
}

/** A Figma node has only `id` as an own property, so JSON.stringify would give `{"id":…}`. */
function isNode(value: unknown): value is { id: string; name: string; type: string } {
	if (typeof value !== "object" || value === null) return false;
	const node = value as Record<string, unknown>;
	return typeof node.id === "string" && typeof node.type === "string" && "removed" in node;
}
