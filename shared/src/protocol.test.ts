import { describe, expect, it } from "vitest";
import { isUiToPlugin } from "./protocol";

describe("isUiToPlugin", () => {
	// FigPal has one UI, the deployed one (user choice): no switch to the local UI.
	it("rejects a switch of the UI", () => {
		expect(isUiToPlugin({ kind: "switch-ui", ui: "remote" })).toBe(false);
		expect(isUiToPlugin({ kind: "switch-ui", ui: "local" })).toBe(false);
	});

	it("rejects request types from the Object prototype", () => {
		expect(isUiToPlugin({ kind: "request", id: "1", type: "__proto__", params: {} })).toBe(false);
		expect(isUiToPlugin({ kind: "request", id: "1", type: "execute", params: { code: "" } })).toBe(true);
	});
});
