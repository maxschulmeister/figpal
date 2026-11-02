import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type Folder, folders, runFile } from "./files.ts";

let root: string;
let shared: Folder[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "figpal-files-"));
	mkdirSync(join(root, "project", "src"), { recursive: true });
	writeFileSync(join(root, "project", "src", "app.tsx"), "export const app = 1;\n");
	writeFileSync(join(root, "secret.txt"), "secret");
	symlinkSync(join(root, "secret.txt"), join(root, "project", "link.txt"));
	shared = folders([join(root, "project")]);
});

describe("local files", () => {
	it("lists the folders, and the entries of a folder", async () => {
		expect(await runFile(shared, { op: "list", path: "" })).toEqual(["project/"]);
		expect(await runFile(shared, { op: "list", path: "project" })).toEqual(["link.txt", "src/"]);
	});

	it("reads and writes text files, and makes the folders of a new file", async () => {
		expect(await runFile(shared, { op: "read", path: "project/src/app.tsx" })).toBe("export const app = 1;\n");
		await runFile(shared, { op: "write", path: "project/tokens/colors.css", content: ":root {}" });
		expect(readFileSync(join(root, "project", "tokens", "colors.css"), "utf8")).toBe(":root {}");
	});

	// The agent can get paths from the file or the web: only the shared folders are open to it.
	it("refuses paths outside the shared folders", async () => {
		for (const path of ["project/../secret.txt", "/etc/hosts", "other/a.txt", "project/link.txt"])
			await expect(runFile(shared, { op: "read", path })).rejects.toThrow(/not in a shared folder|No shared folder/);
		await expect(runFile(shared, { op: "write", path: "project/../evil.txt", content: "x" })).rejects.toThrow(/not in a shared folder/);
	});

	// A link to a folder outside: the new file would land outside.
	it("refuses a write through a linked folder", async () => {
		mkdirSync(join(root, "outside"));
		symlinkSync(join(root, "outside"), join(root, "project", "out"));
		await expect(runFile(shared, { op: "write", path: "project/out/new.txt", content: "x" })).rejects.toThrow(/not in a shared folder/);
	});

	it("refuses files larger than 1 MB", async () => {
		writeFileSync(join(root, "project", "big.txt"), "x".repeat(1_000_001));
		await expect(runFile(shared, { op: "read", path: "project/big.txt" })).rejects.toThrow("larger than 1 MB");
	});

	it("needs folders with different names", () => {
		mkdirSync(join(root, "other", "project"), { recursive: true });
		expect(() => folders([join(root, "project"), join(root, "other", "project")])).toThrow('Two shared folders are named "project"');
	});
});
