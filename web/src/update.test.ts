import { describe, expect, it } from "vitest";
import { updateVersion } from "./update";

describe("update version", () => {
	it("gives the npm version when it is newer than the running FigPal", () => {
		expect(updateVersion("0.1.5", "0.1.6")).toBe("0.1.6");
		expect(updateVersion("0.1.9", "0.1.10")).toBe("0.1.10");
		expect(updateVersion("0.9.9", "1.0.0")).toBe("1.0.0");
	});

	it("gives nothing for the same or an older version, and for a build without a version", () => {
		expect(updateVersion("0.1.6", "0.1.6")).toBeUndefined();
		expect(updateVersion("0.2.0", "0.1.10")).toBeUndefined();
		expect(updateVersion("dev", "0.1.6")).toBeUndefined();
	});

	it("gives nothing for the version that the user closed, until a newer version comes out", () => {
		expect(updateVersion("0.1.5", "0.1.6", "0.1.6")).toBeUndefined();
		expect(updateVersion("0.1.5", "0.1.7", "0.1.6")).toBe("0.1.7");
	});
});
