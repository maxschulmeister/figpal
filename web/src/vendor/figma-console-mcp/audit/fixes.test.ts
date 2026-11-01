// FigPal's tests of its fixes to the copied audit code (see README.md).
import { describe, expect, it } from "vitest";
import { scoreAccessibility } from "./accessibility";
import { scoreComponentMetadata } from "./component-metadata";

describe("audit fixes", () => {
	// Before, the check made every dark × light pair and then kept 50: 4,000 such colors used about 180 MB.
	it("checks the contrast of many colors without names for text or background quickly", () => {
		const collections = [{ id: "C:1", name: "Palette", modes: [{ modeId: "1:0", name: "Light" }] }];
		const variables = Array.from({ length: 6000 }, (_, i) => {
			const level = i % 2 ? 0.9 : 0.1;
			return { id: `V:${i}`, name: `palette/${i}`, resolvedType: "COLOR", variableCollectionId: "C:1", valuesByMode: { "1:0": { r: level, g: level, b: level, a: 1 } } };
		});
		const start = performance.now();
		const contrast = scoreAccessibility({ variables, collections, components: [], componentSets: [], styles: [] }).findings.find(
			(finding) => finding.id === "a11y-color-contrast",
		);
		expect(performance.now() - start).toBeLessThan(150);
		expect(contrast).toMatchObject({ score: 100, details: expect.stringContaining("50") });
	});

	// The same pairs with WCAG 2 (4.5:1) and with APCA (Lc 60, the WCAG 3 draft method). Gray 0.5 on white: 3.98:1, Lc 67.
	it("checks the contrast of the color pairs with WCAG 2 and with APCA", () => {
		const collections = [{ id: "C:1", name: "Palette", modes: [{ modeId: "1:0", name: "Light" }] }];
		const color = (id: string, level: number) => ({ id, name: `palette/${id}`, resolvedType: "COLOR", variableCollectionId: "C:1", valuesByMode: { "1:0": { r: level, g: level, b: level, a: 1 } } });
		const findings = scoreAccessibility({ variables: [color("gray", 0.5), color("white", 1)], collections, components: [], componentSets: [], styles: [] }).findings;
		expect(findings.find((finding) => finding.id === "a11y-color-contrast")).toMatchObject({
			label: "Color contrast (WCAG 2)",
			score: 0,
			// 3.98 rounded down: a failing value does not show as a higher one.
			examples: ["palette/gray / palette/white (3.9:1)"],
		});
		expect(findings.find((finding) => finding.id === "a11y-color-contrast-apca")).toMatchObject({
			label: "Color contrast (APCA)",
			score: 100,
			details: "1 of 1 color pairs reach APCA Lc 60, the minimum for content text; body text needs Lc 75 (WCAG 3 draft method).",
		});
	});

	// The chat selects them: all, not only the 5 examples.
	it("gives the location of each component of a finding", () => {
		const components = Array.from({ length: 7 }, (_, i) => ({ id: `2:${i}`, node_id: `2:${i}`, name: `Button${i}`, description: "", componentPropertyDefinitions: {} }));
		const presence = scoreComponentMetadata({ variables: [], collections: [], components, componentSets: [], styles: [] }).findings.find(
			(finding) => finding.id === "component-desc-presence",
		);
		expect(presence!.examples).toHaveLength(5);
		expect(presence!.locations!.map((location) => location.nodeId)).toEqual(components.map((component) => component.id));
	});
});
