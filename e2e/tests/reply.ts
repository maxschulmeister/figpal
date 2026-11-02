// Reply to a part of an answer (user request, like Cite in T3 Code): select text in an answer, click Reply, and the
// text goes into the composer at the cursor as a Markdown quote.

import { type Context, type ModelRequest, text } from "../harness.ts";

const lastUserText = (request: ModelRequest) => {
	const content = request.messages.filter((message) => message.role === "user").at(-1)!.content;
	return typeof content === "string" ? content : content.map((block: { text?: string }) => block.text ?? "").join("");
};

export default async function reply(t: Context) {
	const session = await t.open({ model: () => (session.model.length === 1 ? text("The padding is 16 px. The radius is 8 px.") : text("Changed.")) });
	await session.login();
	await session.ask("Check the card", "The radius is 8 px.");
	const { frame, page } = session;
	const box = frame.getByRole("textbox", { name: "Ask FigPal" });
	// The cursor is after "Please: ", where the quote goes.
	await box.click();
	await page.keyboard.press("Backspace");
	await page.keyboard.type("Please: ");
	// The user selects a sentence of the answer.
	await frame.getByText("The radius is 8 px.", { exact: false }).evaluate((element) => {
		const node = [...element.childNodes].find((child) => child.textContent?.includes("The radius"))!;
		const start = node.textContent!.indexOf("The radius");
		const range = document.createRange();
		range.setStart(node, start);
		range.setEnd(node, start + "The radius is 8 px.".length);
		getSelection()!.removeAllRanges();
		getSelection()!.addRange(range);
	});
	await frame.getByRole("button", { name: "Reply" }).waitFor();
	await t.screenshot(session, "reply-toolbar");
	await frame.getByRole("button", { name: "Reply" }).click();
	await page.keyboard.type("make it 12 px");
	await t.screenshot(session, "reply-composer");
	await page.keyboard.press("Enter");
	await frame.getByText("Changed.").waitFor();
	const sent = lastUserText(session.model.at(-1)!).replace(/^<figma>[\s\S]*?<\/figma>\s*/, "");
	t.check("Reply puts the selected text at the cursor as a quote", sent === "Please: \n> The radius is 8 px.\n\nmake it 12 px", JSON.stringify(sent));
}
