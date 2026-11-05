// Sets up FigPal on macOS: `npx figpal@latest install` (also for updates) and `npx figpal uninstall`.
//
// The install copies the command, the UI and the plugin to a fixed folder: npx keeps its files in a cache, and Figma and
// the LaunchAgent need paths that stay. It starts the command at login (a LaunchAgent), adds the command figpal next to
// node (agents run `figpal mcp`), and gives Claude Code FigPal's MCP server.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { INSTALL_COMMAND, UI_ORIGIN, UI_PORT } from "@figpal/shared";

const LABEL = "dev.figpal.local";
/** The first line of figpal after #!: the uninstall removes only this file. */
const MARK = "# The FigPal command (figpal install).";
/** Older installs (pnpm local:install) had this mark, and also the command figpal-mcp. */
const OLD_MARK = "# FigPal's MCP helper (pnpm local:install).";
/** The UI files of a build stay this long: an open FigPal window loads parts of its build later. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** What answers on FigPal's port: nothing, FigPal (its version), or another program. */
export type Probe = { kind: "free" } | { kind: "figpal"; version: string } | { kind: "other"; program: string };

/** The calls to the system, so that a test can run the install in a folder. */
export type System = {
	/** Runs a command. False when it fails: for example, `claude` is not installed. */
	run(command: string, args: string[]): boolean;
	/** Puts the text on the clipboard. */
	copy(text: string): void;
	probe(): Promise<Probe>;
	log(line: string): void;
};

/** The home folder, the node that runs FigPal, the user ID (for launchctl), and the version of this package. */
export type Where = { home: string; node: string; uid: number; version: string };

export const appFolder = (home: string) => join(home, "Library", "Application Support", "FigPal");

function paths({ home, node, uid }: Where) {
	const app = appFolder(home);
	return {
		app,
		cli: join(app, "cli.js"),
		manifest: join(app, "plugin", "manifest.json"),
		plist: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
		log: join(home, "Library", "Logs", "figpal.log"),
		bin: join(dirname(node), "figpal"),
		service: `gui/${uid}`,
	};
}

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The LaunchAgent: macOS starts the command at login, and again when it stops. */
export function launchAgent(paths: { node: string; cli: string; log: string }): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(paths.node)}</string><string>${xml(paths.cli)}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict></plist>
`;
}

const shell = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The figpal command: a shell script that runs the installed cli.js. */
export function command(paths: { node: string; cli: string }): string {
	return `#!/bin/sh\n${MARK}\nexec ${shell(paths.node)} ${shell(paths.cli)} "$@"\n`;
}

/** The node of the PATH when it is the same program: a Homebrew update replaces the program, not the link. */
export function stableNode(execPath: string, path = process.env.PATH ?? ""): string {
	const program = realpathSync(execPath);
	const linked = path.split(delimiter).find((folder) => folder && existsSync(join(folder, "node")) && realpathSync(join(folder, "node")) === program);
	return linked ? join(linked, "node") : execPath;
}

/** Copies the package's files. The UI files of earlier builds stay for 30 days. */
function copyFiles(from: string, app: string) {
	cpSync(join(from, "cli.js"), join(app, "cli.js"));
	cpSync(join(from, "plugin"), join(app, "plugin"), { recursive: true });
	// A copy has the time of the install, so the age of a file is the age of its build here.
	cpSync(join(from, "ui"), join(app, "ui"), { recursive: true });
	const assets = join(app, "ui", "assets");
	for (const name of readdirSync(assets)) if (Date.now() - statSync(join(assets, name)).mtimeMs > KEEP_MS) rmSync(join(assets, name));
}

/** Waits until this version of FigPal answers: right after the start of the LaunchAgent, the old one can still answer. */
async function started(system: System, version: string): Promise<boolean> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const probe = await system.probe();
		if (probe.kind === "figpal" && probe.version === version) return true;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
}

const ours = (file: string) => existsSync(file) && [MARK, OLD_MARK].some((mark) => readFileSync(file, "utf8").includes(mark));

export async function install(from: string, where: Where, system: System): Promise<void> {
	const p = paths(where);
	if (!existsSync(join(from, "ui", "index.html")) || !existsSync(join(from, "plugin", "manifest.json")))
		throw new Error(`${from} has no build of FigPal. In the FigPal repo, run pnpm local:install.`);
	const before = await system.probe();
	if (before.kind === "other")
		throw new Error(`The port ${UI_PORT} is in use by ${before.program}. FigPal needs this port. Stop that program, then run ${INSTALL_COMMAND} again.`);
	const first = !existsSync(p.manifest);
	// Stops FigPal of an earlier install.
	system.run("launchctl", ["bootout", `${p.service}/${LABEL}`]);
	copyFiles(from, p.app);
	mkdirSync(dirname(p.plist), { recursive: true });
	writeFileSync(p.plist, launchAgent({ node: where.node, cli: p.cli, log: p.log }));
	if (!system.run("launchctl", ["bootstrap", p.service, p.plist])) throw new Error(`macOS did not start FigPal. See: launchctl bootstrap ${p.service} ${p.plist}`);
	// A write to a link would change the file that it links to, for example the figpal of `npm install -g figpal`.
	rmSync(p.bin, { force: true });
	if (ours(join(dirname(p.bin), "figpal-mcp"))) rmSync(join(dirname(p.bin), "figpal-mcp"));
	writeFileSync(p.bin, command({ node: where.node, cli: p.cli }), { mode: 0o755 });
	system.run("claude", ["mcp", "remove", "--scope", "user", "figpal"]);
	// The full path: Claude Code can start it also without this node on its PATH.
	const claude = system.run("claude", ["mcp", "add", "--scope", "user", "figpal", "--", p.bin, "mcp"]);
	if (!(await started(system, where.version))) throw new Error(`FigPal did not start. See the log: ${p.log}`);

	system.log(`FigPal ${where.version} runs, and starts at login.`);
	system.log(`${claude ? "Claude Code has FigPal's MCP server. Other agents" : "For an agent"}: <agent> mcp add figpal -- figpal mcp`);
	if (first) {
		system.copy(p.manifest);
		system.log("Now import the plugin in Figma Desktop, once: Plugins → Development → Import plugin from manifest…, then choose");
		system.log(`  ${p.manifest}`);
		system.log("The path is on the clipboard: in the file dialog, press Cmd+Shift+G and paste it.");
	} else system.log("Run FigPal again in Figma to use the new version.");
}

export function uninstall(where: Where, system: System): void {
	const p = paths(where);
	system.run("launchctl", ["bootout", `${p.service}/${LABEL}`]);
	rmSync(p.plist, { force: true });
	system.run("claude", ["mcp", "remove", "--scope", "user", "figpal"]);
	for (const file of [p.bin, join(dirname(p.bin), "figpal-mcp")]) if (ours(file)) rmSync(file);
	rmSync(p.app, { recursive: true, force: true });
	system.log("FigPal is removed. In Figma Desktop, remove the plugin too: Plugins → Development → Manage plugins in development.");
	system.log("Your shared folders stay in ~/.config/figpal/local.json, and your chats stay in Figma Desktop: a new install shows them again.");
}

/** The program that listens on FigPal's port, if any. lsof fails when none does. */
function listener(): string | undefined {
	try {
		const lines = execFileSync("lsof", ["-nP", `-iTCP:${UI_PORT}`, "-sTCP:LISTEN", "-Fc"], { encoding: "utf8" }).split("\n");
		return lines.find((line) => line.startsWith("c"))?.slice(1);
	} catch {
		return undefined;
	}
}

export const macSystem: System = {
	run(command, args) {
		try {
			execFileSync(command, args, { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	},
	copy: (text) => execFileSync("pbcopy", { input: text }),
	async probe() {
		// Nothing, or an answer that is not FigPal's JSON.
		const health = (await fetch(`${UI_ORIGIN}/health`, { signal: AbortSignal.timeout(2000) })
			.then((response) => response.json())
			.catch(() => undefined)) as { app?: unknown; version?: unknown } | undefined;
		if (health?.app === "figpal") return { kind: "figpal", version: String(health.version) };
		const program = listener();
		return program ? { kind: "other", program } : { kind: "free" };
	},
	log: (line) => console.log(line),
};
