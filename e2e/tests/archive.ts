// Archive a chat (user request: pi-durable cannot delete one conversation, so the action that only hides a chat must
// not say "Delete"). The chat leaves the list of the file; its entries stay in the storage.

import type { Context } from "../harness.ts";

export default async function archive(t: Context) {
	const session = await t.open();
	await session.login();
	await session.ask("Make a card", "Done.");
	const { frame } = session;
	await frame.getByRole("button", { name: /Make a card/ }).first().click();
	// The title has the selected layer too: "Card Make a card".
	await frame.getByRole("button", { name: "More for Card Make a card" }).click();
	await frame.getByRole("menuitem").first().waitFor();
	const items = await frame.getByRole("menuitem").allTextContents();
	t.check("the menu of a chat has Rename and Archive", JSON.stringify(items) === JSON.stringify(["Rename…", "Archive…"]), JSON.stringify(items));
	await frame.getByRole("menuitem", { name: "Archive…" }).click();
	const dialog = frame.getByRole("alertdialog");
	const shown = (await dialog.textContent()) ?? "";
	await t.screenshot(session, "archive");
	t.check("the dialog says Archive, not Delete", shown.includes("Archive “Card Make a card”?") && !/delete/i.test(shown), shown);
	await dialog.getByRole("button", { name: "Archive" }).click();
	await dialog.waitFor({ state: "detached" });
	const left = await frame.getByRole("button", { name: /Make a card/ }).count();
	t.check("the archived chat leaves the list", left === 0, String(left));
}
