// A long chat opens with its newest messages: pi-durable 1.5 watches only the newest 50 entries. "Load earlier" at the
// top shows the messages before them, and the chat keeps its place.

import { type Context, text, toolResults, toolUse } from "../harness.ts";

/** Each call makes 2 entries: an answer and a result. 2 questions with 30 calls each make more than 100 entries. */
const CALLS = 30;

export default async function earlier(t: Context) {
	const session = await t.open({
		requests: { execute: () => ({ result: { value: "1" } }) },
		model: (request) => {
			const done = toolResults(request).length;
			const second = JSON.stringify(request.messages).includes("Second question");
			if (done < (second ? 2 * CALLS : CALLS)) return toolUse(`t${done}`, "figma_execute", { code: "return 1" });
			return text(second ? "All steps are done." : "First steps are done.");
		},
	});
	await session.login();
	await session.ask("First question", "First steps are done.");
	await session.ask("Second question", "All steps are done.");
	const { frame } = session;
	const button = frame.getByRole("button", { name: "Load earlier" });
	const first = frame.getByText("First question");
	t.check("in the open chat, all messages show and there is no Load earlier", (await first.count()) === 1 && (await button.count()) === 0);

	await session.restart();
	await frame.getByText("All steps are done.").waitFor({ timeout: 30_000 });
	await button.waitFor({ timeout: 5_000 }).catch(() => {});
	// The newest entries start in the answer to the second question: the chat loads until that question shows.
	const second = frame.getByText("Second question");
	t.check(
		"after a restart, the long chat starts at the second question, with Load earlier",
		(await button.count()) === 1 && (await second.count()) === 1 && (await first.count()) === 0,
	);
	if (await button.count()) await button.scrollIntoViewIfNeeded();
	await t.screenshot(session, "earlier");

	const top = () => second.evaluate((element) => Math.round(element.getBoundingClientRect().top));
	const before = await top();
	if (await button.count()) await button.click();
	await first.waitFor({ timeout: 5_000 }).catch(() => {});
	t.check("Load earlier shows the first question, and goes away at the start of the chat", (await first.count()) === 1 && (await button.count()) === 0);
	// assistant-ui keeps the place when the messages that showed keep their IDs.
	await session.page.waitForTimeout(300);
	const after = await top();
	t.check("the chat keeps its place: the second question does not move", Math.abs(after - before) <= 2, `${before} → ${after}`);
	await t.screenshot(session, "earlier-loaded");
}
