// Backup (Phase 8): the chats and skills belong to the origin of the UI. Export them on one origin, and import them on
// another: here, a second browser with empty storage, as FigPal on a new origin. The file has no keys.

import { readFileSync } from "node:fs";
import type { Context, Session } from "../harness.ts";

async function openAccess(session: Session) {
	await session.frame.getByRole("button", { name: "Settings" }).click();
	await session.frame.getByRole("tab", { name: "Access" }).click();
}

export default async function backup(t: Context) {
	const fileId = `e2e-backup-${Date.now()}`;
	const old = await t.open({ fileId });
	await old.login();
	await old.ask("Make a card", "Done.");
	await openAccess(old);
	const [download] = await Promise.all([old.page.waitForEvent("download"), old.frame.getByRole("button", { name: "Export" }).click()]);
	const path = await download.path();
	const text = readFileSync(path, "utf8");
	t.check("the backup is a file with the date in its name", /^figpal-backup-\d{4}-\d{2}-\d{2}\.jsonl$/.test(download.suggestedFilename()), download.suggestedFilename());
	t.check("the backup has the chat, and no key", text.includes("Make a card") && !text.includes("sk-ant-oat01-test"), "");

	const fresh = await t.open({ fileId });
	await fresh.login();
	await openAccess(fresh);
	await fresh.frame.getByLabel("Backup file").setInputFiles(path);
	const question = fresh.frame.getByText(/^Import the chats of 1 file/);
	await question.waitFor();
	// Playwright's scrollIntoViewIfNeeded does not scroll the settings panel.
	await question.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await t.screenshot(fresh, "backup");
	await fresh.frame.getByRole("button", { name: "Import", exact: true }).click();
	// FigPal starts again and imports the file before it opens its storage.
	await fresh.frame.getByRole("button", { name: "Test chat" }).waitFor({ timeout: 30_000 });
	await fresh.frame.getByText("Done.").waitFor();
	t.check("after the import, the chat of the other origin opens", (await fresh.body()).includes("Make a card"), await fresh.body());
}
