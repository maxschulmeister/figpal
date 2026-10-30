// ChatGPT logins in the browser (spike 0.4). Ports of the pi-ai flows, which use Node modules.

const AUTH = "https://auth.openai.com";

export type Token = { access: string; refresh: string; expires: number };

async function postJson(url: string, body: unknown): Promise<Response> {
	return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
	if (!response.ok) throw new Error(`${url} failed (${response.status}): ${await response.text()}`);
	return response.json();
}

function toToken(json: Record<string, unknown>): Token {
	if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string" || typeof json.expires_in !== "number")
		throw new Error(`Token response is missing fields: ${Object.keys(json).join(", ")}`);
	return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
}

// --- Codex device code (token for chatgpt.com/backend-api/codex) ---

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export async function codexDeviceLogin(
	showCode: (userCode: string, url: string) => void,
	signal: AbortSignal,
): Promise<Token> {
	const start = await postJson(`${AUTH}/api/accounts/deviceauth/usercode`, { client_id: CODEX_CLIENT_ID });
	if (!start.ok) throw new Error(`Device code request failed (${start.status}): ${await start.text()}`);
	const device = (await start.json()) as { device_auth_id: string; user_code: string; interval: number | string };
	showCode(device.user_code, `${AUTH}/codex/device`);
	const intervalMs = Math.max(Number(device.interval) || 5, 1) * 1000;
	const deadline = Date.now() + 15 * 60_000;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		signal.throwIfAborted();
		const poll = await postJson(`${AUTH}/api/accounts/deviceauth/token`, {
			device_auth_id: device.device_auth_id,
			user_code: device.user_code,
		});
		if (poll.status === 403 || poll.status === 404) continue;
		const json = (await poll.json()) as { authorization_code?: string; code_verifier?: string; error?: unknown };
		if (!poll.ok) {
			if (JSON.stringify(json.error ?? "").includes("pending")) continue;
			throw new Error(`Device login failed (${poll.status}): ${JSON.stringify(json)}`);
		}
		if (!json.authorization_code || !json.code_verifier) throw new Error("Device login response is missing the code");
		return toToken(
			await postForm(`${AUTH}/oauth/token`, {
				grant_type: "authorization_code",
				client_id: CODEX_CLIENT_ID,
				code: json.authorization_code,
				code_verifier: json.code_verifier,
				redirect_uri: `${AUTH}/deviceauth/callback`,
			}),
		);
	}
	throw new Error("Device login timed out");
}

// --- Sign in with ChatGPT (token for api.openai.com, the newer pi-ai flow) ---

const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function randomValue(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export type ApiLogin = { url: string; verifier: string; state: string };

/** Step 1: the URL to open. After the login, the browser goes to 127.0.0.1:1455, which does not load. */
export async function startApiLogin(deviceId: string): Promise<ApiLogin> {
	const verifier = randomValue();
	const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	const state = randomValue();
	const url = new URL(`${AUTH}/api/accounts/authorize`);
	url.search = new URLSearchParams({
		client_id: "dynamic_agent_client",
		agent_name_hint: "FigPal",
		ext_agent_host_id: `urn:uuid:${deviceId}`,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		resource: RESOURCE,
		scope: SCOPE,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		nonce: randomValue(),
	}).toString();
	return { url: url.toString(), verifier, state };
}

/** Step 2: the user pastes the URL of the page that did not load. */
export async function finishApiLogin(login: ApiLogin, pastedUrl: string): Promise<Token & { clientId: string }> {
	const url = new URL(pastedUrl.trim());
	const error = url.searchParams.get("error");
	if (error) throw new Error(`Login failed: ${error}`);
	if (url.searchParams.get("state") !== login.state) throw new Error("State does not match. Start the login again.");
	const code = url.searchParams.get("code");
	const clientId = url.searchParams.get("client_id");
	if (!code || !clientId) throw new Error("The URL has no code or client_id");
	const json = await postForm(`${AUTH}/api/accounts/oauth/token`, {
		grant_type: "authorization_code",
		client_id: clientId,
		code,
		code_verifier: login.verifier,
		redirect_uri: REDIRECT_URI,
		resource: RESOURCE,
	});
	return { ...toToken(json), clientId };
}
