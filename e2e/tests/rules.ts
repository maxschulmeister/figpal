// Rules (user request, like AGENTS.md): Settings → Rules has the rules for all files (only this user) and the rules
// for this file (in the file). The model gets both in each request.

import type { Context } from "../harness.ts";

export default async function rules(t: Context) {
	let fileRules = "";
	const session = await t.open({
		requests: {
			rules: ({ text }) => {
				if (typeof text === "string") fileRules = text;
				return { result: fileRules };
			},
		},
	});
	await session.login();
	const { frame } = session;
	await frame.getByLabel("Settings").click();
	// figma-kit's tab has its text twice: a hidden copy keeps the width of the bold text.
	const tabs = (await frame.getByRole("tab").allTextContents()).map((text) => text.slice(0, text.length / 2));
	t.check("the tabs are Rules, Models, Skills and Access", JSON.stringify(tabs) === JSON.stringify(["Rules", "Models", "Skills", "Access"]), JSON.stringify(tabs));
	await frame.getByRole("tab", { name: "Rules" }).click();
	const global = frame.getByRole("textbox", { name: "For all files" });
	const file = frame.getByRole("textbox", { name: "For this file" });
	await global.fill("Answer briefly.");
	await file.fill("x".repeat(4100));
	const limit = frame.getByText("Rules can have up to 4,000 characters.");
	t.check("a text stops at 4,000 characters, with a note", (await file.inputValue()).length === 4000 && (await limit.count()) === 1, String((await file.inputValue()).length));
	await file.fill("Use the Brand library.");
	t.check("the note goes when the text is shorter", (await limit.count()) === 0, String(await limit.count()));
	await t.screenshot(session, "rules");
	await frame.getByRole("button", { name: "Back to the chat" }).click();

	await session.ask("Make a card", "Done.");
	const system = JSON.stringify((session.model[0] as { system?: unknown }).system);
	t.check(
		"the model gets the rules for all files, then the rules for this file",
		system.includes("Answer briefly.") && system.indexOf("Answer briefly.") < system.indexOf("Use the Brand library."),
		system.slice(-400),
	);
	t.check("the rules for this file are in the file", fileRules === "Use the Brand library.", fileRules.slice(0, 80));

	await frame.getByLabel("Settings").click();
	await frame.getByRole("tab", { name: "Rules" }).click();
	t.check("Settings shows the saved rules again", (await global.inputValue()) === "Answer briefly." && (await file.inputValue()) === "Use the Brand library.", await global.inputValue());
}
