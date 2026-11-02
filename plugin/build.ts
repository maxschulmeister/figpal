// Builds src/code.ts to dist/code.js. Node runs this TypeScript file directly; tsconfig.build.json checks it (Node types,
// which the Figma sandbox of src/ must not have).
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const context = await esbuild.context({
	entryPoints: ["src/code.ts"],
	outfile: "dist/code.js",
	bundle: true,
	// A conservative target for the Figma sandbox.
	target: "es2017",
	logLevel: "info",
});

if (watch) {
	await context.watch();
} else {
	await context.rebuild();
	await context.dispose();
}
