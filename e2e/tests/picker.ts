// The model and thinking pickers under the message box, and "Edit Models".

import type { Context } from "../harness.ts";

export default async function picker(t: Context) {
	const session = await t.open({ canvas: true });
	await session.login();
	const { page, frame } = session;
	const same = (name: string, actual: unknown, expected: unknown) =>
		t.check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
	const composer = await frame
		.locator("form, [class*=rounded-md][class*=border]")
		.filter({ has: frame.getByRole("textbox", { name: "Ask FigPal" }) })
		.first()
		.boundingBox();
	const model = frame.getByRole("button", { name: "Claude Sonnet 5.5" });
	const thinking = frame.getByRole("button", { name: "Thinking: Medium" });
	same("the model button shows only the model", await model.textContent(), "Claude Sonnet 5.5");
	const modelBox = (await model.boundingBox())!;
	const thinkingBox = (await thinking.boundingBox())!;
	same(
		"both on the left, the model first",
		[modelBox.x < composer!.x + 30, thinkingBox.x > modelBox.x + modelBox.width - 1, thinkingBox.x + thinkingBox.width < composer!.x + composer!.width / 2 + 60],
		[true, true, true],
	);
	await page.mouse.move(10, 10);
	await thinking.hover();
	await page.waitForTimeout(1200);
	same("the thinking tooltip", await frame.getByText("Thinking", { exact: true }).isVisible(), true);
	await thinking.click();
	await page.waitForTimeout(300);
	same("the thinking menu", await frame.getByRole("menuitemradio").allTextContents(), ["Low", "Medium", "High", "Extra high", "Max"]);
	await t.screenshot(session, "picker-thinking");
	await frame.getByRole("menuitemradio", { name: "High", exact: true }).click();
	await page.waitForTimeout(400);
	same("the level changes, and the menu closes", [await frame.getByRole("button", { name: "Thinking: High" }).textContent().catch(() => null), await frame.getByRole("menu").count()], ["High", 0]);
	await model.click();
	await page.waitForTimeout(300);
	const items = await frame.getByRole("menu").locator('[role="menuitem"], [role="menuitemradio"]').allTextContents();
	same("the model menu: no thinking item, Edit Models last", [items.some((item) => item.startsWith("Thinking")), items.at(-1)], [false, "Edit Models"]);
	await t.screenshot(session, "picker-model");
	await frame.getByRole("menuitem", { name: "Edit Models" }).click();
	await page.waitForTimeout(500);
	const tab = () => frame.getByRole("tab", { name: "Models" }).getAttribute("aria-selected").catch(() => null);
	same("Edit Models opens Settings → Models", [await frame.getByRole("dialog").isVisible().catch(() => false), await tab()], [true, "true"]);
	await frame.getByRole("tab", { name: "Skills" }).click();
	await page.waitForTimeout(200);
	await frame.getByRole("button", { name: "Back to the chat" }).click();
	await page.waitForTimeout(300);
	await frame.getByRole("button", { name: "Claude Sonnet 5.5" }).click();
	await page.waitForTimeout(300);
	await frame.getByRole("menuitem", { name: "Edit Models" }).click();
	await page.waitForTimeout(500);
	same("again from another tab", await tab(), "true");
	await frame.getByRole("button", { name: "Back to the chat" }).click();
	await model.focus();
	await page.keyboard.press("ArrowDown");
	await frame.getByRole("menu").waitFor();
	await page.waitForTimeout(300);
	await page.keyboard.press("End");
	await page.waitForTimeout(100);
	same("the keyboard reaches Edit Models", await frame.evaluate(() => document.activeElement?.textContent), "Edit Models");
	await page.keyboard.press("Enter");
	await page.waitForTimeout(400);
	same("the keyboard opens the Models settings", await tab(), "true");
	await frame.getByRole("button", { name: "Back to the chat" }).click();
	await page.setViewportSize({ width: 320, height: 680 });
	await page.locator("#f").evaluate((element) => {
		(element as HTMLElement).style.width = "320px";
	});
	await page.waitForTimeout(300);
	same("a narrow panel has no horizontal scroll", await frame.evaluate(() => document.documentElement.scrollWidth === innerWidth), true);
	await frame.getByRole("button", { name: "Claude Sonnet 5.5" }).click();
	await frame.getByRole("menuitemradio", { name: "Claude Opus 5.5" }).click();
	await page.waitForTimeout(400);
	same("a model choice closes the menu", [await frame.getByRole("menu").count(), await frame.getByRole("button", { name: "Claude Opus 5.5" }).count()], [0, 1]);
	// The mocked answer reports 10 input and 5 output tokens; Claude Opus 5.5 has 1,000,000.
	same("no context usage before the first answer", await frame.getByText(/^Context:/).count(), 0);
	await session.ask("Hi", "Done.");
	// A ring and the percent; the numbers in the tooltip. A used context never shows 0 %.
	same("the context usage after an answer", [await frame.getByText("1%", { exact: true }).isVisible(), await frame.getByText("Context: 15 of 1,000,000 tokens").count()], [true, 1]);
	await frame.getByText("1%", { exact: true }).hover();
	await frame.getByText("15 / 1M tokens", { exact: true }).waitFor();
	t.check("its tooltip has the numbers", true);
	await t.screenshot(session, "picker-context");
}
