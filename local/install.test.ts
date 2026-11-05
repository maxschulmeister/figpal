import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appFolder, command, install, launchAgent, type Probe, stableNode, type System, uninstall } from "./install.ts";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `figpal-${name}-`));

/** The dist folder of the package: the command, a UI build and the plugin. */
function pack(assets: string[]) {
	const from = temp("pack");
	writeFileSync(join(from, "cli.mjs"), "// cli");
	mkdirSync(join(from, "ui", "assets"), { recursive: true });
	writeFileSync(join(from, "ui", "index.html"), assets.join(","));
	for (const name of assets) writeFileSync(join(from, "ui", "assets", name), name);
	mkdirSync(join(from, "plugin"));
	writeFileSync(join(from, "plugin", "manifest.json"), "{}");
	writeFileSync(join(from, "plugin", "code.js"), "// code");
	return from;
}

/** A Mac in a folder: a home, a node, and fake system calls. FigPal answers on its port after the LaunchAgent starts. */
function mac(before: Probe = { kind: "free" }, refusedStarts = 0) {
	const home = temp("home");
	const bin = temp("bin");
	const where = { home, node: join(bin, "node"), uid: 501, version: "1.0.0" };
	const runs: string[] = [];
	const logs: string[] = [];
	const copied: string[] = [];
	let started = false;
	const system: System = {
		run(command, args) {
			runs.push([command, ...args].join(" "));
			if (command === "launchctl" && args[0] === "bootstrap") {
				if (refusedStarts-- > 0) return false;
				started = true;
			}
			if (command === "launchctl" && args[0] === "bootout") started = false;
			return true;
		},
		copy: (text) => copied.push(text),
		probe: async () => (started ? { kind: "figpal", version: "1.0.0" } : before),
		log: (line) => logs.push(line),
	};
	return { where, system, runs, logs, copied, app: appFolder(home) };
}

describe("install", () => {
	it("copies FigPal to a fixed folder, starts it at login, and says how to import the plugin", async () => {
		const { where, system, runs, logs, copied, app } = mac();
		await install(pack(["index-a.js"]), where, system);

		expect(readFileSync(join(app, "cli.mjs"), "utf8")).toBe("// cli");
		expect(readFileSync(join(app, "ui", "assets", "index-a.js"), "utf8")).toBe("index-a.js");
		const manifest = join(app, "plugin", "manifest.json");
		expect(existsSync(manifest)).toBe(true);
		const plist = readFileSync(join(where.home, "Library", "LaunchAgents", "dev.figpal.local.plist"), "utf8");
		expect(plist).toContain(`<array><string>${where.node}</string><string>${join(app, "cli.mjs")}</string></array>`);
		const bin = join(where.node, "..", "figpal");
		expect(readFileSync(bin, "utf8")).toBe(command({ node: where.node, cli: join(app, "cli.mjs") }));
		expect(runs).toEqual([
			"launchctl bootout gui/501/dev.figpal.local",
			`launchctl bootstrap gui/501 ${join(where.home, "Library", "LaunchAgents", "dev.figpal.local.plist")}`,
			"claude mcp remove --scope user figpal",
			`claude mcp add --scope user figpal -- ${join(where.node, "..", "figpal")} mcp`,
		]);
		// The first install: the user imports the plugin once, from the fixed folder.
		expect(copied).toEqual([manifest]);
		expect(logs.join("\n")).toContain(manifest);
		expect(logs[0]).toBe("FigPal 1.0.0 runs, and starts at login.");
	});

	it("updates: keeps the UI files of earlier builds for 30 days, and needs no new import", async () => {
		const { where, system, logs, copied, app } = mac();
		await install(pack(["index-a.js", "old.js"]), where, system);
		const month = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
		utimesSync(join(app, "ui", "assets", "old.js"), month, month);
		logs.length = 0;
		await install(pack(["index-b.js"]), where, system);

		// An open FigPal window loads parts of its build later.
		expect(existsSync(join(app, "ui", "assets", "index-a.js"))).toBe(true);
		expect(existsSync(join(app, "ui", "assets", "old.js"))).toBe(false);
		expect(readFileSync(join(app, "ui", "index.html"), "utf8")).toBe("index-b.js");
		expect(copied).toHaveLength(1);
		expect(logs.join("\n")).not.toContain("manifest.json");
	});

	// User test: right after the stop of the old helper, macOS refused the start; a second install worked.
	it("tries the start again while macOS still stops the old FigPal", async () => {
		const { where, system, runs, logs } = mac({ kind: "free" }, 1);
		await install(pack(["index-a.js"]), where, system);
		expect(runs.filter((run) => run.startsWith("launchctl bootstrap"))).toHaveLength(2);
		expect(logs[0]).toBe("FigPal 1.0.0 runs, and starts at login.");
	});

	it("stops before it changes anything when another program uses FigPal's port", async () => {
		const { where, system, runs, app } = mac({ kind: "other", program: "python3" });
		await expect(install(pack(["index-a.js"]), where, system)).rejects.toThrow("The port 9310 is in use by python3.");
		expect(runs).toEqual([]);
		expect(existsSync(app)).toBe(false);
	});

	// `figpal install` of the installed command would copy its own files onto themselves, after it stopped FigPal.
	it("refuses an install from the installed folder, before it stops FigPal", async () => {
		const { where, system, runs, app } = mac();
		await install(pack(["index-a.js"]), where, system);
		runs.length = 0;
		await expect(install(app, where, system)).rejects.toThrow("This is the installed FigPal. To update it, run npx figpal@latest install");
		expect(runs).toEqual([]);
	});

	it("replaces a figpal link without a change to the file that it links to", async () => {
		const { where, system } = mac();
		const target = join(temp("global"), "cli.mjs");
		writeFileSync(target, "// npm's figpal");
		symlinkSync(target, join(where.node, "..", "figpal"));
		await install(pack(["index-a.js"]), where, system);
		expect(readFileSync(target, "utf8")).toBe("// npm's figpal");
	});

	it("uninstalls all, but keeps the shared folders", async () => {
		const { where, system, runs, logs, app } = mac();
		await install(pack(["index-a.js"]), where, system);
		runs.length = 0;
		uninstall(where, system);
		expect(existsSync(app)).toBe(false);
		expect(existsSync(join(where.node, "..", "figpal"))).toBe(false);
		expect(existsSync(join(where.home, "Library", "LaunchAgents", "dev.figpal.local.plist"))).toBe(false);
		expect(runs).toEqual(["launchctl bootout gui/501/dev.figpal.local", "claude mcp remove --scope user figpal"]);
		expect(logs.join("\n")).toContain("~/.config/figpal/local.json");
	});

	// A Homebrew update replaces the program, not the link on the PATH: the LaunchAgent must use the link.
	it("uses the node of the PATH when it is the same program", () => {
		const cellar = temp("cellar");
		const real = join(cellar, "node");
		writeFileSync(real, "");
		const bin = temp("bin");
		symlinkSync(real, join(bin, "node"));
		expect(stableNode(real, [temp("other"), bin].join(":"))).toBe(join(bin, "node"));
		expect(stableNode(real, temp("other"))).toBe(real);
	});

	it("starts the command at login, and again when it stops", () => {
		const plist = launchAgent({ node: "/opt/node", cli: "/Users/a & b/FigPal/cli.mjs", log: "/Users/a/Library/Logs/figpal.log" });
		expect(plist).toContain("<string>dev.figpal.local</string>");
		// The paths are XML: "&" must be escaped.
		expect(plist).toContain("<array><string>/opt/node</string><string>/Users/a &amp; b/FigPal/cli.mjs</string></array>");
		expect(plist).toContain("<key>RunAtLoad</key><true/>");
		expect(plist).toContain("<key>KeepAlive</key><true/>");
		expect(plist).toContain("<key>StandardErrorPath</key><string>/Users/a/Library/Logs/figpal.log</string>");
	});

	// figpal: a short command, next to node (on the PATH where this node is). Agents run `figpal mcp`.
	it("makes the figpal command", () => {
		expect(command({ node: "/opt/node", cli: "/Users/a b/FigPal/cli.mjs" })).toBe(
			`#!/bin/sh\n# The FigPal command (figpal install).\nexec '/opt/node' '/Users/a b/FigPal/cli.mjs' "$@"\n`,
		);
	});
});
