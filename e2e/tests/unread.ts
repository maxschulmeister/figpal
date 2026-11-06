// Unread chats and the groups of the chat list (user requests): a chat whose answer ends while another chat is open
// gets a dot in the list and in the header, until the user opens it. The list has the groups Done, Working, Settled
// and Archived, like T3 Code's sidebar: Done at the top without a heading, the others at the bottom, each folds. Only
// Settle in the menu of a chat moves it to Settled, not reading it; Unsettle moves it back.

import { type Context, text } from "../harness.ts";

export default async function unread(t: Context) {
	// The answer waits until the check has seen the chat in Working: the user opens a new chat while the first one works.
	// A fixed wait failed on the slower CI runner, where the answer came before the list opened.
	let answer!: () => void;
	const answered = new Promise<void>((resolve) => (answer = resolve));
	const session = await t.open({
		model: async () => {
			await answered;
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

	// The chat of each group, by the name of its group.
	const header = frame.locator("header button").first();
	const group = (name: string) => frame.getByRole("region", { name });
	const chats = async () => {
		const names: Record<string, string[]> = {};
		for (const name of ["Done", "Working", "Settled"]) names[name] = (await group(name).getByRole("listitem").allTextContents()).map((row) => row.replace(/this minute|Unread/g, ""));
		return JSON.stringify(names);
	};
	await header.click();
	// The AI name comes soon after the message; the harness gives "Test chat".
	await group("Working").getByText("Test chat").waitFor();
	t.check("while it works, the first chat is in Working", (await chats()) === JSON.stringify({ Done: ["New chat"], Working: ["Test chat"], Settled: [] }), await chats());
	await t.screenshot(session, "groups-working");
	answer();

	await group("Done").getByText("Test chat").waitFor({ timeout: 10_000 });
	t.check("when it is done, it moves to Done, with a dot", (await chats()) === JSON.stringify({ Done: ["Test chat", "New chat"], Working: [], Settled: [] }), await chats());
	t.check("the done chat has the dot", /Unread/.test((await group("Done").getByRole("listitem").first().textContent()) ?? ""), "");
	await t.screenshot(session, "unread-list");
	await frame.getByRole("button", { name: "Back to the chat" }).click();
	t.check("the header shows a dot for it", /unread/i.test((await header.textContent()) ?? ""), (await header.textContent()) ?? "");
	await header.click();
	const menu = async (chat: string, item: string) => {
		await frame.getByRole("button", { name: `More for ${chat}` }).click();
		await frame.getByRole("menuitem", { name: item, exact: true }).click();
	};
	await menu("New chat", "Settle");
	await group("Settled").waitFor();
	t.check("Settle in the menu moves a chat to Settled", (await chats()) === JSON.stringify({ Done: ["Test chat"], Working: [], Settled: ["New chat"] }), await chats());
	const layout = await frame.locator("main").evaluate((main) => {
		const box = (name: string) => main.querySelector(`[aria-label="${name}"]`)!.getBoundingClientRect();
		return { headings: [...main.querySelectorAll("button")].map((button) => button.textContent).filter((text) => /^(Done|Working|Settled)/.test(text ?? "")), doneTop: Math.round(box("Done").top - main.getBoundingClientRect().top), settledBottom: Math.round(main.getBoundingClientRect().bottom - box("Settled").bottom) };
	});
	t.check(
		"Done is at the top without a heading; Settled is at the bottom, with a heading that folds",
		JSON.stringify(layout.headings) === JSON.stringify(["Settled (1)"]) && layout.doneTop < 16 && layout.settledBottom <= 32,
		JSON.stringify(layout),
	);
	await frame.getByRole("button", { name: "Settled (1)" }).click();
	t.check("a click folds the group", (await group("Settled").getByRole("listitem").count()) === 0, "");
	await frame.getByRole("button", { name: "Back to the chat" }).click();
	await header.click();
	t.check("the group stays folded", (await group("Settled").getByRole("listitem").count()) === 0, "");
	await frame.getByRole("button", { name: "Settled (1)" }).click();
	await frame.getByRole("button", { name: "Back to the chat" }).click();

	await header.click();
	await group("Done").getByRole("button").first().click();
	await frame.getByText("Done.").waitFor();
	t.check("after it opens, it is read: no dot in the header", !/unread/i.test((await header.textContent()) ?? ""), (await header.textContent()) ?? "");
	await header.click();
	t.check("and it stays in Done", (await chats()) === JSON.stringify({ Done: ["Test chat"], Working: [], Settled: ["New chat"] }), await chats());
	await frame.getByRole("button", { name: "More for New chat" }).click();
	await frame.getByRole("menuitem").first().waitFor();
	const items = await frame.getByRole("menuitem").allTextContents();
	t.check("a settled chat has Unsettle in its menu", JSON.stringify(items) === JSON.stringify(["Rename…", "Unsettle", "Archive"]), JSON.stringify(items));
	await frame.getByRole("menuitem", { name: "Unsettle" }).click();
	await group("Settled").waitFor({ state: "detached" });
	t.check("Unsettle moves it back to Done", (await chats()) === JSON.stringify({ Done: ["Test chat", "New chat"], Working: [], Settled: [] }), await chats());
}
