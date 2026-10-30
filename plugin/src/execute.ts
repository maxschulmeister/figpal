// Runs Plugin API JavaScript from the model. Pure logic, so tests can run it without Figma.

import { type Attachment, EXECUTE_OUTPUT_LIMIT, EXECUTE_TIMEOUT_MS, type NodeSummary, type Result } from "@figpal/shared";

type Helpers = {
	/** Sends a file to the UI with the result. */
	attach(bytes: Uint8Array, options: { mime: string; name: string }): void;
};

type ExecuteResult = Result<"execute"> & { attachments: Attachment[] };

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
function compile(code: string): (figma: unknown, pi: Helpers) => Promise<unknown> {
	// biome-ignore lint/security/noGlobalEval: figma_execute exists to run the model's code.
	const indirectEval = eval;
	return indirectEval(`(async function (figma, pi) {\n${code}\n})`);
}

export async function execute(
	code: string,
	options: { figma: unknown; timeoutMs?: number },
): Promise<ExecuteResult> {
	const timeoutMs = Math.min(Math.max(options.timeoutMs ?? EXECUTE_TIMEOUT_MS.default, 1), EXECUTE_TIMEOUT_MS.max);
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
export function serialize(value: unknown, limit = EXECUTE_OUTPUT_LIMIT): Result<"execute"> {
	if (value === undefined) return { value: "undefined (use `return` to send a value)" };
	// No indentation: it makes the output up to 2 times larger, and each result stays in the transcript.
	const json = JSON.stringify(value, replacer) ?? String(value);
	if (json.length <= limit) return { value: json };
	return { value: `${json.slice(0, limit)}\n… [output truncated: ${json.length} characters, limit ${limit}]` };
}

function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) return { type: "Uint8Array", length: value.length };
	if (typeof value === "bigint") return value.toString();
	if (isNode(value)) return { id: value.id, name: value.name, type: value.type };
	return value;
}

/** A Figma node has only `id` as an own property, so JSON.stringify would give `{"id":…}`. */
function isNode(value: unknown): value is NodeSummary {
	if (typeof value !== "object" || value === null) return false;
	const node = value as Record<string, unknown>;
	return typeof node.id === "string" && typeof node.type === "string" && "removed" in node;
}
