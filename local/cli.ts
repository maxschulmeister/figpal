#!/usr/bin/env node
// The FigPal command: the npm package "figpal". FigPal's UI finds its bridge on the ports 9300 to 9309.
//
//   figpal install            copies FigPal to ~/Library/Application Support/FigPal, starts it at login, and adds the
//                             command figpal next to node (npx figpal@latest install, also for updates; install.ts)
//   figpal uninstall          removes all of it, but not the shared folders
//
//   figpal                    serves FigPal's UI and its routes on http://localhost:9310, which the plugin window
//                             loads, from the folder ui/ next to this file (the package has it; the repo does not).
//                             And the bridge: it shares the folders of ~/.config/figpal/local.json with FigPal's agent
//                             (the user adds them in Settings → Access), and passes the requests of outside agents to
//                             FigPal. The install starts it at login.
//   figpal mcp                an MCP server on stdin and stdout, for an outside agent: `<agent> mcp add figpal -- figpal
//                             mcp`. The agent acts on the open Figma file through FigPal. It uses the running bridge,
//                             or is the bridge itself when none runs, as figma-console-mcp (without the folders).
//   --config <path>           another config file (tests)
//   --origin <url>            accept only this UI origin, not FigPal's (tests): the user's FigPal must not use a
//                             test helper
//   --port <port>             use only this port, not 9300 to 9309 (tests): a test agent must not use the user's helper
//   --ui <folder>             serve the UI of this folder (the repo: web/dist)
//   --ui-port <port>          serve the UI on this port, not 9310 (tests)

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { UI_PORT } from "@figpal/shared";
import { LOCAL_ORIGINS, LOCAL_PORTS } from "@figpal/shared/local";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { install, macSystem, stableNode, uninstall } from "./install.ts";
import { joinBridge, mcpServer } from "./mcp.ts";
import { startHelper } from "./server.ts";
import { startUiServer } from "./ui-server.ts";

/** The build of the package sets it (local/build.ts). */
declare const FIGPAL_VERSION: string | undefined;
const VERSION = typeof FIGPAL_VERSION === "string" ? FIGPAL_VERSION : "dev";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		config: { type: "string", default: join(homedir(), ".config", "figpal", "local.json") },
		origin: { type: "string", multiple: true, default: [] },
		port: { type: "string" },
		ui: { type: "string", default: fileURLToPath(new URL("ui", import.meta.url)) },
		"ui-port": { type: "string", default: String(UI_PORT) },
	},
});

/** The macOS folder picker. Cancel gives no folders. */
const PICKER = `activate
set picked to choose folder with prompt "Share folders with FigPal" with multiple selections allowed
set paths to ""
repeat with item_ in picked
	set paths to paths & POSIX path of item_ & linefeed
end repeat
return paths`;
const pick = () =>
	new Promise<string[]>((resolve, reject) =>
		execFile("osascript", ["-e", PICKER], (error, stdout) => {
			if (error) return error.message.includes("(-128)") ? resolve([]) : reject(error);
			resolve(stdout.split("\n").filter(Boolean));
		}),
	);

const COMMANDS = ["mcp", "install", "uninstall"];
if (positionals.length > 1 || (positionals[0] !== undefined && !COMMANDS.includes(positionals[0])))
	throw new Error(`Unknown command: figpal ${positionals.join(" ")}. Use: figpal, figpal install, figpal uninstall, or figpal mcp.`);
const ports = values.port === undefined ? LOCAL_PORTS : [Number(values.port)];
if (!ports.every((port) => Number.isInteger(port) && port > 0)) throw new Error(`--port: "${values.port}" is not a port.`);
const uiPort = Number(values["ui-port"]);
if (!Number.isInteger(uiPort) || uiPort <= 0) throw new Error(`--ui-port: "${values["ui-port"]}" is not a port.`);

const origins = values.origin.length ? values.origin : LOCAL_ORIGINS;

if (positionals[0] === "install" || positionals[0] === "uninstall") {
	if (process.platform !== "darwin") throw new Error("FigPal runs on macOS only.");
	const where = { home: homedir(), node: stableNode(process.execPath), uid: userInfo().uid, version: VERSION };
	try {
		if (positionals[0] === "install") await install(fileURLToPath(new URL(".", import.meta.url)), where, macSystem);
		else uninstall(where, macSystem);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
} else if (positionals[0] === "mcp") {
	// This bridge keeps no folders: only the bridge of `figpal` keeps them.
	const helper = joinBridge(ports, (port) => startHelper({ origins, ports: [port] }));
	const transport = new StdioServerTransport();
	const exit = () => process.exit(0);
	transport.onclose = exit;
	await mcpServer(helper).connect(transport);
	// The agent stops the MCP server when it closes stdin. The transport does not see the end of stdin.
	process.stdin.once("end", exit);
} else {
	// The origin of the UI has the port in it: Figma Desktop keeps the chats for that origin, so no other port.
	const ui = existsSync(values.ui)
		? await startUiServer({ root: values.ui, port: uiPort, origin: `http://localhost:${uiPort}`, version: VERSION }).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "EADDRINUSE") throw error;
					console.error(`The port ${uiPort} is in use: FigPal runs already, or another program uses the port. FigPal needs it.`);
					process.exit(1);
				},
			)
		: undefined;
	if (ui) console.error(`FigPal's UI: http://localhost:${ui.port} (${values.ui}).`);
	const helper = await startHelper({ origins, ports, folders: { config: values.config, home: homedir(), pick } });
	console.error(`FigPal helper on port ${helper.port}. Folders: ${values.config}.`);
	const stop = () => void Promise.all([helper.close(), ui?.close()]).then(() => process.exit(0));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
