// Anthropic refuses browser (CORS) requests for Claude subscription accounts: "CORS requests are not allowed for
// this Organization". So the page sends Claude requests to a route on its own origin. The route forwards them to
// api.anthropic.com without the browser headers: the dev server (web/vite.config.ts) and Caddy on the VPS
// (deploy/Caddyfile.figpal).

import type { Api, Model, Provider } from "@earendil-works/pi-ai";

export const ANTHROPIC_ROUTE = "/api/anthropic";

/** The browser replaces the user-agent that pi-ai and Pi Black set. The route sets it again from this header. */
export const USER_AGENT_HEADER = "x-figpal-user-agent";

/** Headers that mark a browser request. The route removes them, and all `sec-*` headers. */
export const BROWSER_HEADERS = ["origin", "referer", "anthropic-dangerous-direct-browser-access"];

/**
 * In a browser, the Anthropic SDK reports `browser:chrome` and an unknown OS. Upstream Pi Black runs in Node: these are
 * the values of its SDK on this Mac (macOS on Apple silicon, Node 26), checked on 2026-10-30.
 */
const NODE_PLATFORM_HEADERS = {
	"x-stainless-runtime": "node",
	"x-stainless-runtime-version": "v26.1.0",
	"x-stainless-os": "MacOS",
	"x-stainless-arch": "arm64",
};

/** Makes a request through the route look like a request from Node: the user-agent and the platform headers. */
export const fetchAsServer: typeof fetch = (input, init) => {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
	const userAgent = headers.get("user-agent");
	if (userAgent) headers.set(USER_AGENT_HEADER, userAgent);
	for (const [name, value] of Object.entries(NODE_PLATFORM_HEADERS)) if (headers.has(name)) headers.set(name, value);
	return fetch(input, { ...init, headers });
};

/**
 * Sends the requests of an Anthropic provider to the route at `baseUrl` with `fetchAsServer`. Wrap it around Pi Black:
 * Pi Black then wraps `fetchAsServer`.
 */
export function throughRoute(provider: Provider, baseUrl: string): Provider {
	return {
		...provider,
		stream: (model, context, options) =>
			provider.stream({ ...model, baseUrl } as Model<Api>, context, { ...options, fetch: fetchAsServer }),
		streamSimple: (model, context, options) =>
			provider.streamSimple({ ...model, baseUrl }, context, { ...options, fetch: fetchAsServer }),
	};
}
