// The local helpers (local/cli.ts), started as macOS starts them at login and as an outside agent starts them: FigPal
// connects without a setting, shows and changes the shared folders, its agent reads a file in them, and the outside
// agent runs code in the file through FigPal once the user enables MCP.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Context, resultText, text, toolResults, toolUse } from "../harness.ts";

const CLI = fileURLToPath(new URL("../../local/cli.ts", import.meta.url));

export default async function local(t: Context) {
	const root = mkdtempSync(join(tmpdir(), "figpal-shared-"));
	const folder = join(root, "notes");
	mkdirSync(folder);
	writeFileSync(join(root, "local.json"), JSON.stringify({ folders: [folder], home: false }));
	writeFileSync(join(folder, "notes.txt"), "Hello from disk");
	const session = await t.open({
		requests: { execute: ({ code }: { code: string }) => ({ result: { value: JSON.stringify(`ran ${code}`) } }) },
		model: (request) => (toolResults(request).length === 0 ? toolUse("t1", "local_read", { path: "notes/notes.txt" }) : text("Done: I read the notes.")),
	});
	// The helper that starts at login, with the config of this test.
	const service = spawn("node", [CLI, "--config", join(root, "local.json"), "--origin", session.ui], { stdio: "ignore" });
	const agent = new Client({ name: "e2e", version: "1" });
	await agent.connect(new StdioClientTransport({ command: "node", args: [CLI, "--mcp", "--origin", session.ui], stderr: "ignore" }));
	try {
		await session.login();
		const { frame, page } = session;
		await session.ask("Read my notes", "Done: I read the notes.");
		const read = resultText(toolResults(session.model.at(-1)!)[0]!);
		t.check("FigPal connects without a setting, and its agent reads a file of a shared folder", read === "Hello from disk", read);

		await frame.getByLabel("Settings").click();
		await frame.getByRole("tab", { name: "Access" }).click();
		await frame.getByRole("button", { name: "Remove notes" }).waitFor();
		t.check("the Access tab shows the shared folders", true);
		await frame.getByRole("switch", { name: "Share the home folder", exact: true }).click();
		await frame.getByRole("button", { name: `Remove ${basename(process.env.HOME!)}` }).waitFor();
		await t.screenshot(session, "local-access");
		await frame.getByRole("button", { name: `Remove ${basename(process.env.HOME!)}` }).click();
		await frame.getByRole("button", { name: "Remove notes" }).click();
		await frame.getByText("No shared folders.", { exact: false }).waitFor();
		const config = JSON.parse(readFileSync(join(root, "local.json"), "utf8"));
		t.check("the home folder and Remove change the config of the helper", JSON.stringify(config) === JSON.stringify({ folders: [], home: false }), JSON.stringify(config));

		const off = await agent.callTool({ name: "figma_execute", arguments: { code: "return 1" } });
		t.check("an outside agent is refused until the user enables MCP", off.isError === true && JSON.stringify(off.content).includes("MCP is off in FigPal"), JSON.stringify(off));
		await frame.getByRole("switch", { name: "Enable MCP", exact: true }).click();
		const on = await agent.callTool({ name: "figma_execute", arguments: { code: "return 1" } });
		t.check("then its code runs in code.js", JSON.stringify(on.content) === JSON.stringify([{ type: "text", text: '"ran return 1"' }]), JSON.stringify(on));
		const command = await frame.locator("code", { hasText: "claude mcp add figpal -- " }).textContent();
		t.check("the MCP command has the paths of this copy of FigPal", command?.includes(`${CLI} --mcp`) === true, command ?? "");
		await frame.getByRole("button", { name: "Copy" }).click();
		await frame.getByRole("button", { name: "Copied" }).waitFor();
		await page.waitForTimeout(100);
	} finally {
		await agent.close();
		service.kill();
	}
}
