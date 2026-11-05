import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startUiServer, type UiServer } from "./ui-server.ts";

const PORT = 9395;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server: UiServer | undefined;
const closers: (() => void)[] = [];

afterEach(async () => {
	await server?.close();
	server = undefined;
	for (const close of closers.splice(0)) close();
});

/** A built UI in a new folder. */
function ui() {
	const root = mkdtempSync(join(tmpdir(), "figpal-ui-"));
	mkdirSync(join(root, "assets"));
	writeFileSync(join(root, "index.html"), "<!doctype html><title>FigPal</title>");
	writeFileSync(join(root, "assets", "index-abc.js"), "console.log(1)");
	writeFileSync(join(mkdtempSync(join(tmpdir(), "figpal-outside-")), "secret.txt"), "secret");
	return root;
}

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

/** A request with headers that fetch cannot set (Host). */
function call(path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
	return new Promise<Reply>((resolve, reject) => {
		// No agent: each test has a new server on the same port, and a kept socket would go to the old one.
		const outgoing = request({ host: "127.0.0.1", port: PORT, path, method, agent: false, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, (response) => {
			let text = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => (text += chunk));
			response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: text }));
		});
		outgoing.on("error", reject);
		outgoing.end(body);
	});
}

/** A server in place of api.anthropic.com and the others: it keeps each request and answers in two parts. */
async function upstream() {
	const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
	const echo = createServer((incoming, response) => {
		let body = "";
		incoming.on("data", (chunk) => (body += chunk));
		incoming.on("end", () => {
			seen.push({ url: incoming.url!, headers: incoming.headers, body });
			response.writeHead(201, { "content-type": "text/event-stream", "x-upstream": "yes" });
			response.write("event: one\n\n");
			setTimeout(() => response.end("event: two\n\n"), 20);
		});
	});
	await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
	closers.push(() => echo.close());
	const { port } = echo.address() as { port: number };
	/** The targets of the routes, before the test sends them to this server. */
	const targets: string[] = [];
	const route = (target: URL) => {
		targets.push(target.href);
		return new URL(`${target.pathname}${target.search}`, `http://127.0.0.1:${port}`);
	};
	return { seen, targets, route };
}

describe("UI server", () => {
	it("serves the built UI: the page revalidates, a build's files stay in the cache, and only Figma can frame them", async () => {
		server = await startUiServer({ root: ui(), port: PORT, origin: ORIGIN, version: "1.2.3" });
		const page = await call("/");
		expect(page).toMatchObject({ status: 200, body: "<!doctype html><title>FigPal</title>" });
		expect(page.headers).toMatchObject({
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-cache",
			"content-security-policy": "frame-ancestors https://www.figma.com; img-src 'self' data:",
		});
		const script = await call("/assets/index-abc.js");
		expect(script).toMatchObject({ status: 200, body: "console.log(1)" });
		expect(script.headers).toMatchObject({ "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" });
		// A file of a deleted build: not the page, which the browser would run as a script.
		expect((await call("/assets/index-old.js")).status).toBe(404);
	});

	it("refuses other host names (DNS rebinding) and paths out of the UI folder", async () => {
		server = await startUiServer({ root: ui(), port: PORT, origin: ORIGIN, version: "1.2.3" });
		expect((await call("/", { headers: { host: "evil.example:9395" } })).status).toBe(403);
		expect((await call("/", { headers: { host: `localhost:${PORT}` } })).status).toBe(200);
		expect((await call("/../figpal-outside/secret.txt")).status).toBe(404);
		expect((await call("/%2e%2e/secret.txt")).status).toBe(404);
	});

	it("answers /health, so that the plugin and the install know that FigPal runs, and its version", async () => {
		server = await startUiServer({ root: ui(), port: PORT, origin: ORIGIN, version: "1.2.3" });
		// The plugin asks from its first page, which has no origin.
		const health = await call("/health", { headers: { origin: "null", "sec-fetch-site": "cross-site" } });
		expect(health.status).toBe(200);
		expect(JSON.parse(health.body)).toEqual({ app: "figpal", version: "1.2.3" });
	});

	it("sends a route upstream without the browser headers, with the user-agent that the page wanted, and streams the answer", async () => {
		const { seen, targets, route } = await upstream();
		server = await startUiServer({ root: ui(), port: PORT, origin: ORIGIN, version: "1.2.3", route });
		const reply = await call("/api/anthropic/v1/messages?beta=true", {
			method: "POST",
			body: '{"model":"claude"}',
			headers: {
				origin: ORIGIN,
				referer: `${ORIGIN}/`,
				"sec-fetch-site": "same-origin",
				"sec-ch-ua": "Chrome",
				"anthropic-dangerous-direct-browser-access": "true",
				"user-agent": "Mozilla/5.0",
				"x-figpal-user-agent": "claude-cli/2.1.280",
				authorization: "Bearer sk-ant-oat01-x",
				"content-type": "application/json",
			},
		});
		expect(targets).toEqual(["https://api.anthropic.com/v1/messages?beta=true"]);
		expect(reply).toMatchObject({ status: 201, body: "event: one\n\nevent: two\n\n" });
		expect(reply.headers["x-upstream"]).toBe("yes");
		const sent = seen[0]!;
		expect(sent.body).toBe('{"model":"claude"}');
		expect(sent.headers).toMatchObject({ host: "api.anthropic.com", "user-agent": "claude-cli/2.1.280", authorization: "Bearer sk-ant-oat01-x" });
		for (const name of ["origin", "referer", "sec-fetch-site", "sec-ch-ua", "anthropic-dangerous-direct-browser-access", "x-figpal-user-agent"])
			expect(sent.headers[name], name).toBeUndefined();
	});

	it("maps the routes of ChatGPT, skills.sh and other providers to their servers", async () => {
		const { targets, route } = await upstream();
		server = await startUiServer({ root: ui(), port: PORT, origin: ORIGIN, version: "1.2.3", route });
		const same = { "sec-fetch-site": "same-origin" };
		await call("/api/chatgpt/backend-api/codex/responses", { method: "POST", headers: { ...same, origin: ORIGIN } });
		await call("/api/skills/search?q=figma", { headers: same });
		await call("/api/forward/api.mistral.ai/v1/chat/completions", { method: "POST", headers: { ...same, origin: ORIGIN } });
		expect(targets).toEqual([
			"https://chatgpt.com/backend-api/codex/responses",
			"https://skills.sh/api/search?q=figma",
			"https://api.mistral.ai/v1/chat/completions",
		]);
	});

	it("refuses route requests of other web pages", async () => {
		const { seen, route } = await upstream();
		server = await startUiServer({ root: ui(), port: PORT, origin: ORIGIN, version: "1.2.3", route });
		expect((await call("/api/skills/search?q=x", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
		expect((await call("/api/anthropic/v1/messages", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
		expect((await call("/api/forward/", { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(404);
		expect(seen).toEqual([]);
	});
});
