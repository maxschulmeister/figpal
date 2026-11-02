// Send while the agent works (user request, PLAN: steering). Enter steers: the message joins the running work after
// the current tool step. Cmd+Enter sends after the answer, as the next run. Waiting messages show above the composer,
// where the user can remove them.

import { type Context, type ModelRequest, text, toolResults, toolUse } from "../harness.ts";

/** The texts of the user in a model request, without the <figma> block. */
const userTexts = (request: ModelRequest) =>
	request.messages
		.filter((message) => message.role === "user")
		.flatMap((message) => (typeof message.content === "string" ? [message.content] : message.content.filter((block: { type: string }) => block.type === "text").map((block: { text: string }) => block.text)))
		.map((value: string) => value.replace(/^<figma>[\s\S]*?<\/figma>\s*/, ""));

export default async function steer(t: Context) {
	let release!: () => void;
	const session = await t.open({
		// A slow tool call: the user writes while it runs.
		requests: { execute: () => new Promise((resolve) => (release = () => resolve({ result: { value: "1" } }))) },
		model: (request) => {
			const last = userTexts(request).at(-1);
			if (last === "Then check it") return text("Checked.");
			return toolResults(request).length === 0 ? toolUse("t1", "figma_execute", { code: "return 1" }) : text("Done with 8 px.");
		},
	});
	await session.login();
	const { frame, page } = session;
	const box = frame.getByRole("textbox", { name: "Ask FigPal" });
	await box.click();
	await page.keyboard.type("Make a card");
	await page.keyboard.press("Enter");
	await frame.getByRole("button", { name: "Stop" }).waitFor();
	// The agent works: Enter steers, Cmd+Enter (Ctrl+Enter) waits for the answer.
	await box.click();
	await page.keyboard.type("Use 8 px");
	await page.keyboard.press("Enter");
	await box.click();
	await page.keyboard.type("Then check it");
	await page.keyboard.press("ControlOrMeta+Enter");
	await box.click();
	await page.keyboard.type("Never mind");
	await page.keyboard.press("ControlOrMeta+Enter");
	const waiting = frame.getByRole("list", { name: "Waiting messages" });
	await waiting.getByText("Never mind").waitFor();
	t.check(
		"the waiting messages show above the composer",
		JSON.stringify(await waiting.getByRole("listitem").allTextContents()).includes("Use 8 px") && (await waiting.getByText("Then check it").count()) === 1,
		JSON.stringify(await waiting.getByRole("listitem").allTextContents()),
	);
	await t.screenshot(session, "steer-waiting");
	await waiting.getByRole("listitem").filter({ hasText: "Never mind" }).getByRole("button", { name: "Remove" }).click();
	await waiting.getByText("Never mind").waitFor({ state: "detached" });
	release();
	await frame.getByText("Checked.").waitFor({ timeout: 30_000 });
	const texts = session.model.map((request) => userTexts(request));
	// Request 2 follows the tool step: it has the steer. The last request is the follow-up run.
	t.check("the steer joins the running work after the tool step", texts[1]?.length === 2 && texts[1][0]!.endsWith("Make a card") && texts[1][1] === "Use 8 px", JSON.stringify(texts));
	t.check(
		"the follow-up starts the next run; the removed message never goes",
		texts.at(-1)?.at(-1) === "Then check it" && !JSON.stringify(texts).includes("Never mind"),
		JSON.stringify(texts),
	);
}
