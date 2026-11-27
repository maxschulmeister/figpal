// The `images` extension: before each request, it removes images over MODEL_IMAGE_MAX_PX from the context. FigPal makes
// new images smaller, but a thread from an older FigPal can have larger ones, and Claude then refuses each request.

import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { MODEL_IMAGE_MAX_PX } from "@figpal/shared";
import { oversize } from "../images";

/** Enough of the image for its header: this runs for each image at each request. A multiple of 4 characters. */
const HEADER_BASE64 = 256 * 1024;
const headerOf = (base64: string) => Uint8Array.from(atob(base64.slice(0, HEADER_BASE64)), (character) => character.charCodeAt(0));

/** A note in place of an image that is too large, else the image. An image of unknown size stays. */
function fit(part: TextContent | ImageContent): TextContent | ImageContent {
	if (part.type !== "image") return part;
	const size = oversize(headerOf(part.data));
	if (!size) return part;
	const text = `[FigPal removed an image of ${size.width} × ${size.height} px here: it is larger than ${MODEL_IMAGE_MAX_PX} px. If you need it, make a smaller image.]`;
	return { type: "text", text };
}

/** The messages, with a note in place of each image that is too large. */
function withoutLargeImages(messages: readonly Message[]): Message[] {
	return messages.map((message) => {
		if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") return message;
		return { ...message, content: message.content.map(fit) } as Message;
	});
}

export function imagesExtension() {
	return defineExtension({
		name: "images",
		hooks: [hook(GenerationTask, { beforeRequest: ({ messages }) => ({ messages: withoutLargeImages(messages) }) })],
	});
}
