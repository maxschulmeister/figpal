// The statuses of the settings: green when on; grey when off and nothing is wrong; red when FigPal cannot work (no
// model account).

import type { Context } from "../harness.ts";

export default async function status(t: Context) {
	const session = await t.open({});
	const { frame } = session;
	/** The tone of the status of an account: its color class. */
	const tone = async (account: string) => {
		const header = frame.locator("section", { has: frame.getByText(account, { exact: true }) }).first().locator("> div").first();
		const text = header.locator("> :nth-child(2)");
		return `${await text.textContent()}: ${(await text.getAttribute("class"))?.match(/text-(success|secondary|danger)/)?.[1]}`;
	};
	await frame.getByText("ChatGPT", { exact: true }).waitFor();
	const first = [await tone("Claude"), await tone("ChatGPT")];
	t.check("without a model account, both say so in red", JSON.stringify(first) === JSON.stringify(["Not connected: danger", "Not signed in: danger"]), JSON.stringify(first));
	await session.login();
	await frame.getByLabel("Settings").click();
	const models = [await tone("Claude"), await tone("ChatGPT")];
	t.check("with Claude: Connected in green, ChatGPT Not signed in in grey", JSON.stringify(models) === JSON.stringify(["Connected: success", "Not signed in: secondary"]), JSON.stringify(models));
	await frame.getByRole("tab", { name: "Access" }).click();
	const access = [await tone("Personal access token"), await tone("Local helper"), await tone("MCP")];
	t.check(
		"the optional parts that are off are grey",
		JSON.stringify(access) === JSON.stringify(["Not connected: secondary", "Not running: secondary", "Not connected: secondary"]),
		JSON.stringify(access),
	);
	await t.screenshot(session, "status-access");
}
