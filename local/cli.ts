#!/usr/bin/env node
// The local helper of FigPal. FigPal's UI finds it on the ports 9300 to 9309.
//
//   node local/cli.ts         shares the folders of ~/.config/figpal/local.json with FigPal's agent. The user adds
//                             them in FigPal (Settings → Access). `pnpm local:install` starts it at login.
//   node local/cli.ts --mcp   an MCP server on stdin and stdout: an outside agent acts on the open Figma file through
//                             FigPal, for example `claude mcp add figpal -- node /path/to/figpal/local/cli.ts --mcp`.
//   --config <path>           another config file (tests)
//   --origin <url>            accept one more UI origin (development, tests)

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LOCAL_ORIGINS, LOCAL_PORTS } from "@figpal/shared/local";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mcpServer } from "./mcp.ts";
import { startHelper } from "./server.ts";

const { values } = parseArgs({
	options: {
		mcp: { type: "boolean", default: false },
		config: { type: "string", default: join(homedir(), ".config", "figpal", "local.json") },
		origin: { type: "string", multiple: true, default: [] },
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

/** A shell word: the user pastes the command in a terminal. */
const word = (text: string) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

const helper = await startHelper({
	origins: [...LOCAL_ORIGINS, ...values.origin],
	ports: LOCAL_PORTS,
	agent: values.mcp,
	command: [process.execPath, fileURLToPath(import.meta.url), "--mcp"].map(word).join(" "),
	...(!values.mcp && { folders: { config: values.config, home: homedir(), pick } }),
});
// stdout is for MCP: notes go to stderr.
console.error(`FigPal helper on port ${helper.port}.${values.mcp ? "" : ` Folders: ${values.config}.`}`);

const stop = () => void helper.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (values.mcp) {
	const transport = new StdioServerTransport();
	// The agent stops the helper when it closes stdin.
	transport.onclose = stop;
	await mcpServer(helper).connect(transport);
}
