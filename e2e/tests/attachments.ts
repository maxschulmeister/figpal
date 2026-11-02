// Attachments (user request): the "+" button and paste add files; long pasted text becomes a file. The model gets the
// image as an image and the files as text; the sent message shows their chips.

import { type Context, text } from "../harness.ts";

/** A PNG of 1 × 1 px. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i} of the brief.`).join("\n");

export default async function attachments(t: Context) {
	const session = await t.open({ model: () => text("Got it.") });
	await session.login();
	const { frame, page } = session;
	const [chooser] = await Promise.all([page.waitForEvent("filechooser"), frame.getByRole("button", { name: "Add files" }).click()]);
	await chooser.setFiles([
		{ name: "logo.png", mimeType: "image/png", buffer: PNG },
		{ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes") },
	]);
	const box = frame.getByRole("textbox", { name: "Ask FigPal" });
	/** Pastes into the composer, as Cmd+V does. */
	const paste = (data: { text?: string; file?: [string, string] }) =>
		box.evaluate((element, data) => {
			const transfer = new DataTransfer();
			if (data.text) transfer.setData("text/plain", data.text);
			if (data.file) transfer.items.add(new File(["%PDF"], data.file[0], { type: data.file[1] }));
			element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
		}, data);
	await box.click();
	await paste({ text: LONG });
	await paste({ file: ["brief.pdf", "application/pdf"] });
	await frame.getByText('FigPal cannot send "brief.pdf"', { exact: false }).waitFor();
	const chips = frame.getByRole("list", { name: "Attachments" });
	await chips.getByText("Pasted text.txt").waitFor();
	t.check(
		"the + button and paste add files; long pasted text becomes a file; a PDF is refused",
		// An image takes longer to add: the order can change.
		JSON.stringify((await chips.getByRole("listitem").allTextContents()).sort()) === JSON.stringify(["Pasted text.txt", "logo.png", "notes.md"]),
		JSON.stringify(await chips.getByRole("listitem").allTextContents()),
	);
	t.check("the long text is not in the message", !((await box.textContent()) ?? "").includes("Line 3"));
	await t.screenshot(session, "attachments-composer");
	await box.click();
	await page.keyboard.type("Use these");
	await page.keyboard.press("Enter");
	await frame.getByText("Got it.").waitFor();
	t.check("the + button does not send the message", session.model.length === 1, String(session.model.length));
	t.check("the note about the PDF goes with the sent message", (await frame.getByText('FigPal cannot send "brief.pdf"', { exact: false }).count()) === 0);
	const content = session.model.at(-1)!.messages.filter((message) => message.role === "user").at(-1)!.content as { type: string; text?: string; source?: { media_type: string } }[];
	const texts = content.filter((block) => block.type === "text").map((block) => block.text ?? "");
	t.check(
		"the model gets the image, and the files as text with their names",
		content.some((block) => block.type === "image" && block.source?.media_type === "image/png") &&
			texts.some((value) => value.startsWith('<attachment name="notes.md">') && value.includes("# Notes")) &&
			texts.some((value) => value.startsWith('<attachment name="Pasted text.txt">') && value.includes("Line 39")),
		JSON.stringify(content).slice(0, 400),
	);
	const sent = frame.getByRole("list", { name: "Attachments of the message" });
	t.check("the sent message shows their chips", (await sent.getByRole("listitem").count()) === 3, String(await sent.getByRole("listitem").count()));
	await t.screenshot(session, "attachments-sent");
}
