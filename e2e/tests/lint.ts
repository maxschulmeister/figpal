// figma_lint: the model gets the findings, the step a pill for each rule, and a click selects the layers of the rule.

import { type Context, resultText, text, toolResults, toolUse } from "../harness.ts";

const FINDINGS = {
	rootNodeId: "0:1",
	rootNodeName: "Page 1",
	nodesScanned: 3,
	summary: { critical: 1, warning: 2, info: 0, total: 3 },
	categories: [
		{ rule: "apca-contrast", severity: "critical", wcagLevel: "wcag3-draft", count: 1, description: "APCA", nodes: [{ id: "1:2", name: "Label", lc: "Lc 73" }] },
		{ rule: "hardcoded-color", severity: "warning", wcagLevel: "design-system", count: 2, description: "Fill", nodes: [{ id: "1:3", name: "A" }, { id: "1:4", name: "B" }] },
	],
};

export default async function lint(t: Context) {
	const session = await t.open({
		requests: {
			lint: () => ({ result: FINDINGS }),
			// The layer 1:4 is on another page.
			select: ({ nodeIds }: { nodeIds: string[] }, session) => {
				const found = nodeIds.filter((id) => id !== "1:4");
				const selection = found.map((id) => ({ id, name: `Box ${id}`, type: "RECTANGLE" }));
				setTimeout(() => void session.post({ kind: "event", type: "selection", byAgent: false, page: { id: "0:1", name: "Page 1", type: "PAGE" }, selection, selectionCount: found.length }), 10);
				return { result: { count: found.length } };
			},
		},
		model: (request) => (toolResults(request).length === 0 ? toolUse("t1", "figma_lint", {}) : text("Done: 2 rules found layers.")),
	});
	await session.login();
	await session.ask("Check this page", "Done: 2 rules found layers.");
	t.check("the tool is offered", (session.model[0]!.tools ?? []).some((tool) => tool.name === "figma_lint"));
	const report = resultText(toolResults(session.model[1]!)[0]!);
	t.check("the model gets the findings", report.includes('"rule":"apca-contrast"'), report.slice(0, 120));
	const chat = await session.body();
	t.check("the step shows a pill for each rule", chat.includes("Check layers | Contrast (APCA) · 1 | Color without variable · 2"), chat.slice(0, 300));
	await session.frame.getByRole("button", { name: "Select 2 layers: Color without variable" }).click();
	await session.page.waitForTimeout(600);
	const selects = session.requests.filter((request) => request.type === "select");
	t.check("a click selects the layers of the rule", JSON.stringify(selects) === JSON.stringify([{ type: "select", params: { nodeIds: ["1:3", "1:4"] } }]), JSON.stringify(selects));
	// biome-ignore lint/performance/useDomNodeTextContent: the text as shown.
	const composer = await session.frame.getByRole("textbox", { name: "Ask FigPal" }).innerText();
	t.check("the selection goes into the message box as a chip", /Box 1:3/.test(composer), JSON.stringify(composer));
	const status = await session.frame.getByRole("status").allInnerTexts();
	t.check("it says when it selected only some layers", status.includes("Selected 1 of 2 layers. The others are on other pages or no longer exist."), JSON.stringify(status));
	await t.screenshot(session, "lint");
}
