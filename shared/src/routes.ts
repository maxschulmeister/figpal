// Routes on the origin of the UI: the FigPal command (local/ui-server.ts) sends their requests to the servers below, and
// Vite's dev server does the same for the browser checks (web/vite.config.ts). These servers refuse browser requests
// (CORS), or need headers that a browser cannot set.

export const ROUTES = {
	// Anthropic refuses browser requests for subscription accounts (spike 0.3).
	anthropic: { path: "/api/anthropic", target: "https://api.anthropic.com" },
	// chatgpt.com allows CORS only from localhost origins (spike 0.4).
	chatgpt: { path: "/api/chatgpt", target: "https://chatgpt.com" },
	// skills.sh sends no CORS headers (spike 0.15).
	skills: { path: "/api/skills", target: "https://skills.sh/api" },
} as const;

/** `/api/forward/<host>/<path>` goes to `https://<host>/<path>`: for the providers that allow no browser requests. */
export const FORWARD_ROUTE = "/api/forward";

/** The browser replaces the user-agent that pi-ai and the Claude provider set. A route sets it again from this header. */
export const USER_AGENT_HEADER = "x-figpal-user-agent";

/** Headers that mark a browser request. The routes remove them, and all `sec-*` headers. */
export const BROWSER_HEADERS = ["origin", "referer", "anthropic-dangerous-direct-browser-access"];
