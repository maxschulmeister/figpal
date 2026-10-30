import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import { ANTHROPIC_ROUTE, BROWSER_HEADERS, USER_AGENT_HEADER } from "./src/providers/anthropic-route.ts";

const SPIKE_RESULTS = fileURLToPath(new URL("../docs/spike-results.local.json", import.meta.url));
const MAX_RESULTS_BYTES = 1_000_000;

/** Dev only: the spike page posts its results here, so they do not have to be copied by hand. */
function spikeResults(): Plugin {
	return {
		name: "figpal-spike-results",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use("/__spike/results", (req, res) => {
				if (req.method !== "POST") {
					res.statusCode = 405;
					res.end();
					return;
				}
				// Other websites can send a simple POST to localhost. Only the spike page may write the file.
				if (req.headers["sec-fetch-site"] !== "same-origin") {
					res.statusCode = 403;
					res.end();
					return;
				}
				let body = "";
				req.on("data", (chunk) => {
					body += chunk;
					if (body.length > MAX_RESULTS_BYTES) req.destroy();
				});
				req.on("end", () => {
					writeFile(SPIKE_RESULTS, body).then(
						() => {
							res.statusCode = 204;
							res.end();
						},
						(error: Error) => {
							res.statusCode = 500;
							res.end(error.message);
						},
					);
				});
			});
		},
	};
}

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
	plugins: [spikeResults()],
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
