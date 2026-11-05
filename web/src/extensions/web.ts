// The `web` extension. Web search is the provider's own tool: agent.ts adds it to each request of the providers in
// SEARCH_TOOLS. This section tells the model to give its sources, and how to put an image from the web on the canvas.
// Other models cannot search: the section says so, so that they do not make up results.

import { defineExtension, section } from "@earendil-works/pi-durable";
import { SEARCH_TOOLS } from "../providers/catalog";

const IMAGES =
	"For an image on the canvas, find a direct PNG, JPEG or GIF URL: WebP and AVIF fail, but many image hosts give a JPEG with a format parameter, for example ?fm=jpg. Prefer images whose license lets the user use them, and name the creator and license, unless the image is CC0 or public domain.";

export function webExtension() {
	return defineExtension({
		name: "web",
		sections: [
			section("web", ({ agent }) =>
				agent.model && SEARCH_TOOLS[agent.model.provider]
					? `You can search the web with web_search. After a search, end your answer with the sources as Markdown links. ${IMAGES}`
					: `You cannot search the web. ${IMAGES.replace("find a direct", "use a direct")} The user can give you URLs.`,
			),
		],
	});
}
