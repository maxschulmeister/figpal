// AI chat names (user request, like T3 Code): after the first answer, a small model names the chat from the question
// and the answer. Settings → Models → Text generation model picks the model; Automatic is the cheapest model of the
// chat's provider.

import { type Context, type ModelRequest, text } from "../harness.ts";

type Request = ModelRequest & { model: string };

export default async function names(t: Context) {
	const naming: Request[] = [];
	const session = await t.open({
		model: () => text("The padding is 12 px."),
		naming: (request) => {
			naming.push(request as Request);
			return text(naming.length === 1 ? "Card padding check" : "Button colors");
		},
	});
	await session.login();
	const { frame } = session;
	const title = frame.locator("header button").first();

	await session.ask("Check the card", "The padding is 12 px.");
	await frame.getByRole("button", { name: "Card padding check" }).waitFor();
	const first = naming[0];
	t.check(
		"after the first answer, the cheapest model of the chat's provider names the chat, without tools",
		first?.model === "claude-haiku-5-5" && !first.tools?.length && JSON.stringify(first.messages).includes("The padding is 12 px."),
		JSON.stringify({ model: first?.model, tools: first?.tools?.length }),
	);
	await session.ask("Now make it blue", "The padding is 12 px.");
	await session.page.waitForTimeout(500);
	t.check("only the first answer names the chat", naming.length === 1 && (await title.textContent()) === "Card padding check", String(naming.length));

	await frame.getByLabel("Settings").click();
	const select = frame.getByRole("combobox", { name: "Text generation model" });
	t.check("the setting is Automatic by default", (await select.textContent())?.includes("Automatic") === true, (await select.textContent()) ?? "");
	await select.click();
	await frame.getByRole("option", { name: "Claude Sonnet 5.5" }).click();
	await t.screenshot(session, "names-setting");
	await frame.getByRole("button", { name: "Back to the chat" }).click();
	await frame.getByRole("button", { name: "New chat" }).click();
	await session.ask("Check the buttons", "The padding is 12 px.");
	await frame.getByRole("button", { name: "Button colors" }).waitFor();
	t.check("the chosen model names the next chat", naming[1]?.model === "claude-sonnet-5-5", naming[1]?.model ?? "none");
}
