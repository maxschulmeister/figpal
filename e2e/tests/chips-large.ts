// Large selections and long names in chips, old selection events, and the node list for the model.

import type { Context, Node } from "../harness.ts";

const node = (id: string, name: string, type = "FRAME"): Node => ({ id, name, type });

export default async function chipsLarge(t: Context) {
	const session = await t.open({ canvas: true });
	await session.login();
	const expect = async (name: string, expected: string) => {
		const actual = await session.composer();
		t.check(name, actual === expected, `${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
	};
	await expect("start", "[Card*] ");
	await session.frame.locator('[contenteditable="true"]').click();
	await session.page.keyboard.press("End");
	await session.page.keyboard.type("fix ");
	// code.js sends the first 50 nodes and the count of all.
	const fifty = Array.from({ length: 50 }, (_, i) => node(`1:${100 + i}`, `Frame ${i}`));
	await session.select(fifty, { count: 300 });
	await expect("a large selection: the count of all", "[Card] fix [300 Nodes*] ");
	await session.select([node("1:9", "This is the long text of a text layer that Figma uses as its name", "TEXT")]);
	await expect("a long name is cut, and stays a chip", "[Card] fix [This is the long text of a text layer t…*] ");
	await session.select(fifty, { count: 300 });
	// An event of an older code.js: no count, page or byAgent.
	await session.post({ kind: "event", type: "selection", selection: [{ id: "1:1", name: "Old", type: "FRAME" }] });
	await session.page.waitForTimeout(250);
	await expect("an old event is ignored", "[Card] fix [300 Nodes*] ");
	await session.frame.locator('[contenteditable="true"]').click();
	await session.page.keyboard.press("End");
	await session.page.keyboard.press("Enter");
	await session.frame.getByText("Done.").waitFor({ timeout: 15_000 });
	const content = session.model[0]!.messages[0]!.content;
	const message = typeof content === "string" ? content : content.map((block: { text?: string }) => block.text ?? "").join("");
	const listed = (message.match(/Frame \d+ \(FRAME/g) ?? []).length;
	const more = Number(message.match(/and (\d+) more<\/nodes>/)?.[1]);
	t.check('the model gets some nodes and "and N more"', listed > 5 && more + listed === 300, `${listed} listed, ${more} more`);
}
