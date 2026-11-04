// Archive a chat (user request): pi-durable cannot delete one conversation, so the menu says Archive. An archived chat
// moves to the Archived part at the end of the chat list, and opening it brings it back (user request). Archive can be
// undone, so it has no dialog.

import type { Context } from "../harness.ts";

export default async function archive(t: Context) {
	const session = await t.open();
	await session.login();
	await session.ask("Make a card", "Done.");
	const { frame } = session;
	// After the first message, the chat gets its AI name: the harness gives "Test chat".
	await frame.getByRole("button", { name: "Test chat" }).click();
	await frame.getByRole("button", { name: "More for Test chat" }).click();
	await frame.getByRole("menuitem").first().waitFor();
	const items = await frame.getByRole("menuitem").allTextContents();
	t.check("the menu of a chat has Rename and Archive", JSON.stringify(items) === JSON.stringify(["Rename…", "Archive"]), JSON.stringify(items));
	await frame.getByRole("menuitem", { name: "Archive" }).click();

	const list = frame.locator("main ul").first();
	await list.getByText("Test chat").waitFor({ state: "detached" });
	t.check("the archived chat leaves the list, without a dialog", (await frame.getByRole("alertdialog").count()) === 0, "");
	const archived = frame.getByRole("button", { name: "Archived (1)" });
	await archived.click();
	// The list never scrolls sideways (a heading wider than the list did, after its click).
	const sideways = await frame.locator("main").evaluate((main) => main.scrollWidth - main.clientWidth);
	t.check("the list is not wider than the panel", sideways === 0, String(sideways));
	await t.screenshot(session, "archive");
	await frame.getByRole("button", { name: /^Test chat/ }).click();
	await frame.getByText("Done.").waitFor();
	t.check("opening an archived chat opens it", (await frame.locator("header button").first().textContent())?.includes("Test chat") === true, "");

	await frame.locator("header button").first().click();
	const rows = await frame.locator("main li").allTextContents();
	t.check(
		"and brings it back to the list",
		rows.some((row) => row.startsWith("Test chat")) && (await frame.getByRole("button", { name: /^Archived/ }).count()) === 0,
		JSON.stringify(rows),
	);
}
