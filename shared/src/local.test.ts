import { describe, expect, it } from "vitest";
import { isHelperToUi, isUiToHelper } from "./local";

describe("local helper messages", () => {
	it("accepts the messages of the helper, and only requests that outside agents may send", () => {
		const hello = { kind: "hello", folders: ["project"], agent: true, manage: true, home: false, command: "node cli.ts --mcp" };
		expect(isHelperToUi(hello)).toBe(true);
		expect(isHelperToUi({ ...hello, manage: "yes" })).toBe(false);
		expect(isHelperToUi({ ...hello, command: undefined })).toBe(false);
		expect(isHelperToUi({ kind: "request", id: "1", type: "execute", params: { code: "return 1" } })).toBe(true);
		expect(isHelperToUi({ kind: "response", id: "1", ok: true, result: [] })).toBe(true);
		expect(isHelperToUi({ kind: "request", id: "1", type: "storage-set", params: {} })).toBe(false);
		expect(isHelperToUi({ ...hello, folders: [1] })).toBe(false);
	});

	it("accepts the messages of the UI", () => {
		expect(isUiToHelper({ kind: "files", id: "1", request: { op: "write", path: "p/a.txt", content: "x" } })).toBe(true);
		expect(isUiToHelper({ kind: "files", id: "1", request: { op: "write", path: "p/a.txt" } })).toBe(false);
		expect(isUiToHelper({ kind: "files", id: "1", request: { op: "delete", path: "p" } })).toBe(false);
		expect(isUiToHelper({ kind: "response", id: "1", ok: true, result: 1, attachments: [{ name: "a.png", mime: "image/png", data: "AA==" }] })).toBe(true);
		expect(isUiToHelper({ kind: "response", id: "1", ok: false, error: "No." })).toBe(true);
		expect(isUiToHelper({ kind: "response", id: "1", ok: true, result: 1 })).toBe(false);
		// The folders of the helper: add (with the folder picker), remove, and the home folder.
		expect(isUiToHelper({ kind: "folders", id: "1", change: { op: "add" } })).toBe(true);
		expect(isUiToHelper({ kind: "folders", id: "1", change: { op: "remove", name: "project" } })).toBe(true);
		expect(isUiToHelper({ kind: "folders", id: "1", change: { op: "home", on: true } })).toBe(true);
		expect(isUiToHelper({ kind: "folders", id: "1", change: { op: "remove" } })).toBe(false);
		expect(isUiToHelper({ kind: "folders", id: "1", change: { op: "home", on: "yes" } })).toBe(false);
		// The file of the window: an outside agent can choose it.
		expect(isUiToHelper({ kind: "window", file: "Design system" })).toBe(true);
		expect(isUiToHelper({ kind: "window", file: 1 })).toBe(false);
	});
});
