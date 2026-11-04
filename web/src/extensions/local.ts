// The `local` extension: the files of the folders that the local helper shares (local/cli.ts). agent.ts installs it
// while a helper with folders is connected, so the tools cost no tokens without one.

import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { LocalFiles } from "../local";

const text = (value: string) => ({ type: "text" as const, text: value });
/** The answers of local_list and local_read are cut after this: a folder can have many files. */
const OUTPUT_BYTES = 40_000;

export function localExtension(files: LocalFiles, folders: string[]) {
	return defineExtension({
		name: "local",
		sections: [
			section(
				"local",
				() =>
					`The user shares folders of their machine: ${folders.join(", ")}. Paths start with the folder name, for example ${folders[0]}/README.md.`,
			),
		],
		tools: [
			defineTool({
				name: "local_list",
				description: "Lists a shared folder: its files, and its folders with / at the end. Without path: the shared folders.",
				parameters: obj({ path: opt(str()) }, { open: true }),
				outputLimits: { maxBytes: OUTPUT_BYTES, retain: "head" },
				replay: "safe",
				execute: async ({ path = "" }) => {
					const entries = (await files({ op: "list", path })) as string[];
					return { output: [text(entries.join("\n"))] };
				},
			}),
			defineTool({
				name: "local_read",
				description: "Reads a text file of a shared folder, at most 1 MB.",
				parameters: obj({ path: str() }, { open: true }),
				outputLimits: { maxBytes: OUTPUT_BYTES, retain: "head" },
				replay: "safe",
				execute: async ({ path }) => ({ output: [text((await files({ op: "read", path })) as string)] }),
			}),
			defineTool({
				name: "local_write",
				description: "Writes a text file in a shared folder, and makes its folders. It replaces a file that exists.",
				parameters: obj({ path: str(), content: str() }, { open: true }),
				// The same content again gives the same file.
				replay: "safe",
				execute: async ({ path, content }) => {
					await files({ op: "write", path, content });
					return { output: [text(`Wrote ${path}.`)] };
				},
			}),
		],
	});
}
