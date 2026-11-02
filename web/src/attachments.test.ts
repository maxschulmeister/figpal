import { describe, expect, it } from "vitest";
import { attachable, isLongText } from "./attachments";

const file = (name: string, type: string, size = 10) => new File(["x".repeat(size)], name, { type });

describe("attachments", () => {
	it("takes images for the model and text files, and says why not for other files", () => {
		expect(attachable(file("logo.png", "image/png"))).toBeUndefined();
		expect(attachable(file("notes.md", ""))).toBeUndefined();
		expect(attachable(file("data.json", "application/json"))).toBeUndefined();
		// SVG is text: models read it as code, not as an image.
		expect(attachable(file("icon.svg", "image/svg+xml"))).toBeUndefined();
		expect(attachable(file("brief.pdf", "application/pdf"))).toMatch(/cannot send "brief.pdf"/);
		expect(attachable(file("huge.txt", "text/plain", 600_000))).toMatch(/larger than 500 KB/);
	});

	// User: long pasted text becomes an attachment, not a wall of text in the message.
	it("finds long pasted text: 2,000 characters or 30 lines", () => {
		expect(isLongText("a".repeat(1999))).toBe(false);
		expect(isLongText("a".repeat(2000))).toBe(true);
		expect(isLongText("line\n".repeat(29))).toBe(true);
		expect(isLongText("line\n".repeat(28))).toBe(false);
	});
});
