// Run in the background: the button is next to Stop, while the agent works. code.js hides the panel and shows a notice;
// when the agent is idle, the notice says so. The chat list replaces the chat while the agent works: the notice must not
// depend on the open chat.

import { type Context, text } from "../harness.ts";

export default async function background(t: Context) {
	const requests: unknown[] = [];
	const session = await t.open({
		requests: {
			background: (params: unknown) => {
				requests.push(params);
				return { result: null };
			},
		},
		// A slow answer: the user hides the panel while the agent works.
		model: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			return text("Done.");
		},
	});
	await session.login();
	const hide = session.frame.getByRole("button", { name: "Run in the background" });
	t.check("no button while the agent is idle", (await hide.count()) === 0);
	await session.frame.getByRole("textbox", { name: "Ask FigPal" }).click();
	await session.page.keyboard.type("Make a card");
	await session.page.keyboard.press("Enter");
	await hide.hover();
	await t.screenshot(session, "background");
	await hide.click();
	await session.frame.getByRole("button", { name: /Make a card/ }).first().click();
	for (let i = 0; i < 50 && requests.length < 2; i++) await session.page.waitForTimeout(100);
	t.check(
		"the panel hides with a notice, and the notice says when the agent is done",
		JSON.stringify(requests) === JSON.stringify([{ message: "FigPal works in the background." }, { message: "FigPal is done.", update: true }]),
		JSON.stringify(requests),
	);
}
