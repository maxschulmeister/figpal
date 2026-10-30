import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";

const SPIKE_RESULTS = fileURLToPath(new URL("../docs/spike-results.local.json", import.meta.url));

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
				let body = "";
				req.on("data", (chunk) => {
					body += chunk;
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
		},
	},
});
