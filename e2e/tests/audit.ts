// figma_audit_design_system: code.js gives the variables and the components, the model the report, the step the scores.

import { type Context, resultText, text, toolResults, toolUse } from "../harness.ts";

export default async function audit(t: Context) {
	const session = await t.open({
		requests: {
			variables: () => ({
				result: {
					collections: [{ id: "C:1", name: "Colors", modes: [{ modeId: "1:0", name: "Light" }], isExtension: false }],
					variables: [
						{
							id: "V:1",
							name: "blue/500",
							resolvedType: "COLOR",
							valuesByMode: { "1:0": { r: 0, g: 0, b: 1, a: 1 } },
							variableCollectionId: "C:1",
							scopes: [],
							codeSyntax: {},
							description: "",
						},
					],
				},
			}),
			components: () => ({
				result: {
					fileName: "E2E",
					componentSets: [{ id: "1:1", name: "Button", description: "" }],
					components: [{ id: "1:2", name: "Size=Small", description: "", componentSetId: "1:1" }],
					styles: [],
				},
			}),
		},
		model: (request) => (toolResults(request).length === 0 ? toolUse("t1", "figma_audit_design_system", {}) : text("Done: the audit is ready.")),
	});
	await session.login();
	await session.ask("Audit the design system", "Done: the audit is ready.");
	t.check("the tool is offered", (session.model[0]!.tools ?? []).some((tool) => tool.name === "figma_audit_design_system"));
	const types = session.requests.map((request) => request.type);
	t.check("code.js gives the variables and the components", types.includes("variables") && types.includes("components"), JSON.stringify(types));
	const report = resultText(toolResults(session.model[1]!)[0]!);
	t.check("the model gets the report", /^Design system: E2E\. Overall health: \d+\/100/.test(report), report.slice(0, 200));
	const chat = await session.body();
	t.check("the step shows the label and the scores", /Audit design system \| Overall \| \d+\/100 · (Good|Needs work|Poor) \| Naming \| \d+ \| Tokens \| \d+/.test(chat), chat.slice(0, 400));
	await t.screenshot(session, "audit");
}
