// FigPal's tests of its fixes to the copied audit code (see README.md).
import { describe, expect, it } from "vitest";
import { scoreAccessibility } from "./accessibility";

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
});
