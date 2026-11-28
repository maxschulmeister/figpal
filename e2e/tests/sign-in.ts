// The accounts that sign in on a page of the provider: ChatGPT (a device code on OpenAI's page) and Google Antigravity
// (Google's page, through the FigPal command, which keeps the login).

import { ANTIGRAVITY_ROUTE } from "@figpal/shared/routes";
import type { Locator } from "playwright-core";
import type { Context } from "../harness.ts";

const sse = (events: object[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?state=e2e";

export default async function signIn(t: Context) {
	const antigravity: string[] = [];
	const session = await t.open({
		setup: async (page) => {
			// OpenAI gives a device code, and the user has not entered it yet.
			await page.route("https://auth.openai.com/api/accounts/deviceauth/usercode", (route) =>
				route.fulfill({ json: { device_auth_id: "device-1", user_code: "ABCD-1234", interval: 5 } }),
			);
			await page.route("https://auth.openai.com/api/accounts/deviceauth/token", (route) => route.fulfill({ status: 403, body: "{}" }));
			await page.route(`${t.ui}${ANTIGRAVITY_ROUTE}/**`, (route) => {
				const path = new URL(route.request().url()).pathname;
				antigravity.push(path);
				if (path.endsWith("/logout")) return route.fulfill({ body: "Signed out" });
				if (path.endsWith("/models")) return route.fulfill({ json: [] });
				// The first sign-in fails, the second works.
				const events =
					antigravity.filter((seen) => seen.endsWith("/login")).length === 1
						? [{ type: "progress", message: "Downloading Antigravity: 50%" }, { type: "error", message: "The download of Antigravity has a wrong SHA-256" }]
						: [{ type: "auth_url", url: GOOGLE }, { type: "done", marker: "figpal-antigravity:managed-by-antigravity:e2e" }];
				return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse(events) });
			});
		},
	});
	const { frame } = session;
	const account = (name: string) => frame.locator("section", { has: frame.getByText(name, { exact: true }) }).first();
	const opened = () => session.requests.filter((request) => request.type === "open-external").map((request) => (request.params as { url: string }).url);
	/** The requests of code.js come later than the change of the UI. */
	const until = async (done: () => boolean) => {
		for (let i = 0; i < 50 && !done(); i++) await session.page.waitForTimeout(100);
	};
	/** The error of an account, not its status (which is red too while no account is connected). */
	const errors = (section: Locator) => section.locator(":scope > .text-danger");

	const chatgpt = account("ChatGPT");
	await chatgpt.getByRole("button", { name: "Sign in with ChatGPT" }).click();
	await chatgpt.getByText("ABCD-1234").waitFor();
	await until(() => opened().length === 1);
	t.check("ChatGPT: the step shows the code, and FigPal opens OpenAI's page", opened().at(-1) === "https://auth.openai.com/codex/device", JSON.stringify(opened()));
	await t.screenshot(session, "sign-in-chatgpt");
	await chatgpt.getByRole("button", { name: "Open the page again" }).click();
	await until(() => opened().length === 2);
	t.check("ChatGPT: Open the page again opens it again", opened().length === 2, JSON.stringify(opened()));
	await chatgpt.getByRole("button", { name: "Cancel" }).click();
	await chatgpt.getByRole("button", { name: "Sign in with ChatGPT" }).waitFor();
	t.check("ChatGPT: Cancel stops the sign-in, without an error", (await errors(chatgpt).count()) === 0, (await chatgpt.textContent()) ?? "");

	const google = account("Google Antigravity");
	await google.getByRole("button", { name: "Sign in with Google" }).click();
	await google.getByText("The download of Antigravity has a wrong SHA-256").waitFor();
	t.check("Antigravity: a failed sign-in shows the error in red", (await errors(google).textContent()) === "The download of Antigravity has a wrong SHA-256", (await google.textContent()) ?? "");
	await google.getByRole("button", { name: "Sign in with Google" }).click();
	await google.getByText("Signed in", { exact: true }).waitFor();
	await until(() => opened().at(-1) === GOOGLE);
	t.check("Antigravity: FigPal opens Google's page, and the account is signed in", opened().at(-1) === GOOGLE, JSON.stringify(opened()));
	await t.screenshot(session, "sign-in-antigravity");
	await google.getByRole("button", { name: "Sign out" }).click();
	await google.getByRole("button", { name: "Sign in with Google" }).waitFor();
	t.check("Antigravity: Sign out asks the command to forget the login", antigravity.includes(`${ANTIGRAVITY_ROUTE}/logout`), JSON.stringify(antigravity));
}
