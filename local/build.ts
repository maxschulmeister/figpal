// Builds the npm package "figpal" in dist/: the command (one file, with its dependencies), FigPal's UI, the plugin and
// the license. `pnpm package` at the repo root builds the UI and the plugin first.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
for (const built of ["../web/dist/index.html", "../plugin/dist/code.js"])
	if (!existsSync(built)) throw new Error(`${built} is missing. Run pnpm package at the repo root.`);

rmSync("dist", { recursive: true, force: true });
await esbuild.build({
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
	logLevel: "warning",
});
cpSync("../web/dist", "dist/ui", { recursive: true });
mkdirSync("dist/plugin");
cpSync("../plugin/dist/code.js", "dist/plugin/code.js");
// In the package, code.js is next to the manifest.
const manifest = JSON.parse(readFileSync("../plugin/manifest.json", "utf8")) as { main: string };
writeFileSync("dist/plugin/manifest.json", `${JSON.stringify({ ...manifest, main: "code.js" }, null, "\t")}\n`);
if (existsSync("../LICENSE")) cpSync("../LICENSE", "dist/LICENSE");
console.log(`figpal ${version}: dist/`);
