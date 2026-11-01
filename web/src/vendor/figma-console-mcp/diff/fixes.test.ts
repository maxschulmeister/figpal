// FigPal's tests of its fixes to the copied diff code (see README.md).
import { describe, expect, it } from "vitest";
import { formatChangelogMarkdown } from "./changelog-formatter";
import { diffNode } from "./diff-engine";

const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });
const set = (children: object[], boundVariables: object = {}) => ({ id: "1:2", name: "Button", type: "COMPONENT_SET", boundVariables, children });

describe("diff fixes", () => {
	it("compares each binding of a list and of a nested object", () => {
		const before = set([], { fills: [alias("V:1"), alias("V:2")], size: { x: alias("V:3") } });
		const after = set([], {
			fills: [alias("V:1"), alias("V:9")],
			size: { x: alias("V:4"), y: alias("V:5") },
			componentProperties: { "Label#1:2": alias("V:6") },
		});
		const changes = diffNode(before, after, "detailed").binding_changes.map((change) => [change.property, change.change_kind]);
		expect(changes).toEqual([
			["fills[1]", "rebound"],
			["size.x", "rebound"],
			["size.y", "added"],
			["componentProperties.Label#1:2", "added"],
		]);
	});

	it("shows a renamed child, such as a variant", () => {
		const before = set([{ id: "1:3", name: "State=Hover", type: "COMPONENT" }]);
		const after = set([{ id: "1:3", name: "State=Hovered", type: "COMPONENT" }]);
		const diff = diffNode(before, after);
		expect(diff.children_renamed).toEqual([{ id: "1:3", from: "State=Hover", to: "State=Hovered" }]);
		expect(diff.change_count).toBe(1);
		const markdown = formatChangelogMarkdown(
			{ file_key: "K", from_version_id: "1", to_version_id: "current", page_structure: { pages_added: [], pages_removed: [], pages_renamed: [], summary: { added: 0, removed: 0, renamed: 0 } }, scoped_nodes: [diff] },
			"standard",
		);
		expect(markdown).toContain("- Children renamed (1): `State=Hover` → `State=Hovered`");
	});
});
