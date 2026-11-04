// AI chat names (user request, like T3 Code): after the first message, a small model names the chat from the message
// (user request: not after the first answer). Settings → Models → Text generation model picks the model; Automatic is the cheapest model of the
// chat's provider.

import { type Context, type ModelRequest, text } from "../harness.ts";

type Request = ModelRequest & { model: string; thinking?: { type: string } };
/** pi-ai sends the thinking level of Claude 5.5 models as the last message: `output_config.effort`. */
const effort = (request: Request | undefined) => (request?.messages.at(-1) as { output_config?: { effort?: string } } | undefined)?.output_config?.effort;

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
		"after the first message, the cheapest model of the chat's provider names the chat from the message, without tools",
		first?.model === "claude-haiku-5-5" &&
			!first.tools?.length &&
			JSON.stringify(first.messages).includes("Check the card") &&
			!JSON.stringify(first.messages).includes("The padding is 12 px.") &&
			first.thinking?.type === "disabled",
		JSON.stringify({ model: first?.model, tools: first?.tools?.length, thinking: first?.thinking }),
	);
	await session.ask("Now make it blue", "The padding is 12 px.");
	await session.page.waitForTimeout(500);
	t.check("only the first answer names the chat", naming.length === 1 && (await title.textContent()) === "Card padding check", String(naming.length));

	await frame.getByLabel("Settings").click();
	const select = frame.getByRole("combobox", { name: "Text generation model" });
	t.check("the setting is Automatic by default", (await select.textContent())?.includes("Automatic") === true, (await select.textContent()) ?? "");
	await select.click();
	await frame.getByRole("option", { name: "Claude Sonnet 5.5" }).click();
	// Claude Sonnet 5.5 always thinks: Off shows as its lowest level.
	const thinking = frame.getByRole("combobox", { name: "Thinking" });
	t.check("the thinking level shows as the chosen model uses it", (await thinking.textContent())?.includes("Low") === true, (await thinking.textContent()) ?? "");
	await thinking.click();
	await frame.getByRole("option", { name: "Medium" }).click();
	await t.screenshot(session, "names-setting");
	await frame.getByRole("button", { name: "Back to the chat" }).click();
	await frame.getByRole("button", { name: "New chat" }).click();
	await session.ask("Check the buttons", "The padding is 12 px.");
	await frame.getByRole("button", { name: "Button colors" }).waitFor();
	const second = naming[1];
	t.check(
		"the chosen model and thinking level name the next chat",
		second?.model === "claude-sonnet-5-5" && second.thinking?.type !== "disabled" && effort(second) === "medium",
		JSON.stringify({ model: second?.model, thinking: second?.thinking?.type, effort: effort(second) }),
	);
}
