import { BROWSER_HEADERS, ROUTES, USER_AGENT_HEADER } from "@figpal/shared/routes";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

/** As the FigPal command (local/ui-server.ts): no browser headers upstream, and the user-agent that the page wanted. */
const asServerRequest: ProxyOptions["configure"] = (proxy) => {
	proxy.on("proxyReq", (req) => {
		const userAgent = req.getHeader(USER_AGENT_HEADER);
		if (typeof userAgent === "string") req.setHeader("user-agent", userAgent);
		for (const name of req.getHeaderNames())
			if (name === USER_AGENT_HEADER || BROWSER_HEADERS.includes(name) || name.startsWith("sec-")) req.removeHeader(name);
	});
};

// The routes of the FigPal command, for the browser checks (e2e/), which run FigPal's UI on this server.
const proxy = Object.fromEntries(
	Object.values(ROUTES).map(({ path, target }): [string, ProxyOptions] => {
		const { origin, pathname } = new URL(target);
		const prefix = pathname === "/" ? "" : pathname;
		return [path, { target: origin, changeOrigin: true, rewrite: (url) => `${prefix}${url.slice(path.length)}`, configure: asServerRequest }];
	}),
);

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: { port: 5173, strictPort: true, proxy },
});
