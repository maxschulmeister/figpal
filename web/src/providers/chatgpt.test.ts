import { type AuthEvent, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentModels } from "../agent";

const ROUTE = "https://figpal.example/api/chatgpt/backend-api";

/** An access token as auth.openai.com makes it: a JWT with the ChatGPT account ID. */
function accessToken(name: string, account: string | null = "acc_1"): string {
	const part = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
	return `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_account_id: account }, name })}.sig`;
}

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers the auth.openai.com endpoints and records all requests. */
function fakeOpenAi(answers: Record<string, (body: string) => Response>) {
	const requests: { url: string; headers: Headers; body: string }[] = [];
	vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
		const request = { url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") };
		requests.push(request);
		const answer = Object.entries(answers).find(([prefix]) => request.url.startsWith(prefix));
		if (!answer) throw new Error(`Unexpected request ${request.url}`);
		return answer[1](request.body);
	}));
	return requests;
}

function chatgptModels() {
	const credentials = new InMemoryCredentialStore();
	return { models: createAgentModels(credentials, "https://figpal.example"), credentials };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("chatgptProvider", () => {
	it("signs in with a device code and saves the token", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		let polls = 0;
		fakeOpenAi({
			"https://auth.openai.com/api/accounts/deviceauth/usercode": () =>
				json({ device_auth_id: "device-1", user_code: "ABCD-1234", interval: "1" }),
			"https://auth.openai.com/api/accounts/deviceauth/token": () =>
				++polls === 1 ? json({ error: "pending" }, 404) : json({ authorization_code: "code-1", code_verifier: "verifier-1" }),
			"https://auth.openai.com/oauth/token": (body) => {
				expect(Object.fromEntries(new URLSearchParams(body))).toMatchObject({ grant_type: "authorization_code", code: "code-1", code_verifier: "verifier-1" });
				return json({ access_token: accessToken("first"), refresh_token: "refresh-1", expires_in: 3600 });
			},
		});
		const { models, credentials } = chatgptModels();
		const events: AuthEvent[] = [];
		const login = models.login("openai-codex", "oauth", { prompt: async () => "", notify: (event) => events.push(event) });
		await vi.advanceTimersByTimeAsync(2000);
		await login;

		expect(events).toContainEqual(
			expect.objectContaining({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://auth.openai.com/codex/device" }),
		);
		expect(await credentials.read("openai-codex")).toMatchObject({ type: "oauth", access: accessToken("first"), refresh: "refresh-1" });
	});

	it("refreshes an expired token, then sends the request through the route with SSE", async () => {
		const requests = fakeOpenAi({
			"https://auth.openai.com/oauth/token": (body) => {
				expect(Object.fromEntries(new URLSearchParams(body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1" });
				return json({ access_token: accessToken("second"), refresh_token: "refresh-2", expires_in: 3600 });
			},
			[ROUTE]: () => json({ error: { message: "test stop" } }, 400),
		});
		const { models, credentials } = chatgptModels();
		await credentials.modify("openai-codex", async () => ({ type: "oauth", access: accessToken("first"), refresh: "refresh-1", expires: 1 }));
		const model = models.getModel("openai-codex", "gpt-5.6-luna")!;
		await models.streamSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: 1 }] }, { maxRetries: 0 }).result();

		const call = requests.find((request) => request.url.startsWith(ROUTE))!;
		expect(call.url).toBe(`${ROUTE}/codex/responses`);
		expect(call.headers.get("authorization")).toBe(`Bearer ${accessToken("second")}`);
		expect(call.headers.get("chatgpt-account-id")).toBe("acc_1");
		expect(await credentials.read("openai-codex")).toMatchObject({ refresh: "refresh-2" });
	});

	/** Runs a login against the answers. Returns its result, or its error. */
	async function login(poll: () => Response, token = accessToken("first"), start = { device_auth_id: "device-1", user_code: "ABCD-1234", interval: "1" }) {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		const requests = fakeOpenAi({
			"https://auth.openai.com/api/accounts/deviceauth/usercode": () => json(start),
			"https://auth.openai.com/api/accounts/deviceauth/token": poll,
			"https://auth.openai.com/oauth/token": () => json({ access_token: token, refresh_token: "refresh-1", expires_in: 3600 }),
		});
		const { models } = chatgptModels();
		const result = models.login("openai-codex", "oauth", { prompt: async () => "", notify() {} }).catch((error: Error) => error);
		await vi.advanceTimersByTimeAsync(20_000);
		return { result: await result, requests };
	}

	it("keeps polling while OpenAI answers 'pending' or 'slow down'", async () => {
		const answers = [
			json({ error: { code: "deviceauth_authorization_pending" } }, 400),
			json({ error: "slow_down" }, 400),
			json({ authorization_code: "code-1", code_verifier: "verifier-1" }),
		];
		const { result, requests } = await login(() => answers.shift()!);
		expect(result).not.toBeInstanceOf(Error);
		expect(requests.filter((request) => request.url.endsWith("/deviceauth/token"))).toHaveLength(3);
	});

	it("refuses a token without a ChatGPT account", async () => {
		const { result } = await login(() => json({ authorization_code: "code-1", code_verifier: "verifier-1" }), accessToken("first", null));
		expect(String(result)).toContain("no ChatGPT account");
	});

	it("refuses a start answer without a code", async () => {
		const { result } = await login(() => json({}), accessToken("first"), { device_auth_id: "device-1" } as never);
		expect(String(result)).toContain("The ChatGPT login answer has missing fields");
	});
});
