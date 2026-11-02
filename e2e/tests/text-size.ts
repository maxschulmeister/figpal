// The chat text (user: hard to read): 13 px with a line height of 20 px in Inter, Figma's font, which FigPal loads
// itself. Settings → Models → Text size changes it.

import { type Context, text } from "../harness.ts";

export default async function textSize(t: Context) {
	const session = await t.open({ model: () => text("A first paragraph.\n\nA second paragraph.") });
	await session.login();
	await session.ask("Hi", "A second paragraph.");
	const { frame } = session;
	const answer = frame.getByText("A first paragraph.");
	const style = () => answer.evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight]);
	await frame.locator("body").evaluate(() => document.fonts.ready);
	const inter = await frame.locator("body").evaluate(() => [...document.fonts].some((font) => font.family.includes("Inter") && font.status === "loaded"));
	t.check("the answers use Inter, 13 px on 20 px", inter && JSON.stringify(await style()) === JSON.stringify(["13px", "20px"]), JSON.stringify([inter, await style()]));
	await frame.getByLabel("Settings").click();
	await frame.getByRole("button", { name: "Large", exact: true }).click();
	await t.screenshot(session, "text-size-settings");
	await frame.getByRole("button", { name: "Back to the chat" }).click();
	t.check("Large makes them 14 px on 22 px", JSON.stringify(await style()) === JSON.stringify(["14px", "22px"]), JSON.stringify(await style()));
	await t.screenshot(session, "text-size-large");
}
