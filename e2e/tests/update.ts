// The update notice: when npm has a newer FigPal than the FigPal command that runs, FigPal says so when it opens. Update
// starts the update in the command (Terminal on macOS, the command to copy on Linux). Later, or Close after Update,
// hides the notice until the next version. Settings → General keeps the version and Update.

import type { Context } from "../harness.ts";

export default async function update(t: Context) {
	let running = "0.1.5";
	let started = true;
	const posts: string[] = [];
	const session = await t.open({
		setup: (page) =>
			Promise.all([
				page.route(`${t.ui}/health`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ app: "figpal", version: running }) })),
				page.route("https://registry.npmjs.org/figpal/latest", (route) =>
					route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"name":"figpal","version":"0.1.6"}' }),
				),
				page.route(`${t.ui}/api/update`, (route) => {
					posts.push(route.request().method());
					return route.fulfill({ contentType: "application/json", body: JSON.stringify({ started }) });
				}),
			]),
	});
	await session.login();
	const { frame } = session;
	const notice = frame.getByRole("status").filter({ hasText: "FigPal 0.1.6" });
	await notice.getByText("FigPal 0.1.6 is available.").waitFor();
	await t.screenshot(session, "update-notice");
	t.check("the notice has Later and Update", (await notice.getByRole("button").allTextContents()).join(",") === "Later,Update");
	await notice.getByRole("button", { name: "Update" }).click();
	await notice.getByText("Terminal installs FigPal 0.1.6.").waitFor();
	t.check("Update asks the FigPal command to start the update", JSON.stringify(posts) === '["POST"]', JSON.stringify(posts));
	running = "0.1.6";
	await notice.getByText("FigPal 0.1.6 is installed. Run FigPal again in Figma.").waitFor({ timeout: 5000 });
	t.check("when the new version runs, the notice says to run FigPal again", true);

	await notice.getByRole("button", { name: "Close" }).click();
	await notice.waitFor({ state: "detached" });
	running = "0.1.5";
	await session.restart();
	await session.page.waitForTimeout(500);
	t.check("Close after Update hides the notice of this version, also after a restart", (await notice.count()) === 0, await session.body());

	await frame.getByLabel("Settings").click();
	// figma-kit's tab has its text twice: a hidden copy keeps the width of the bold text.
	const first = (await frame.getByRole("tab").first().textContent()) ?? "";
	t.check("General is the first tab", first.slice(0, first.length / 2) === "General", first);
	await frame.getByRole("tab", { name: "General" }).click();
	const settings = frame.getByRole("dialog");
	await settings.getByText("Version 0.1.5").waitFor();
	started = false;
	await settings.getByRole("button", { name: "Update" }).click();
	await settings.getByText("In Terminal, run this command:").waitFor();
	t.check("on Linux, Update gives the command to copy", (await settings.getByText("npx figpal@latest install", { exact: true }).count()) === 1);
	await settings.getByRole("button", { name: "Copy" }).last().scrollIntoViewIfNeeded();
	await t.screenshot(session, "update-settings");
}
