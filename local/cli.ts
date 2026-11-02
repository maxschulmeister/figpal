#!/usr/bin/env node
// figpal-local: shares folders of this machine with FigPal's agent, and lets an outside agent act on the open Figma
// file through FigPal (MCP). FigPal's UI finds the helper on the ports 9300 to 9309.
//
//   node local/cli.ts --folder ~/project [--folder ~/exports]   share folders with FigPal's agent
//   node local/cli.ts --mcp [--folder ~/project]                 an MCP server on stdin and stdout, for example:
//     claude mcp add figpal -- node /path/to/figpal/local/cli.ts --mcp
//   --origin http://localhost:5174                               accept one more UI origin (development, tests)

import { parseArgs } from "node:util";
import { LOCAL_ORIGINS, LOCAL_PORTS } from "@figpal/shared/local";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { folders } from "./files.ts";
import { mcpServer } from "./mcp.ts";
import { startHelper } from "./server.ts";

const { values } = parseArgs({
	options: {
		folder: { type: "string", multiple: true, default: [] },
		mcp: { type: "boolean", default: false },
		origin: { type: "string", multiple: true, default: [] },
	},
});

if (!values.mcp && values.folder.length === 0) {
	console.error("Give --folder <path> to share a folder with FigPal, or --mcp for an outside agent.");
	process.exit(1);
}

const helper = await startHelper({
	folders: folders(values.folder),
	origins: [...LOCAL_ORIGINS, ...values.origin],
	ports: LOCAL_PORTS,
	agent: values.mcp,
});
// stdout is for MCP: notes go to stderr.
console.error(`FigPal helper on port ${helper.port}.${values.folder.length ? ` Shared: ${values.folder.join(", ")}.` : ""}`);

const stop = () => void helper.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (values.mcp) {
	const transport = new StdioServerTransport();
	// The agent stops the helper when it closes stdin.
	transport.onclose = stop;
	await mcpServer(helper).connect(transport);
}
