// The first page of the plugin (Phase 8): it goes to FigPal's UI when the FigPal command answers on this Mac. Until
// then, it says how to start FigPal, and asks again. code.js runs in Node with a fake Figma, and its first page runs in
// Chrome in a frame without an origin, as in Figma.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { chromium } from "playwright-core";
import { CHROME, type Context } from "../harness.ts";

const UI = "http://127.0.0.1:9310";
const PARENT = "https://www.figma.com/figpal-start";

/** The HTML of code.js's first `figma.showUI`. */
async function firstPage(): Promise<string> {
	const plugin = fileURLToPath(new URL("../../plugin", import.meta.url));
	execFileSync("pnpm", ["build"], { cwd: plugin, stdio: "ignore" });
	let html: string | undefined;
	const figma = {
		clientStorage: { getAsync: async () => undefined },
		showUI: (shown: string) => (html ??= shown),
		ui: {},
		on() {},
		viewport: { bounds: { width: 800, height: 450 }, zoom: 1 },
	};
	runInNewContext(readFileSync(`${plugin}/dist/code.js`, "utf8"), { figma, setTimeout, clearTimeout, console });
	for (let attempt = 0; attempt < 50 && html === undefined; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
	if (html === undefined) throw new Error("code.js did not show its first page.");
	return html;
}

export default async function start(t: Context) {
	// Figma adds the theme class after the page starts.
	const html = (await firstPage()).replace("<!doctype html>", `<!doctype html><script>setTimeout(() => (document.documentElement.className = "figma-dark"), 100)</script>`);
	const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--disable-features=LocalNetworkAccessChecks"] });
	try {
		const page = await browser.newPage({ viewport: { width: 420, height: 300 } });
		let running = false;
		await page.route(`${UI}/health`, (route) => (running ? route.fulfill({ contentType: "application/json", body: '{"app":"figpal"}' }) : route.abort("connectionrefused")));
		await page.route(`${UI}/`, (route) => route.fulfill({ contentType: "text/html", body: "<title>FigPal UI</title>" }));
		await page.route(PARENT, (route) =>
			route.fulfill({
				contentType: "text/html",
				body: `<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="width:420px;height:300px;border:0"></iframe><script>
window.messages = [];
addEventListener("message", (event) => window.messages.push(event.data));
document.getElementById("f").srcdoc = ${JSON.stringify(html).replaceAll("</", "<\\/")};
</script></body>`,
			}),
		);
		await page.goto(PARENT);
		const frame = page.frameLocator("#f");
		await frame.getByText("FigPal is not running.").waitFor({ timeout: 5000 });
		t.check("without the FigPal command, the page gives the install command", (await frame.locator("code").textContent()) === "npx figpal@latest install", "");
		await frame.getByRole("button", { name: "Copy" }).click();
		t.check("Copy copies it", (await frame.getByRole("button", { name: "Copied" }).count()) === 1, "");
		await t.screenshot({ page } as never, "start");

		running = true;
		const deadline = Date.now() + 10_000;
		let ui = page.frames().find((item) => item.url().startsWith(UI));
		while (!ui && Date.now() < deadline) {
			await page.waitForTimeout(100);
			ui = page.frames().find((item) => item.url().startsWith(UI));
		}
		t.check("when the command runs, the page opens the UI by itself, with Figma's theme", ui?.url() === `${UI}/#figma-theme=figma-dark`, ui?.url() ?? "no UI");
		const messages = await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages);
		t.check("and tells code.js that the UI loads", JSON.stringify(messages) === JSON.stringify([{ pluginMessage: { kind: "loading" } }]), JSON.stringify(messages));
	} finally {
		await browser.close();
	}
}
