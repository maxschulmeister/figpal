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
					"You can search the web with web_search. After a search, end your answer with the sources as Markdown links. For an image on the canvas, find a direct URL of a PNG, JPEG or GIF with web_search and load it with figma.createImageAsync. A WebP or AVIF URL fails: many image hosts give a JPEG with a format parameter, for example ?fm=jpg. Prefer images that their license lets the user use, and name the creator and license in your answer when the image is not CC0 or public domain.",
			),
		],
	});
}
