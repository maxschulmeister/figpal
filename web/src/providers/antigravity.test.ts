import { type AuthEvent, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentModels } from "../agent";
import { ANTIGRAVITY_ID, signOutOfAntigravity } from "./antigravity";

const ORIGIN = "https://figpal.example";
const MARKER = "figpal-antigravity:managed-by-antigravity:1";
const sse = (events: object[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const MODEL = {
	id: "gemini-3.8-flash",
	name: "Gemini 3.8 Flash",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "",
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high", xhigh: null, max: null },
	input: ["text", "image"],
	cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

/** The routes of the FigPal command, as local/antigravity/routes.ts answers them. */
function command() {
	const requests: { url: string; method: string; headers: Headers; body?: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
			if (url.endsWith("/login"))
				return sse([
					{ type: "progress", message: "Downloading Antigravity: 50%" },
					{ type: "auth_url", url: "https://accounts.google.com/o/oauth2/v2/auth?state=s" },
					{ type: "done", marker: MARKER },
				]);
			if (url.endsWith("/models")) return Response.json([MODEL]);
			if (url.endsWith("/messages"))
				return sse([
					{ type: "start" },
					{ type: "text_start", contentIndex: 0 },
					{ type: "text_delta", contentIndex: 0, delta: "Hello" },
					{ type: "text_end", contentIndex: 0, content: "Hello" },
					{ type: "done", reason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
				]);
			if (url.endsWith("/logout")) return new Response("Signed out");
			return new Response("Not found", { status: 404 });
		}),
	);
	return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("Antigravity", () => {
	it("signs in through the FigPal command, then lists and asks the models of the account through its route", async () => {
		const requests = command();
		const credentials = new InMemoryCredentialStore();
		const models = createAgentModels(credentials, ORIGIN);
		const events: AuthEvent[] = [];
		await models.login(ANTIGRAVITY_ID, "oauth", { prompt: () => Promise.reject(new Error("No questions")), notify: (event) => events.push(event) });

		expect(events).toEqual([
			{ type: "progress", message: "Downloading Antigravity: 50%" },
			{ type: "auth_url", url: "https://accounts.google.com/o/oauth2/v2/auth?state=s" },
		]);
		expect(await credentials.read(ANTIGRAVITY_ID)).toMatchObject({ type: "oauth", access: MARKER });

		expect((await models.refresh()).errors.get(ANTIGRAVITY_ID)).toBeUndefined();
		const model = models.getModel(ANTIGRAVITY_ID, "gemini-3.8-flash")!;
		expect(model).toMatchObject({ api: "pi-messages", baseUrl: `${ORIGIN}/api/antigravity`, thinkingLevelMap: MODEL.thinkingLevelMap });
		expect(requests.find((request) => request.url.endsWith("/models"))?.headers.get("authorization")).toBe(`Bearer ${MARKER}`);

		const answer = await models
			.streamSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: 1 }] }, { sessionId: "thread-1", reasoning: "high" })
			.result();
		expect(answer.content).toEqual([{ type: "text", text: "Hello" }]);
		const request = requests.at(-1)!;
		expect([request.url, request.headers.get("authorization")]).toEqual([`${ORIGIN}/api/antigravity/messages`, `Bearer ${MARKER}`]);
		expect(request.body).toMatchObject({ model: "gemini-3.8-flash", options: { sessionId: "thread-1", reasoning: "high" } });
	});

	it("lists no models without a sign-in, and asks the command for none", async () => {
		const requests = command();
		const models = createAgentModels(new InMemoryCredentialStore(), ORIGIN);
		await models.refresh();
		expect(models.getModels(ANTIGRAVITY_ID)).toEqual([]);
		expect(requests).toEqual([]);
	});

	it("tells the error of the sign-in", async () => {
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => sse([{ type: "error", message: "Antigravity does not run on win32" }])));
		const models = createAgentModels(new InMemoryCredentialStore(), ORIGIN);
		const login = models.login(ANTIGRAVITY_ID, "oauth", { prompt: () => Promise.reject(new Error("No questions")), notify: () => {} });
		await expect(login).rejects.toThrow("Antigravity does not run on win32");
	});

	it("signs out: the command forgets the Google login, and FigPal the marker", async () => {
		const requests = command();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(ANTIGRAVITY_ID, async () => ({ type: "oauth", access: MARKER, refresh: MARKER, expires: Number.MAX_SAFE_INTEGER }));
		await signOutOfAntigravity(ORIGIN, credentials);
		expect(requests.map(({ url, method }) => [url, method])).toEqual([[`${ORIGIN}/api/antigravity/logout`, "POST"]]);
		expect(await credentials.read(ANTIGRAVITY_ID)).toBeUndefined();
	});
});
