// The `web` extension. Web search is the provider's own tool: agent.ts adds it to each request. This section tells the
// model to give its sources, and how to put an image from the web on the canvas.

import { defineExtension, section } from "@earendil-works/pi-durable";

export function webExtension() {
	return defineExtension({
		name: "web",
		sections: [
			section(
				"web",
				() =>
					"You can search the web with web_search. After a search, end your answer with the sources as Markdown links. For an image on the canvas, find a direct PNG, JPEG or GIF URL: WebP and AVIF fail, but many image hosts give a JPEG with a format parameter, for example ?fm=jpg. Prefer images whose license lets the user use them, and name the creator and license, unless the image is CC0 or public domain.",
			),
		],
	});
}
