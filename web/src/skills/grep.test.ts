import { describe, expect, it } from "vitest";
import { grep } from "./grep";

const files = [
	{ path: "SKILL.md", contents: "# Use\nLoad fonts first." },
	{ path: "api.d.ts", contents: `interface FrameNode {\n${"x".repeat(500)}\ninterface TextNode {` },
];

describe("grep", () => {
	it("gives path:line: text for each matching line, with long lines cut", () => {
		expect(grep(files, "^interface \\w+Node")).toEqual({
			lines: ["api.d.ts:1: interface FrameNode {", "api.d.ts:3: interface TextNode {"],
			total: 2,
		});
		expect(grep(files, "^x+$").lines[0]).toBe(`api.d.ts:2: ${"x".repeat(300)}`);
	});

	it("gives at most 100 lines and the total", () => {
		const many = [{ path: "a.md", contents: Array.from({ length: 150 }, () => "match").join("\n") }];
		const result = grep(many, "match");
		expect(result.lines).toHaveLength(100);
		expect(result.total).toBe(150);
	});
});
