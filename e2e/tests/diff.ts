// figma_diff_versions: REST calls with the file key and the token, and the change log for the model.

import { type Context, resultText, text, toolResults, toolUse } from "../harness.ts";
import { saveFigmaToken } from "./rest.ts";

const API = "https://api.figma.com/v1/files/KEY1";
const file = (pages: { id: string; name: string }[]) => ({
	name: "E2E",
	lastModified: "2026-10-01T00:00:00Z",
	version: "1",
	document: { id: "0:0", type: "DOCUMENT", children: pages.map((page) => ({ ...page, type: "CANVAS" })) },
});
const buttons = (states: string[]) => ({
	nodes: {
		"1:2": { document: { id: "1:2", name: "Button", type: "COMPONENT_SET", children: states.map((state, i) => ({ id: `1:${3 + i}`, name: `State=${state}`, type: "COMPONENT" })) } },
	},
});
const ANSWERS: Record<string, object> = {
	[`${API}?depth=1&version=111`]: file([{ id: "0:1", name: "Home" }]),
	[`${API}?depth=1`]: file([
		{ id: "0:1", name: "Home" },
		{ id: "0:2", name: "Icons" },
	]),
	[`${API}/nodes?ids=1%3A2&depth=2&version=111`]: buttons(["Default"]),
	[`${API}/nodes?ids=1%3A2&depth=2`]: buttons(["Default", "Hover"]),
};
export const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-headers": "Content-Type,X-Figma-Token",
	"access-control-allow-methods": "GET,PUT,POST,DELETE",
};

export default async function diff(t: Context) {
	const calls: string[] = [];
	const session = await t.open({
		model: (request) =>
			toolResults(request).length === 0
				? toolUse("t1", "figma_diff_versions", { from_version: "111", node_ids: ["1:2"] })
				: text("Done: one page and one variant are new."),
		setup: (page) =>
			page.route("https://api.figma.com/**", async (route) => {
				const request = route.request();
				if (request.method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS });
				calls.push(request.url());
				const found = ANSWERS[request.url()];
				await route.fulfill({ status: found ? 200 : 404, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(found ?? { err: "Not found" }) });
			}),
	});
	await session.login();
	await saveFigmaToken(session, "figd_test-token");
	await session.frame.getByRole("button", { name: "Back to the chat" }).click();
	await session.ask("What changed since version 111?", "Done: one page");
	t.check("the tool is offered", (session.model[0]!.tools ?? []).some((tool) => tool.name === "figma_diff_versions"));
	t.check("REST calls with the file key", JSON.stringify(calls.sort()) === JSON.stringify(Object.keys(ANSWERS).sort()), JSON.stringify(calls));
	const changelog = resultText(toolResults(session.model[1]!)[0]!);
	t.check("the model gets the change log", changelog.includes("Icons `0:2`") && changelog.includes("State=Hover"), changelog.slice(0, 300));
	t.check("the step label", (await session.body()).includes("Compare versions"));
}
