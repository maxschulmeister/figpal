// Providers with API keys (Phase 8): the first screen and Settings → Models offer pi-ai's providers. pi-ai asks its
// setup questions one at a time; the requests go through the forward route of the FigPal command.

import type { Context } from "../harness.ts";

/** An answer in OpenAI's Chat Completions format, as DeepSeek streams it. */
const chunks = (text: string) => {
	const events = [
		{ id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-pro", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-pro", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
};

export default async function providers(t: Context) {
	const requests: { url: string; authorization: string | null }[] = [];
	const session = await t.open({
		setup: (page) =>
			page.route(`${t.ui}/api/forward/api.deepseek.com/**`, async (route) => {
				const request = route.request();
				requests.push({ url: request.url(), authorization: await request.headerValue("authorization") });
				const naming = (request.postData() ?? "").includes("Name this chat");
				await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: chunks(naming ? "Test chat" : "Done with DeepSeek.") });
			}),
	});
	const { frame } = session;
	await frame.getByRole("combobox", { name: "Add a provider" }).click();
	await frame.getByRole("combobox", { name: "Search providers" }).fill("deep");
	await t.screenshot(session, "providers-search");
	await frame.getByRole("option", { name: "DeepSeek" }).click();
	const key = frame.getByLabel("Enter DeepSeek API key");
	await key.fill("deepseek-key");
	t.check("the setup asks pi-ai's question, with a hidden field", (await key.getAttribute("type")) === "password", "");
	await frame.getByRole("button", { name: "Continue" }).click();

	// With a key, the chat opens with FigPal's default model of DeepSeek.
	await session.ask("Make a card", "Done with DeepSeek.");
	t.check(
		"the request goes through the forward route with the key",
		requests[0]?.url.startsWith(`${t.ui}/api/forward/api.deepseek.com/`) === true && requests[0]?.authorization === "Bearer deepseek-key",
		JSON.stringify(requests[0]),
	);
	// The model button has the name of the model.
	const picker = frame.getByRole("button", { name: /DeepSeek/ });
	t.check("the chat uses DeepSeek's model", (await picker.count()) === 1, (await frame.locator("form").last().textContent()) ?? "");

	await frame.getByLabel("Settings").click();
	await frame.getByText("DeepSeek", { exact: true }).waitFor();
	const row = frame.locator("section", { has: frame.getByText("DeepSeek", { exact: true }) }).first();
	t.check("Settings → Models shows DeepSeek as connected", (await row.textContent())?.includes("Connected") === true, (await row.textContent()) ?? "");
	await t.screenshot(session, "providers-settings");
	await row.getByRole("button", { name: "Remove" }).click();
	await frame.getByText("DeepSeek", { exact: true }).waitFor({ state: "detached" });
	t.check("Remove removes the key", true);
}
