// The HTTP server of the FigPal command: FigPal's UI, which the plugin window loads, and the routes that the UI needs on
// its own origin (shared/src/routes.ts). It listens on 127.0.0.1 only (the UI's origin is http://localhost:9310), on a
// fixed port: Figma Desktop keeps FigPal's chats and keys for this origin. Only the UI can use the routes: a web page cannot fake its origin, and the host name
// must be this machine (against DNS rebinding).

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { BROWSER_HEADERS, FORWARD_ROUTE, ROUTES, USER_AGENT_HEADER } from "@figpal/shared/routes";
import { CLAUDE_CONFIG_ROUTE } from "@figpal/shared/claude";
import { discoverClaude, serveClaudeConfig } from "./claude.ts";

export type UiServer = { port: number; close(): Promise<void> };

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".license": "text/plain; charset=utf-8",
};

/** Only Figma can show the UI in a frame (spike 0.12), and no image loads from a URL in model output (Phase 5). */
const PAGE_HEADERS = { "content-security-policy": "frame-ancestors https://www.figma.com; img-src 'self' data:", "x-content-type-options": "nosniff" };

/** Headers of the connection, of the browser, and of FigPal: not upstream. Also all `sec-*` headers. */
const NOT_UPSTREAM = new Set([...BROWSER_HEADERS, USER_AGENT_HEADER, "host", "cookie", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);
const NOT_DOWNSTREAM = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "trailer"]);

/** The server of a route path, or undefined. */
function target(path: string, search: string): URL | undefined {
	for (const route of Object.values(ROUTES))
		if (path.startsWith(`${route.path}/`)) return new URL(`${route.target}${path.slice(route.path.length)}${search}`);
	if (!path.startsWith(`${FORWARD_ROUTE}/`)) return undefined;
	const [host, ...rest] = path.slice(FORWARD_ROUTE.length + 1).split("/");
	return host ? new URL(`https://${host}/${rest.join("/")}${search}`) : undefined;
}

export async function startUiServer(options: {
	/** The folder of the built UI. */
	root: string;
	port: number;
	/** The origin of the UI: the only page that can use the routes. */
	origin: string;
	version: string;
	/** Tests: where a route request goes, in place of its server. */
	route?: (target: URL) => URL;
}): Promise<UiServer> {
	const claude = await discoverClaude();
	const root = resolve(options.root);
	const hosts = [`127.0.0.1:${options.port}`, `localhost:${options.port}`];
	const end = (response: ServerResponse, status: number, text: string) => response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);

	/** A route request from another page: it has another origin, or the browser says that it comes from another site. */
	const fromUi = (incoming: IncomingMessage) => {
		const { origin, "sec-fetch-site": site } = incoming.headers;
		return (origin === undefined || origin === options.origin) && (site === undefined || site === "same-origin");
	};

	const proxy = (incoming: IncomingMessage, response: ServerResponse, url: URL) => {
		const headers: Record<string, string | string[]> = { host: url.host };
		for (const [name, value] of Object.entries(incoming.headers))
			if (value !== undefined && !NOT_UPSTREAM.has(name) && !name.startsWith("sec-")) headers[name] = value;
		const userAgent = incoming.headers[USER_AGENT_HEADER];
		if (typeof userAgent === "string") headers["user-agent"] = userAgent;
		const to = options.route?.(url) ?? url;
		const outgoing = (to.protocol === "https:" ? httpsRequest : httpRequest)(to, { method: incoming.method, headers }, (answer) => {
			const copied = Object.entries(answer.headers).filter(([name, value]) => value !== undefined && !NOT_DOWNSTREAM.has(name));
			response.writeHead(answer.statusCode ?? 502, Object.fromEntries(copied) as Record<string, string | string[]>);
			// An answer that breaks off ends the response. An error without a handler would stop the process.
			pipeline(answer, response, () => {});
		});
		outgoing.on("error", (error) => (response.headersSent ? response.destroy() : end(response, 502, `FigPal could not reach ${url.host}: ${error.message}`)));
		// The user stopped the answer: stop the request upstream too.
		response.on("close", () => outgoing.destroy());
		incoming.on("error", () => outgoing.destroy());
		incoming.pipe(outgoing);
	};

	const serveFile = async (response: ServerResponse, pathname: string) => {
		let path: string;
		try {
			path = decodeURIComponent(pathname);
		} catch {
			return end(response, 404, "Not found");
		}
		const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
		const found = file.startsWith(`${root}${sep}`) && (await stat(file).then((info) => info.isFile(), () => false));
		// A file of a deleted build gets 404, not the page: the browser would run the page as a script.
		if (!found) return end(response, 404, "Not found");
		response.writeHead(200, {
			...PAGE_HEADERS,
			"content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
			// Each build has new file names under /assets. Everything else must revalidate.
			"cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
		});
		createReadStream(file).pipe(response);
	};

	const server = createServer((incoming, response) => {
		if (!hosts.includes(incoming.headers.host ?? "")) return end(response, 403, "Forbidden");
		const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
		if (url.pathname === "/health")
			return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ app: "figpal", version: options.version }));
		if (url.pathname.startsWith("/api/")) {
			if (!fromUi(incoming)) return end(response, 403, "Forbidden");
			if (url.pathname === CLAUDE_CONFIG_ROUTE) return serveClaudeConfig(incoming, response, claude);
			const to = target(url.pathname, url.search);
			return to ? proxy(incoming, response, to) : end(response, 404, "Not found");
		}
		if (incoming.method !== "GET" && incoming.method !== "HEAD") return end(response, 405, "Method not allowed");
		void serveFile(response, url.pathname);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", resolve);
	});
	return {
		port: options.port,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
