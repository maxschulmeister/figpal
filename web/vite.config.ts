import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
import { ANTHROPIC_ROUTE, BROWSER_HEADERS, USER_AGENT_HEADER } from "./src/providers/anthropic-route.ts";

/** Like `header_up -Origin` in Caddy: the upstream must not see a browser origin. */
const dropOrigin: ProxyOptions["configure"] = (proxy) => {
	proxy.on("proxyReq", (req) => req.removeHeader("origin"));
};

/** Anthropic must see a server request: no browser headers, and the Claude Code user-agent that the page wanted. */
const asServerRequest: ProxyOptions["configure"] = (proxy) => {
	proxy.on("proxyReq", (req) => {
		const userAgent = req.getHeader(USER_AGENT_HEADER);
		if (typeof userAgent === "string") req.setHeader("user-agent", userAgent);
		for (const name of req.getHeaderNames())
			if (name === USER_AGENT_HEADER || BROWSER_HEADERS.includes(name) || name.startsWith("sec-")) req.removeHeader(name);
	});
};

// The same routes as the Caddy block in deploy/Caddyfile.figpal.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/api/skills": {
				target: "https://skills.sh",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/skills/, "/api"),
				configure: dropOrigin,
			},
			"/api/chatgpt": {
				target: "https://chatgpt.com",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/chatgpt/, ""),
				configure: dropOrigin,
			},
			[ANTHROPIC_ROUTE]: {
				target: "https://api.anthropic.com",
				changeOrigin: true,
				rewrite: (path) => path.slice(ANTHROPIC_ROUTE.length),
				configure: asServerRequest,
			},
		},
	},
});
