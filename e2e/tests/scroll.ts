// A long chat scrolls in the chat, and only there (user report: a second scroll bar, with white space below the
// composer). The layer chips of an answer have screen-reader text with position: absolute; without a positioned
// scroll area, it made the page taller than the window.

import { type Context, text, toolResults, toolUse } from "../harness.ts";

const LONG = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: the [Field](#node=1:${i + 2}) atoms are hard to see on the white page.`).join("\n\n");

export default async function scroll(t: Context) {
	const session = await t.open({
		requests: { execute: () => ({ result: { value: "1" } }) },
		model: (request) => (toolResults(request).length < 8 ? toolUse(`t${toolResults(request).length}`, "figma_execute", { code: "return 1" }) : text(LONG)),
	});
	await session.login();
	await session.ask("Build the atoms", "Paragraph 11");
	const sizes = await session.frame.locator("body").evaluate(() => [document.scrollingElement!.scrollHeight, innerHeight]);
	t.check("only the chat scrolls: the page is as tall as the window", sizes[0] === sizes[1], JSON.stringify(sizes));
}
