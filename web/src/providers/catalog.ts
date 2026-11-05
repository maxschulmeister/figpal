// The providers of pi-ai that FigPal offers with an API key (Settings → Models → Add a provider), FigPal's changes to
// their setup in a browser, and the fetch that sends their requests through the FigPal command.

import type { Api, ApiKeyAuth, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { FORWARD_ROUTE } from "@figpal/shared/routes";

/**
 * The providers whose own web search FigPal adds to each request (agent.ts, spike 0.8), and the tool of each. The
 * search tools of other providers differ, or cannot be used with function tools.
 */
export const SEARCH_TOOLS: Record<string, object> = {
	anthropic: { type: "web_search_20250305", name: "web_search", max_uses: 5 },
	"openai-codex": { type: "web_search" },
	openai: { type: "web_search" },
};

/** Claude (a token or an API key) and ChatGPT (sign-in) have their own cards. Bedrock's AWS SDK needs Node. */
const NOT_OFFERED = new Set(["anthropic", "openai-codex", "amazon-bedrock"]);

/** Adds questions to pi-ai's setup, or answers some of them, where a browser needs that. */
function inBrowser(provider: Provider): Provider {
	const auth = provider.auth.apiKey!;
	const login = auth.login!;
	const change = (next: ApiKeyAuth["login"]): Provider => ({ ...provider, auth: { ...provider.auth, apiKey: { ...auth, login: next } } });
	// pi-ai asks only for the key: in Node, the endpoint comes from the environment.
	if (provider.id === "azure")
		return change(async (interaction) => {
			const credential = await login(interaction);
			const endpoint = (await interaction.prompt({ type: "text", message: "Enter the Azure OpenAI endpoint URL or resource name" })).trim();
			const env: Record<string, string> = endpoint.includes("://") ? { AZURE_OPENAI_BASE_URL: endpoint } : { AZURE_OPENAI_RESOURCE_NAME: endpoint };
			return { ...credential, env: { ...credential.env, ...env } };
		});
	// A browser cannot read Application Default Credentials or a credentials file: only an API key works.
	if (provider.id === "google-vertex")
		return change((interaction) =>
			login({ ...interaction, prompt: (prompt) => (prompt.type === "select" ? Promise.resolve("api-key") : interaction.prompt(prompt)) }),
		);
	return provider;
}

/** The providers with an API key setup and chat models, in pi-ai's order. */
export function apiKeyProviders(): Provider[] {
	return builtinProviders()
		.filter((provider) => !NOT_OFFERED.has(provider.id) && provider.auth.apiKey?.login && provider.getModels().length > 0)
		.map(inBrowser);
}

/**
 * The providers whose adapters refuse a custom fetch (pi-ai's Google adapters), and the server of each model: their
 * requests go to the forward route through the base URL. Vertex with an API key uses Google's global endpoint.
 */
export const BASE_URL_ROUTES: Record<string, (model: Model<Api>) => string> = {
	google: (model) => model.baseUrl,
	"google-vertex": () => "https://aiplatform.googleapis.com",
};

/** The URL on the forward route of `origin` for an https URL of another host. Other URLs stay. */
export function forwardUrl(origin: string, url: string): string {
	const { protocol, host, pathname, search } = new URL(url);
	if (protocol !== "https:" || `${protocol}//${host}` === origin) return url;
	// No "/" at the end: pi-ai adds the paths to a base URL.
	return `${origin}${FORWARD_ROUTE}/${host}${pathname === "/" ? "" : pathname}${search}`;
}

/** A fetch that sends https requests to other hosts through the forward route of `origin`. */
export function forwardFetch(origin: string): typeof fetch {
	const forward = (url: string) => forwardUrl(origin, url);
	return (input, init) =>
		input instanceof Request ? fetch(new Request(forward(input.url), input), init) : fetch(forward(String(input)), init);
}
