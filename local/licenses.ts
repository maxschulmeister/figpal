// The licenses of the libraries in a bundle, as Markdown, for the builds of the UI (web/vite.config.ts) and of the npm
// package (local/build.ts). Vite's own license file fails on a package with a license folder.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** `files`: the files in the bundle. Each library: its name, version, license and license text. */
export function licenses(title: string, files: Iterable<string>): string {
	const folders = new Map<string, string>();
	for (const file of files) {
		// The last node_modules in the path: pnpm keeps each package in .pnpm/<id>/node_modules/<name>.
		const folder = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1];
		if (!folder) continue;
		const { name, version } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { name: string; version: string };
		folders.set(`${name}@${version}`, folder);
	}
	const sections = [...folders].sort(([a], [b]) => a.localeCompare(b)).map(([id, folder]) => {
		const { license } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { license?: unknown };
		const text = readdirSync(folder)
			.filter((name) => /^(licen[cs]e|copying)/i.test(name) && statSync(join(folder, name)).isFile())
			.map((name) => readFileSync(join(folder, name), "utf8").trim())
			.join("\n\n");
		return `## ${id}${typeof license === "string" ? ` (${license})` : ""}\n\n${text || "The package has no license file."}`;
	});
	return `# ${title}\n\n${sections.join("\n\n")}\n`;
}
