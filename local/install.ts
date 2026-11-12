// Sets up FigPal on macOS and Linux: `npx figpal@latest install` (also for updates) and `npx figpal uninstall`.
//
// The install copies the command, the UI and the plugin to a fixed folder: npx keeps its files in a cache, and Figma and
// the login service need paths that stay. It starts the command at login (a LaunchAgent on macOS, a systemd user service
// on Linux), adds the command figpal next to node (agents run `figpal mcp`), and gives Claude Code FigPal's MCP server.

import { execFileSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { INSTALL_COMMAND, UI_PORT } from "@figpal/shared";

const LABEL = "dev.figpal.local";
const UNIT = "figpal.service";
/** The first line of figpal after #!: the uninstall removes only this file. */
const MARK = "# The FigPal command (figpal install).";
/** Older installs (pnpm local:install) had this mark, and also the command figpal-mcp. */
const OLD_MARK = "# FigPal's MCP helper (pnpm local:install).";
/** The command: .mjs, so that Node runs it as an ES module without a package.json next to it (Node 22.0 to 22.6). */
const CLI = "cli.mjs";
/** The UI files of a build stay this long: an open FigPal window loads parts of its build later. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** What answers on FigPal's port: nothing, FigPal (its version), or another program. */
export type Probe = { kind: "free" } | { kind: "figpal"; version: string } | { kind: "other"; program: string };

/** The calls to the system, so that a test can run the install in a folder. */
export type System = {
	/** Runs a command. False when it fails: for example, `claude` is not installed. */
	run(command: string, args: string[]): boolean;
	/** Puts the text on the clipboard. False when no clipboard command works. */
	copy(text: string): boolean;
	probe(): Promise<Probe>;
	log(line: string): void;
};

export type Platform = "darwin" | "linux";

/** The home folder, the node that runs FigPal, the user ID (for launchctl), the version of this package, and the OS. */
export type Where = { home: string; node: string; uid: number; version: string; platform: Platform };

export const appFolder = (home: string, platform: Platform) =>
	platform === "linux" ? join(home, ".local", "share", "figpal") : join(home, "Library", "Application Support", "FigPal");

/** The commands as [command, ...args]. */
type Run = [string, ...string[]];

function paths({ home, node, uid, platform }: Where) {
	const app = appFolder(home, platform);
	// A node of the system (/usr/bin/node) is in a folder that the user cannot write: then ~/.local/bin, as pipx does.
	const bin = join(writable(dirname(node)) ? dirname(node) : join(home, ".local", "bin"), "figpal");
	const common = { app, cli: join(app, CLI), manifest: join(app, "plugin", "manifest.json"), bin };
	if (platform === "linux") {
		const systemctl = (...args: string[]): Run => ["systemctl", "--user", ...args];
		return {
			...common,
			service: join(home, ".config", "systemd", "user", UNIT),
			log: join(home, ".local", "state", "figpal", "figpal.log"),
			unit: systemdUnit,
			stop: systemctl("disable", "--now", UNIT),
			start: [systemctl("daemon-reload"), systemctl("enable", "--now", UNIT)],
			/** The key that opens a path field in the file dialog (GTK and KDE). */
			goTo: "Ctrl+L",
		};
	}
	const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
	return {
		...common,
		service: plist,
		log: join(home, "Library", "Logs", "figpal.log"),
		unit: launchAgent,
		stop: ["launchctl", "bootout", `gui/${uid}/${LABEL}`] as Run,
		start: [["launchctl", "bootstrap", `gui/${uid}`, plist]] as Run[],
		goTo: "Cmd+Shift+G",
	};
}

const run = (system: System, [command, ...args]: Run) => system.run(command, args);

function writable(folder: string): boolean {
	try {
		accessSync(folder, constants.W_OK);
		return true;
	} catch {
		return false;
	}
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

/** systemd reads % as a specifier everywhere, and \ and " as escapes inside quotes. */
const percent = (text: string) => text.replaceAll("%", "%%");
const quoted = (text: string) => `"${percent(text).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** The systemd user service: Linux starts the command at login, and again when it stops. */
export function systemdUnit(paths: { node: string; cli: string; log: string }): string {
	return `[Unit]
Description=FigPal

[Service]
ExecStart=${quoted(paths.node)} ${quoted(paths.cli)}
Restart=always
RestartSec=1
StandardError=append:${percent(paths.log)}

[Install]
WantedBy=default.target
`;
}

const shell = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The figpal command: a shell script that runs the installed cli.mjs. */
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
	cpSync(join(from, CLI), join(app, CLI));
	cpSync(join(from, "plugin"), join(app, "plugin"), { recursive: true });
	// A copy has the time of the install, so the age of a file is the age of its build here.
	cpSync(join(from, "ui"), join(app, "ui"), { recursive: true });
	const assets = join(app, "ui", "assets");
	for (const name of readdirSync(assets)) if (Date.now() - statSync(join(assets, name)).mtimeMs > KEEP_MS) rmSync(join(assets, name));
}

/** Waits until this version of FigPal answers: right after the start of the service, the old one can still answer. */
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
	// The installed command would copy its own files onto themselves, after it stopped FigPal.
	if (resolve(from) === resolve(p.app)) throw new Error(`This is the installed FigPal. To update it, run ${INSTALL_COMMAND}`);
	if (!existsSync(join(from, "ui", "index.html")) || !existsSync(join(from, "plugin", "manifest.json")))
		throw new Error(`${from} has no build of FigPal. In the FigPal repo, run pnpm local:install.`);
	const before = await system.probe();
	if (before.kind === "other")
		throw new Error(`The port ${UI_PORT} is in use by ${before.program}. FigPal needs this port. Stop that program, then run ${INSTALL_COMMAND} again.`);
	const first = !existsSync(p.manifest);
	// Stops FigPal of an earlier install.
	run(system, p.stop);
	copyFiles(from, p.app);
	mkdirSync(dirname(p.service), { recursive: true });
	// systemd does not make the folder of the log.
	mkdirSync(dirname(p.log), { recursive: true });
	writeFileSync(p.service, p.unit({ node: where.node, cli: p.cli, log: p.log }));
	// Right after the stop of the old FigPal, macOS can refuse the start (user test): try again for 5 seconds.
	let running = false;
	for (let attempt = 0; attempt < 10 && !running; attempt++) {
		if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
		running = p.start.every((command) => run(system, command));
	}
	if (!running) throw new Error(`The system did not start FigPal. See: ${p.start.map((command) => command.join(" ")).join(" && ")}`);
	// A write to a link would change the file that it links to, for example the figpal of `npm install -g figpal`.
	rmSync(p.bin, { force: true });
	if (ours(join(dirname(p.bin), "figpal-mcp"))) rmSync(join(dirname(p.bin), "figpal-mcp"));
	mkdirSync(dirname(p.bin), { recursive: true });
	writeFileSync(p.bin, command({ node: where.node, cli: p.cli }), { mode: 0o755 });
	system.run("claude", ["mcp", "remove", "--scope", "user", "figpal"]);
	// The full path: Claude Code can start it also without this node on its PATH.
	const claude = system.run("claude", ["mcp", "add", "--scope", "user", "figpal", "--", p.bin, "mcp"]);
	if (!(await started(system, where.version))) throw new Error(`FigPal did not start. See the log: ${p.log}`);

	system.log(`FigPal ${where.version} runs, and starts at login.`);
	// ~/.local/bin can be missing from the PATH until the next login.
	const figpal = dirname(p.bin) === dirname(where.node) ? "figpal" : p.bin;
	system.log(`${claude ? "Claude Code has FigPal's MCP server. Other agents" : "For an agent"}: <agent> mcp add figpal -- ${figpal} mcp`);
	if (first) {
		const copied = system.copy(p.manifest);
		system.log("Now import the plugin in Figma Desktop, once: Plugins → Development → Import plugin from manifest…, then choose");
		system.log(`  ${p.manifest}`);
		if (copied) system.log(`The path is on the clipboard: in the file dialog, press ${p.goTo} and paste it.`);
	} else system.log("Run FigPal again in Figma to use the new version.");
}

export function uninstall(where: Where, system: System): void {
	const p = paths(where);
	run(system, p.stop);
	rmSync(p.service, { force: true });
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

/** The clipboard commands: macOS, then Wayland and X11. */
const CLIPBOARD: Run[] = process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"]];

export const nativeSystem: System = {
	run(command, args) {
		try {
			execFileSync(command, args, { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	},
	copy: (text) =>
		CLIPBOARD.some(([command, ...args]) => {
			try {
				// wl-copy and xclip stay in the background to keep the text: they must not keep the output open.
				execFileSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
				return true;
			} catch {
				return false;
			}
		}),
	async probe() {
		// Nothing, or an answer that is not FigPal's JSON.
		// The address where the command listens: Node can try ::1 first for "localhost".
		const health = (await fetch(`http://127.0.0.1:${UI_PORT}/health`, { signal: AbortSignal.timeout(2000) })
			.then((response) => response.json())
			.catch(() => undefined)) as { app?: unknown; version?: unknown } | undefined;
		if (health?.app === "figpal") return { kind: "figpal", version: String(health.version) };
		const program = listener();
		return program ? { kind: "other", program } : { kind: "free" };
	},
	log: (line) => console.log(line),
};
