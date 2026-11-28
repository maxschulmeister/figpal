import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRuntime, platformKey } from "./setup.ts";

/** A server that answers `initialize` as Antigravity 1.5.2 does. */
const SERVER = `#!/usr/bin/env node
process.stdin.on("data", (data) => {
	for (const line of String(data).split("\\n").filter(Boolean)) {
		const { id } = JSON.parse(line);
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.5.2" } } }) + "\\n");
	}
});
`;
const ARCHIVE = "https://dl.google.com/agy-extensions/releases/agy-acp-server-1.5.2.zip";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "figpal-antigravity-setup-"));
});
afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
});

/** The ACP registry and Google's download server. `sha256` is what the registry says. */
function google(zip: Uint8Array, sha256 = createHash("sha256").update(zip).digest("hex")) {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			urls.push(url);
			if (url.endsWith("/antigravity-acp/agent.json"))
				return Response.json({ version: "1.5.2", distribution: { binary: { [platformKey()]: { archive: ARCHIVE, cmd: "./agy_acp_server.par", sha256 } } } });
			if (url === ARCHIVE) return new Response(zip, { headers: { "content-length": String(zip.byteLength) } });
			return new Response("Not found", { status: 404 });
		}),
	);
	return urls;
}

const archive = () => zipSync({ "agy_acp_server.par": new TextEncoder().encode(SERVER), localharness_external: new TextEncoder().encode("harness") });

describe("Antigravity setup", () => {
	it("installs the server of the ACP registry, after it checked the SHA-256 and that the server starts", async () => {
		const zip = archive();
		const urls = google(zip);
		const steps: string[] = [];
		const launch = await ensureRuntime(root, (step) => steps.push(step));
		// The release itself, not the link "current": an update does not change the files of a running server.
		const sha256 = createHash("sha256").update(zip).digest("hex");
		expect(launch).toEqual({ command: join(realpathSync(root), "runtime", sha256, "agy_acp_server.par"), args: [] });
		expect(readFileSync(launch.command, "utf8")).toBe(SERVER);
		expect(steps).toEqual(["Downloading Antigravity 1.5.2…", "Downloading Antigravity: 100%", "Unpacking Antigravity…", "Checking Antigravity…"]);
		// The next start uses the installed server, and asks the registry again only the next day.
		expect(await ensureRuntime(root)).toEqual(launch);
		expect(urls).toEqual(["https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json", ARCHIVE]);
	});

	it("refuses a download with another SHA-256", async () => {
		google(archive(), "0".repeat(64));
		await expect(ensureRuntime(root)).rejects.toThrow("The download of Antigravity has a wrong SHA-256");
		expect(existsSync(join(root, "runtime", "current"))).toBe(false);
	});

	it("refuses an archive with a file in a folder", async () => {
		google(zipSync({ "../agy_acp_server.par": new TextEncoder().encode(SERVER) }));
		await expect(ensureRuntime(root)).rejects.toThrow(/unexpected file|invalid relative path/);
		expect(existsSync(join(root, "runtime", "current"))).toBe(false);
	});
});
