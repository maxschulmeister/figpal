#!/usr/bin/env node
// The FigPal command (`pnpm local:install` adds it as `figpal`). FigPal's UI finds its bridge on the ports 9300 to 9309.
//
//   figpal                    the bridge: it shares the folders of ~/.config/figpal/local.json with FigPal's agent
//                             (the user adds them in Settings → Access), and passes the requests of outside agents to
//                             FigPal. The install starts it at login.
//   figpal mcp                an MCP server on stdin and stdout, for an outside agent: `<agent> mcp add figpal -- figpal
//                             mcp`. The agent acts on the open Figma file through FigPal. It uses the running bridge,
//                             or is the bridge itself when none runs, as figma-console-mcp (without the folders).
//   --config <path>           another config file (tests)
//   --origin <url>            accept only this UI origin, not FigPal's (tests): the user's FigPal must not use a
//                             test helper
//   --port <port>             use only this port, not 9300 to 9309 (tests): a test agent must not use the user's helper

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LOCAL_ORIGINS, LOCAL_PORTS } from "@figpal/shared/local";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { joinBridge, mcpServer } from "./mcp.ts";
import { startHelper } from "./server.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		config: { type: "string", default: join(homedir(), ".config", "figpal", "local.json") },
		origin: { type: "string", multiple: true, default: [] },
		port: { type: "string" },
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

if (positionals.length > 1 || (positionals[0] !== undefined && positionals[0] !== "mcp"))
	throw new Error(`Unknown command: figpal ${positionals.join(" ")}. Use: figpal, or figpal mcp.`);
const ports = values.port === undefined ? LOCAL_PORTS : [Number(values.port)];
if (!ports.every((port) => Number.isInteger(port) && port > 0)) throw new Error(`--port: "${values.port}" is not a port.`);

const origins = values.origin.length ? values.origin : LOCAL_ORIGINS;

if (positionals[0] === "mcp") {
	// This bridge keeps no folders: only the bridge of `figpal` keeps them.
	const helper = joinBridge(ports, (port) => startHelper({ origins, ports: [port] }));
	const transport = new StdioServerTransport();
	const exit = () => process.exit(0);
	transport.onclose = exit;
	await mcpServer(helper).connect(transport);
	// The agent stops the MCP server when it closes stdin. The transport does not see the end of stdin.
	process.stdin.once("end", exit);
} else {
	const helper = await startHelper({ origins, ports, folders: { config: values.config, home: homedir(), pick } });
	console.error(`FigPal helper on port ${helper.port}. Folders: ${values.config}.`);
	const stop = () => void helper.close().then(() => process.exit(0));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
