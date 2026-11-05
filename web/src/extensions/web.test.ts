import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { expect, it } from "vitest";
import { webExtension } from "./web";

const render = (provider: string) =>
	webExtension().sections![0]!.render({ agent: { model: { provider, modelId: "m" } } } as never, context) as string;

// FigPal adds the provider's own search only for Claude, ChatGPT and OpenAI (agent.ts). Without it, a model that reads
// "You can search the web" would make up results.
it("tells the model about web search only when its provider has FigPal's search", () => {
	expect(render("anthropic")).toContain("You can search the web with web_search.");
	expect(render("openai")).toContain("You can search the web with web_search.");
	const other = render("mistral");
	expect(other).not.toContain("web_search");
	expect(other).toContain("You cannot search the web.");
	// The images still work with a URL from the user.
	expect(other).toContain("direct PNG, JPEG or GIF URL");
});
