#!/usr/bin/env node
// Sets up the local helper on macOS: it starts at login (a LaunchAgent), and Claude Code gets FigPal's MCP server.
//
//   pnpm local:install     (again after a move of the repo or a new Node version: the paths are fixed)
//   pnpm local:uninstall

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "dev.figpal.local";

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The LaunchAgent: macOS starts the helper at login, and again when it stops. */
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

/** Runs a command, and gives false when it fails: for example `claude` is not installed, or nothing was loaded. */
function run(command: string, args: string[]): boolean {
	try {
		execFileSync(command, args, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

if (import.meta.main) {
	const uninstall = process.argv.includes("--uninstall");
	const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
	const service = `gui/${userInfo().uid}`;
	const cli = fileURLToPath(new URL("cli.ts", import.meta.url));
	// Stop the helper of an earlier install.
	run("launchctl", ["bootout", `${service}/${LABEL}`]);
	run("claude", ["mcp", "remove", "--scope", "user", "figpal"]);
	if (uninstall) {
		rmSync(plist, { force: true });
		console.log("FigPal's local helper is removed. Your shared folders stay in ~/.config/figpal/local.json.");
	} else {
		mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
		writeFileSync(plist, launchAgent({ node: process.execPath, cli, log: join(homedir(), "Library", "Logs", "figpal-local.log") }));
		if (!run("launchctl", ["bootstrap", service, plist])) {
			console.error(`macOS did not start the helper. See: launchctl bootstrap ${service} ${plist}`);
			process.exit(1);
		}
		const mcp = [process.execPath, cli, "--mcp"];
		const claude = run("claude", ["mcp", "add", "--scope", "user", "figpal", "--", ...mcp]);
		console.log("FigPal's local helper starts at login. Add folders in FigPal: Settings → Access.");
		console.log(claude ? "Claude Code has FigPal's MCP server (figpal)." : `For an agent: ${mcp.join(" ")}`);
	}
}
