// Unread chats (user request): a chat whose answer ends while another chat is open gets a dot in the chat list, and
// the header shows a dot, until the user opens the chat.

import { type Context, text } from "../harness.ts";

export default async function unread(t: Context) {
	const session = await t.open({
		// A slow answer: the user opens a new chat while the first one works.
		model: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			return text("Done.");
		},
	});
	await session.login();
	const { frame, page } = session;
	await frame.getByRole("textbox", { name: "Ask FigPal" }).click();
	await page.keyboard.type("Make a card");
	await page.keyboard.press("Enter");
	await frame.getByRole("button", { name: "Stop" }).waitFor();
	await frame.locator('header [aria-label="New chat"]').click();

	// The header: the title of the open chat, with a dot for the other chat.
	const header = frame.locator("header button").first();
	await frame.locator("header button", { hasText: "unread" }).waitFor({ timeout: 10_000 });
	await t.screenshot(session, "unread-header");
	await header.click();
	const row = frame.locator("main li", { hasText: /Make a card|Test chat/ }).getByRole("button").first();
	await t.screenshot(session, "unread-list");
	t.check("the chat list shows the done chat as unread", /unread/i.test((await row.textContent()) ?? ""), (await row.textContent()) ?? "");
	// User request: unread chats first, then by activity. The new chat is newer, but read.
	const order = await frame.locator("main li").allTextContents();
	t.check("the unread chat comes first", /unread/i.test(order[0] ?? "") && order.length === 2, JSON.stringify(order));
	await row.click();
	await frame.getByText("Done.").waitFor();
	await page.waitForTimeout(300);
	t.check("after it opens, it is read: no dot in the header", !/unread/i.test((await header.textContent()) ?? ""), (await header.textContent()) ?? "");
	await header.click();
	const rows = await frame.locator("main li").allTextContents();
	t.check("and none in the list", !rows.some((value) => /unread/i.test(value)), JSON.stringify(rows));
}
