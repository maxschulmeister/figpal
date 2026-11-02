import { describe, expect, it } from "vitest";
import { isHelperToUi, isUiToHelper } from "./local";

describe("local helper messages", () => {
	it("accepts the messages of the helper, and only requests that outside agents may send", () => {
		expect(isHelperToUi({ kind: "hello", folders: ["project"], agent: true })).toBe(true);
		expect(isHelperToUi({ kind: "request", id: "1", type: "execute", params: { code: "return 1" } })).toBe(true);
		expect(isHelperToUi({ kind: "response", id: "1", ok: true, result: [] })).toBe(true);
		expect(isHelperToUi({ kind: "request", id: "1", type: "storage-set", params: {} })).toBe(false);
		expect(isHelperToUi({ kind: "hello", folders: [1], agent: true })).toBe(false);
	});

	it("accepts the messages of the UI", () => {
		expect(isUiToHelper({ kind: "files", id: "1", request: { op: "write", path: "p/a.txt", content: "x" } })).toBe(true);
		expect(isUiToHelper({ kind: "files", id: "1", request: { op: "write", path: "p/a.txt" } })).toBe(false);
		expect(isUiToHelper({ kind: "files", id: "1", request: { op: "delete", path: "p" } })).toBe(false);
		expect(isUiToHelper({ kind: "response", id: "1", ok: true, result: 1, attachments: [{ name: "a.png", mime: "image/png", data: "AA==" }] })).toBe(true);
		expect(isUiToHelper({ kind: "response", id: "1", ok: false, error: "No." })).toBe(true);
		expect(isUiToHelper({ kind: "response", id: "1", ok: true, result: 1 })).toBe(false);
	});
});
