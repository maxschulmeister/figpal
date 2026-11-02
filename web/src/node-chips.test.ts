import { defaultDirectiveFormatter } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { chipItem, chipLabels, chipSegments, chipsForModel, nodeIdsOfLink, quoteItem } from "./node-chips";

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

	// The agent links the layers that it names: [Card](#node=1:2). IDs in Figma links have dashes.
	// Reply (user request): a quote of an answer is a chip in the composer and in the sent message; the model gets
	// Markdown quote lines.
	it("keep a quote of several lines, with brackets and quote marks, and give the model Markdown lines", () => {
		const quote = 'The radius is 8 px.\nUse "rounded" [sm] {here}.';
		const text = `Please: ${defaultDirectiveFormatter.serialize(quoteItem(quote)!)}make it 12 px`;
		expect(chipSegments(text)).toEqual([
			{ kind: "text", text: "Please: " },
			{ kind: "quote", label: 'The radius is 8 px. Use "rounded" [sm] {here}.', text: quote },
			{ kind: "text", text: "make it 12 px" },
		]);
		expect(chipsForModel(text)).toBe('Please: \n> The radius is 8 px.\n> Use "rounded" [sm] {here}.\n\nmake it 12 px');
		expect(chipLabels(text)).toBe('Please: “The radius is 8 px. Use "rounded" [sm] {here}.”make it 12 px');
		// The composer puts the quote on its own line: one empty line after it for the model.
		const own = `Please:\n${defaultDirectiveFormatter.serialize(quoteItem("Short.")!)}\nmake it 12 px`;
		expect(chipsForModel(own)).toBe("Please:\n> Short.\n\nmake it 12 px");
		// A directive holds at most 1,024 characters: a longer quote is no chip.
		expect(quoteItem("a".repeat(901))).toBeUndefined();
	});

	it("read the node IDs of a layer link in an answer", () => {
		expect(nodeIdsOfLink("#node=1:2")).toEqual(["1:2"]);
		expect(nodeIdsOfLink("#node=1-3,I1:5;3:4")).toEqual(["1:3", "I1:5;3:4"]);
		for (const href of ["https://figma.com", "#node=", "#node=card", "#node=1:2,", "#node=1:2 1:3", undefined])
			expect(nodeIdsOfLink(href)).toBeUndefined();
		// A model writes a few IDs: a long list in a link is not a layer link (code.js would look up each ID).
		expect(nodeIdsOfLink("#node=1:2,1-2,1:3")).toEqual(["1:2", "1:3"]);
		expect(nodeIdsOfLink(`#node=${Array.from({ length: 201 }, (_, i) => `1:${i}`).join(",")}`)).toBeUndefined();
	});
});
