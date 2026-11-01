import { defaultDirectiveFormatter } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { chipItem, chipLabels, chipSegments, chipsForModel } from "./node-chips";

const home = { id: "0:1", name: "Home", type: "PAGE" };
const parts = { id: "0:2", name: "Parts", type: "PAGE" };
const card = { id: "1:2", name: "Card", type: "FRAME" };
const title = { id: "I1:5;3:4", name: "Title", type: "TEXT" };
const button = { id: "2:0", name: "Button", type: "COMPONENT_SET" };
/** The text of a chip, as the composer has it. */
const chip = (nodes: (typeof card)[], page = home) => defaultDirectiveFormatter.serialize(chipItem(nodes, page));

describe("node chips", () => {
	it("label one node with its name, nodes of one type with the count and the type, and others as nodes", () => {
		expect(chipItem([card], home).label).toBe("Card");
		expect(chipItem([card, { ...card, id: "1:7" }], home).label).toBe("2 Frames");
		expect(chipItem([title, { ...title, id: "1:8" }, { ...title, id: "1:9" }], home).label).toBe("3 Text layers");
		expect(chipItem([button, { ...button, id: "2:1" }], home).label).toBe("2 Component sets");
		expect(chipItem([card, title, button], home).label).toBe("3 Nodes");
	});

	// code.js sends at most 50 nodes, and the types of the others are not known. assistant-ui reads at most 1024
	// characters of chip data, so a chip keeps the nodes that fit.
	it("label a large selection with the count of all nodes, and tell the model how many more there are", () => {
		const frames = Array.from({ length: 50 }, (_, index) => ({ ...card, id: `1:${index}` }));
		const item = chipItem(frames, home, 300);
		expect(item.label).toBe("300 Nodes");
		const [segment] = chipSegments(defaultDirectiveFormatter.serialize(item));
		expect(segment).toMatchObject({ kind: "chip", count: 300 });
		const kept = (segment as { nodes: unknown[] }).nodes.length;
		expect(kept).toBeGreaterThan(5);
		expect(chipsForModel(defaultDirectiveFormatter.serialize(item))).toMatch(new RegExp(`, and ${300 - kept} more</nodes>$`));
	});

	// Figma names a text layer with its text.
	it("cut long layer names, so the chip stays a chip", () => {
		const long = { ...title, name: "x".repeat(2000) };
		const [segment] = chipSegments(chip([long]));
		expect(segment).toMatchObject({ kind: "chip", label: `${"x".repeat(39)}…`, count: 1 });
	});

	it("keep the label, the nodes and the page in the text, also with odd layer names", () => {
		const one = { id: "1:9", name: 'a]b}c"d\\e', type: "FRAME" };
		expect(chipSegments(chip([one]))).toEqual([{ kind: "chip", label: one.name, page: home, nodes: [one], count: 1 }]);
		const odd = { id: "1:9", name: 'a]b}c"d\\e', type: "FRAME" };
		expect(chipSegments(`Fix ${chip([odd, title])} now`)).toEqual([
			{ kind: "text", text: "Fix " },
			{ kind: "chip", label: "2 Nodes", page: home, nodes: [odd, title], count: 2 },
			{ kind: "text", text: " now" },
		]);
	});

	it("give the model each chip as a <nodes> tag at its place in the text", () => {
		const text = `Make ${chip([card, title])}look like ${chip([button], parts)}`;
		expect(chipsForModel(text)).toBe(
			'Make <nodes page="Home (0:1)">Card (FRAME, 1:2), Title (TEXT, I1:5;3:4)</nodes>look like <nodes page="Parts (0:2)">Button (COMPONENT_SET, 2:0)</nodes>',
		);
	});

	it("keep text that only looks like a directive", () => {
		const text = "Use :node[Card] and :tool[search] here";
		expect(chipsForModel(text)).toBe(text);
		expect(chipLabels(text)).toBe(text);
	});

	it("keep < and > of layer names out of the tags", () => {
		expect(chipsForModel(chip([{ id: "1:1", name: "<b>Bold</nodes>", type: "TEXT" }]))).toBe(
			'<nodes page="Home (0:1)">bBold/nodes (TEXT, 1:1)</nodes>',
		);
	});

	it("give the labels for a thread title", () => {
		// The composer keeps one space next to each chip.
		expect(chipLabels(`${chip([card])} make it red`)).toBe("Card make it red");
	});
});
