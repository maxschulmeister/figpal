// The local helper (local/cli.ts), started as macOS starts it at login, and the MCP command of an outside agent: FigPal
// connects without a setting, shows and changes the shared folders, its agent reads a file in them, and the outside
// agent runs code in the file through FigPal once the user enables MCP.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_ORIGINS } from "@figpal/shared/local";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Context, resultText, text, toolResults, toolUse } from "../harness.ts";

const CLI = fileURLToPath(new URL("../../local/cli.ts", import.meta.url));

export default async function local(t: Context) {
	// The user's own helper accepts FigPal's real origins: against them, this check could change the user's folders.
	if (LOCAL_ORIGINS.includes(new URL(t.ui).origin)) {
		t.check("skipped: it runs only against a UI of its own (pnpm e2e local), not against a real FigPal origin", true);
		return;
	}
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
	const service = spawn("node", [CLI, "--config", join(root, "local.json"), "--origin", session.ui], { stdio: ["ignore", "ignore", "pipe"] });
	const agent = new Client({ name: "e2e", version: "1" });
	try {
		// The agent's MCP command uses this bridge, not the user's. If the bridge stops, the agent's own bridge must
		// not accept the user's FigPal either: --origin.
		const port = await new Promise<string>((resolve, reject) => {
			let log = "";
			service.once("exit", () => reject(new Error(`The helper stopped: ${log}`)));
			service.stderr.on("data", (data) => {
				log += String(data);
				const found = /port (\d+)/.exec(log);
				if (found) resolve(found[1]!);
			});
		});
		await agent.connect(new StdioClientTransport({ command: "node", args: [CLI, "mcp", "--port", port, "--origin", session.ui], stderr: "ignore" }));
		await session.login();
		const { frame } = session;
		// The user comes back to FigPal after starting the helpers: FigPal looks for them when its window gets the focus.
		await frame.locator("body").evaluate(() => dispatchEvent(new Event("focus")));
		// FigPal is connected to the bridge when the folder shows in Access: then its agent has the local tools.
		await frame.getByLabel("Settings").click();
		await frame.getByRole("tab", { name: "Access" }).click();
		await frame.getByRole("button", { name: "Remove notes" }).waitFor();
		await frame.getByRole("button", { name: "Back to the chat" }).click();
		await session.ask("Read my notes", "Done: I read the notes.");
		const read = resultText(toolResults(session.model.at(-1)!)[0]!);
		t.check("FigPal connects without a setting, and its agent reads a file of a shared folder", read === "Hello from disk", read);

		await frame.getByLabel("Settings").click();
		await frame.getByRole("tab", { name: "Access" }).click();
		await frame.getByRole("button", { name: "Remove notes" }).waitFor();
		await frame.getByRole("switch", { name: "Share Home", exact: true }).click();
		await frame.getByRole("button", { name: `Remove ${basename(process.env.HOME!)}` }).waitFor();
		await t.screenshot(session, "local-access");
		await frame.getByRole("button", { name: `Remove ${basename(process.env.HOME!)}` }).click();
		await frame.getByRole("button", { name: "Remove notes" }).click();
		await frame.getByRole("button", { name: "Remove notes" }).waitFor({ state: "detached" });
		const config = JSON.parse(readFileSync(join(root, "local.json"), "utf8"));
		t.check("the home folder and Remove change the config of the helper", JSON.stringify(config) === JSON.stringify({ folders: [], home: false }), JSON.stringify(config));

		const off = await agent.callTool({ name: "figma_execute", arguments: { code: "return 1" } });
		t.check("an outside agent is refused until the user enables MCP", off.isError === true && JSON.stringify(off.content).includes("MCP is off in FigPal"), JSON.stringify(off));
		const mcp = frame.locator("section", { has: frame.getByRole("switch", { name: "Enable", exact: true }) });
		// The switch is the state: a status next to it said "Connected" also when MCP was off.
		t.check("MCP has no status next to its switch", (await mcp.getByText(/connected/i).count()) === 0);
		await frame.getByRole("switch", { name: "Enable", exact: true }).click();
		const on = await agent.callTool({ name: "figma_execute", arguments: { code: "return 1" } });
		t.check("then its code runs in code.js", JSON.stringify(on.content) === JSON.stringify([{ type: "text", text: '"ran return 1"' }]), JSON.stringify(on));
		const setup = () => mcp.locator("code").textContent();
		const claude = await setup();
		await frame.getByRole("combobox", { name: "Agent" }).click();
		await frame.getByRole("option", { name: "Codex" }).click();
		const codex = await setup();
		await frame.getByRole("combobox", { name: "Agent" }).click();
		await frame.getByRole("option", { name: "Manual" }).click();
		const manual = JSON.parse((await setup()) ?? "");
		t.check(
			"the user picks the agent: its command, or the JSON",
			claude === "claude mcp add --scope user figpal -- figpal mcp" &&
				codex === "codex mcp add figpal -- figpal mcp" &&
				JSON.stringify(manual.mcpServers.figpal) === JSON.stringify({ command: "figpal", args: ["mcp"] }),
			JSON.stringify([claude, codex, manual]),
		);
		await t.screenshot(session, "local-mcp");
		await frame.getByRole("button", { name: "Copy" }).click();
		await frame.getByRole("button", { name: "Copied" }).waitFor();
		t.check("the setup has a Copy button", true);
	} finally {
		await agent.close();
		service.kill();
	}
}
