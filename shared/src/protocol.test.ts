import { describe, expect, it } from "vitest";
import { isUiToPlugin } from "./protocol";

describe("isUiToPlugin", () => {
	it("accepts a switch to the remote or the local UI", () => {
		expect(isUiToPlugin({ kind: "switch-ui", ui: "remote" })).toBe(true);
		expect(isUiToPlugin({ kind: "switch-ui", ui: "local" })).toBe(true);
	});

	it("rejects a switch to an unknown UI", () => {
		expect(isUiToPlugin({ kind: "switch-ui", ui: "https://evil.example" })).toBe(false);
	});

	it("rejects request types from the Object prototype", () => {
		expect(isUiToPlugin({ kind: "request", id: "1", type: "__proto__", params: {} })).toBe(false);
		expect(isUiToPlugin({ kind: "request", id: "1", type: "execute", params: { code: "" } })).toBe(true);
	});
});
