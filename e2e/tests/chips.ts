// Selection chips in the message box: the selection in Figma becomes a chip at the cursor, and the keys treat a chip as
// one character.

import type { Context, Node } from "../harness.ts";

const node = (id: string, name: string, type = "FRAME"): Node => ({ id, name, type });

export default async function chips(t: Context) {
	const session = await t.open({ canvas: true });
	await session.login();
	const { page, frame } = session;
	const keys = async (key: string, times = 1) => {
		for (let i = 0; i < times; i++) await page.keyboard.press(key);
	};
	/** The cursor at the end of the text, then left. */
	const caret = async (left = 0) => {
		await frame.locator('[contenteditable="true"]').click();
		await keys("End");
		await keys("ArrowLeft", left);
	};
	const expect = async (name: string, expected: string) => {
		const actual = await session.composer();
		t.check(name, actual === expected, `${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
	};
	const parts = { id: "0:2", name: "Parts", type: "PAGE" };

	await expect("start with the selection and a space", "[Card*] ");
	await caret();
	await page.keyboard.type("make this red ");
	await expect("typed", "[Card] make this red ");
	await session.select([node("1:3", "Logo", "VECTOR")]);
	await expect("a new selection goes to the cursor", "[Card] make this red [Logo*] ");
	await session.select([node("2:0", "Button", "COMPONENT_SET")], { page: parts });
	await expect("the next selection replaces it, with only the space after it", "[Card] make this red [Button*] ");
	await session.select([]);
	await expect("no selection removes the chip and its space", "[Card] make this red ");
	await session.select([node("9:9", "Made by agent")], { byAgent: true });
	await expect("a selection of the agent makes no chip", "[Card] make this red ");
	await session.select([node("1:3", "Logo", "VECTOR"), node("1:4", "Title", "TEXT")]);
	await expect("mixed types", "[Card] make this red [2 Nodes*] ");
	await session.select([node("1:3", "Logo", "VECTOR"), node("1:7", "Icon", "VECTOR")]);
	await expect("one type", "[Card] make this red [2 Vectors*] ");
	await caret();
	await page.keyboard.type("align them");
	await frame.locator(".node-chip", { hasText: "Card" }).click();
	await expect("a clicked chip is active", "[Card*] make this red [2 Vectors] align them");
	await session.select([node("1:5", "Hero")]);
	await expect("the selection replaces the clicked chip", "[Hero*] make this red [2 Vectors] align them");
	await caret(5);
	await session.select([node("1:6", "Footer")]);
	await expect("in the text: a space before and after the chip", "[Hero] make this red [2 Vectors] align [Footer*] them");
	await session.select([]);
	await expect("no selection in the text keeps the space between the words", "[Hero] make this red [2 Vectors] align them");
	await session.select([node("1:6", "Footer")]);
	await caret(5);
	await keys("Backspace");
	await expect("Backspace deletes a whole chip", "[Hero] make this red [2 Vectors] align them");
	await session.select([node("1:6", "Footer")]);
	await expect("after a space: one space after the chip", "[Hero] make this red [2 Vectors] align [Footer*] them");
	await caret(4);
	await keys("Backspace");
	await expect("Backspace after a chip and its space removes both", "[Hero] make this red [2 Vectors] align them");
	await session.select([node("1:6", "Footer")]);
	await caret(5);
	await page.keyboard.type("x");
	await expect("text right after a chip gets a space before it", "[Hero] make this red [2 Vectors] align [Footer] x them");
	await keys("Backspace");
	await expect("Backspace removes the x", "[Hero] make this red [2 Vectors] align [Footer*] them");
	await keys("Backspace");
	await expect("then the chip and its space", "[Hero] make this red [2 Vectors] align them");
	await session.select([node("1:6", "Footer")]);
	await caret(6);
	await keys("ArrowRight", 2);
	await page.keyboard.type("|");
	await expect("the arrow keys jump over a chip", "[Hero] make this red [2 Vectors] align [Footer] |them");
	await keys("Backspace");
	await keys("ArrowLeft", 2);
	await keys("Delete");
	await expect("Delete before a chip removes it and its space", "[Hero] make this red [2 Vectors] align them");
	await caret();
	await keys("Shift+ArrowLeft", 4);
	await session.select([node("1:8", "Badge")]);
	await expect("highlighted text stays, and the chip goes after it", "[Hero] make this red [2 Vectors] align them [Badge*] ");
	await session.select([]);
	await expect("no selection removes it and its space", "[Hero] make this red [2 Vectors] align them ");
	await caret(3);
	await session.select([node("1:8", "Badge")]);
	await expect("the cursor in a word: the chip goes after the word", "[Hero] make this red [2 Vectors] align them [Badge*] ");
	await session.select([]);
	await expect("no selection keeps the word whole", "[Hero] make this red [2 Vectors] align them ");
	await caret();
	await t.screenshot(session, "chips-composer");
	await keys("Enter");
	await frame.getByText("Done.").waitFor({ timeout: 15_000 });
	await expect("the message box is empty after send", "");
	const bubble = await frame.locator(".node-chip").allTextContents();
	t.check("the sent message shows the chips", bubble.includes("Hero") && bubble.includes("2 Vectors"), JSON.stringify(bubble));
	t.check("the sent message shows no chip markup", !(await session.body()).includes(":node"));
	await t.screenshot(session, "chips-sent");
}
