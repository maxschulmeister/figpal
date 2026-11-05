// ChatGPT (Codex) in the browser. pi-ai's Codex OAuth module needs Node (a callback server), so this is a browser port
// of its device code login and token refresh (pi-ai 1.4.0, dist/auth/oauth/openai-codex.js, MIT).
// chatgpt.com allows CORS only from localhost, so requests go through the route /api/chatgpt (spike 0.4).

import type { OAuthAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { sleep } from "@earendil-works/pi-ai/utils/sleep";
import { ROUTES } from "@figpal/shared/routes";

export const CHATGPT_ROUTE = `${ROUTES.chatgpt.path}/backend-api`;

const AUTH = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_TIMEOUT_MS = 15 * 60_000;
/** RFC 8628: after "slow_down", poll 5 seconds less often. */
const SLOW_DOWN_MS = 5000;

const postJson = (url: string, body: object, signal: AbortSignal) =>
	fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });

/** The Codex API reads the ChatGPT account from the token. Without it, every request fails. */
function hasAccount(accessToken: string): boolean {
	try {
		const payload = JSON.parse(atob(accessToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
		return typeof payload?.["https://api.openai.com/auth"]?.chatgpt_account_id === "string";
	} catch {
		return false;
	}
}

async function requestToken(body: Record<string, string>, signal: AbortSignal): Promise<OAuthCredential> {
	const response = await fetch(`${AUTH}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
		signal,
	});
	if (!response.ok) throw new Error(`ChatGPT token request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
	const json = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
	if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string" || typeof json.expires_in !== "number")
		throw new Error("The ChatGPT token answer has missing fields");
	if (!hasAccount(json.access_token)) throw new Error("This login has no ChatGPT account. Sign in with a ChatGPT plan.");
	return { type: "oauth", access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
}

/** The error code in a poll answer: `{ error: "slow_down" }` or `{ error: { code: … } }`. */
async function errorCode(response: Response): Promise<unknown> {
	const json = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
	return typeof json?.error === "object" ? (json.error as { code?: unknown } | null)?.code : json?.error;
}

export const chatgptOAuth: OAuthAuth = {
	name: "ChatGPT",
	isSubscription: true,
	/** Device code login: the user enters a code on auth.openai.com. */
	async login({ notify, signal }) {
		const start = await postJson(`${AUTH}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID }, signal);
		if (!start.ok) throw new Error(`The ChatGPT login did not start (${start.status}): ${(await start.text()).slice(0, 300)}`);
		const device = (await start.json()) as { device_auth_id?: unknown; user_code?: unknown; interval?: unknown };
		const interval = Number(device.interval ?? 5);
		if (typeof device.device_auth_id !== "string" || typeof device.user_code !== "string" || !Number.isFinite(interval))
			throw new Error("The ChatGPT login answer has missing fields");
		let intervalMs = Math.max(interval, 1) * 1000;
		notify({
			type: "device_code",
			userCode: device.user_code,
			verificationUri: `${AUTH}/codex/device`,
			intervalSeconds: intervalMs / 1000,
			expiresInSeconds: DEVICE_TIMEOUT_MS / 1000,
		});
		const deadline = Date.now() + DEVICE_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await sleep(intervalMs, signal);
			const poll = await postJson(
				`${AUTH}/api/accounts/deviceauth/token`,
				{ device_auth_id: device.device_auth_id, user_code: device.user_code },
				signal,
			);
			// The user has not entered the code yet.
			if (poll.status === 403 || poll.status === 404) continue;
			if (!poll.ok) {
				const code = await errorCode(poll);
				if (code === "deviceauth_authorization_pending") continue;
				if (code === "slow_down") {
					intervalMs += SLOW_DOWN_MS;
					continue;
				}
				throw new Error(`The ChatGPT login failed (${poll.status}${typeof code === "string" ? `: ${code}` : ""})`);
			}
			const answer = (await poll.json()) as { authorization_code?: unknown; code_verifier?: unknown };
			if (typeof answer.authorization_code !== "string" || typeof answer.code_verifier !== "string")
				throw new Error("The ChatGPT login answer has no code");
			return requestToken(
				{
					grant_type: "authorization_code",
					code: answer.authorization_code,
					code_verifier: answer.code_verifier,
					redirect_uri: `${AUTH}/deviceauth/callback`,
				},
				signal,
			);
		}
		throw new Error("The ChatGPT login timed out");
	},
	// pi-ai shows only "OAuth refresh failed" in the chat, so log the cause (for example invalid_grant).
	refresh: (credential, signal) =>
		requestToken({ grant_type: "refresh_token", refresh_token: credential.refresh }, signal).catch((error) => {
			console.error("FigPal: the ChatGPT token refresh failed:", error);
			throw error;
		}),
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

/** pi-ai's Codex provider with the browser login. agent.ts sends its requests through the route. */
export function chatgptProvider(): Provider {
	return { ...openaiCodexProvider(), auth: { oauth: chatgptOAuth } };
}
