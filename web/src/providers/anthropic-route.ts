// Anthropic refuses browser (CORS) requests for Claude subscription accounts: "CORS requests are not allowed for
// this Organization". So the page sends Claude requests to a route on its own origin. The route forwards them to
// api.anthropic.com without the browser headers: the FigPal command (local/ui-server.ts) and the dev server
// (web/vite.config.ts).

import { ROUTES, USER_AGENT_HEADER } from "@figpal/shared/routes";

export const ANTHROPIC_ROUTE = ROUTES.anthropic.path;

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
