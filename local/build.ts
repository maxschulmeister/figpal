// Builds the npm package "figpal" in dist/: the command (one file, with its dependencies), FigPal's UI, the plugin, the
// license and the notices, with the licenses of the bundled libraries. `pnpm package` at the repo root builds the UI
// and the plugin first.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { licenses } from "./licenses.ts";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
for (const built of ["../web/dist/index.html", "../plugin/dist/code.js", "../plugin/dist/meta.json"])
	if (!existsSync(built)) throw new Error(`${built} is missing. Run pnpm package at the repo root.`);

rmSync("dist", { recursive: true, force: true });
const { metafile } = await esbuild.build({
	entryPoints: ["cli.ts"],
	outfile: "dist/cli.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	define: { FIGPAL_VERSION: JSON.stringify(version) },
	// ws is CommonJS: its require calls need a require in an ES module. Its native add-ons are optional.
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
	external: ["bufferutil", "utf-8-validate"],
	metafile: true,
	logLevel: "warning",
});
cpSync("../web/dist", "dist/ui", { recursive: true });
mkdirSync("dist/plugin");
cpSync("../plugin/dist/code.js", "dist/plugin/code.js");
// In the package, code.js is next to the manifest.
const manifest = JSON.parse(readFileSync("../plugin/manifest.json", "utf8")) as { main: string };
writeFileSync("dist/plugin/manifest.json", `${JSON.stringify({ ...manifest, main: "code.js" }, null, "\t")}\n`);
const plugin = JSON.parse(readFileSync("../plugin/dist/meta.json", "utf8")) as esbuild.Metafile;
// The inputs of esbuild's metafiles are paths from the folder of each build.
const files = [...Object.keys(metafile.inputs), ...Object.keys(plugin.inputs).map((input) => join("../plugin", input))];
writeFileSync("dist/licenses.md", licenses("Licenses of the libraries in the FigPal command and the plugin", files));
cpSync("../LICENSE", "dist/LICENSE");
cpSync("../THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md");
console.log(`figpal ${version}: dist/`);
