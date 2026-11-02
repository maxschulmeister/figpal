import { describe, expect, it } from "vitest";
import { launchAgent, mcpCommand } from "./install.ts";

describe("install", () => {
	it("starts the helper at login, and again when it stops", () => {
		const plist = launchAgent({ node: "/opt/node", cli: "/Users/a & b/figpal/local/cli.ts", log: "/Users/a/Library/Logs/figpal-local.log" });
		expect(plist).toContain("<string>dev.figpal.local</string>");
		// The paths are XML: "&" must be escaped.
		expect(plist).toContain("<array><string>/opt/node</string><string>/Users/a &amp; b/figpal/local/cli.ts</string></array>");
		expect(plist).toContain("<key>RunAtLoad</key><true/>");
		expect(plist).toContain("<key>KeepAlive</key><true/>");
		expect(plist).toContain("<key>StandardErrorPath</key><string>/Users/a/Library/Logs/figpal-local.log</string>");
	});

	// figpal-mcp: a short command for the agent config, next to node (on the PATH where this node is).
	it("makes the figpal-mcp command, which starts an MCP helper", () => {
		expect(mcpCommand({ node: "/opt/node", cli: "/Users/a b/figpal/local/cli.ts" })).toBe(
			`#!/bin/sh\n# FigPal's MCP helper (pnpm local:install).\nexec '/opt/node' '/Users/a b/figpal/local/cli.ts' --mcp "$@"\n`,
		);
	});
});
