// Attachments of a message (user request): images go to the model as images, text files as text. The user adds them
// with the "+" button, by paste or by drop. assistant-ui's adapters do the work; FigPal adds its limits.

import {
	type AttachmentAdapter,
	CompositeAttachmentAdapter,
	type PendingAttachment,
	SimpleImageAttachmentAdapter,
	SimpleTextAttachmentAdapter,
} from "@assistant-ui/react";
import { MODEL_IMAGES } from "@figpal/shared";
import { shrinkImage } from "./images";

/** Pasted text from this size on becomes an attachment, not text in the message (the agent chose the numbers). */
export const isLongText = (text: string) => text.length >= 2000 || text.split("\n").length >= 30;

/** Text files by type or by name: code, data and documents that are plain text. */
const TEXT_TYPES = ["text/*", "application/json"];
const TEXT_EXTENSIONS = [".md", ".markdown", ".txt", ".json", ".csv", ".svg", ".xml", ".yaml", ".yml", ".css", ".html", ".js", ".jsx", ".ts", ".tsx"];
/** A text file of this size is about 125,000 tokens: more does not fit in a useful message. */
const MAX_TEXT_BYTES = 500_000;

/** For the file chooser: FigPal checks each file again with `attachable`. */
export const ACCEPT = [...MODEL_IMAGES, ...TEXT_TYPES, ...TEXT_EXTENSIONS].join(",");

/** The kind of a file that FigPal can send, or a message that says why not. */
export function attachable(file: File): string | undefined {
	if (MODEL_IMAGES.has(file.type)) return undefined;
	const name = file.name.toLowerCase();
	const text = file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
	if (!text) return `FigPal cannot send "${file.name}": only images (PNG, JPEG, GIF, WebP) and text files.`;
	if (file.size > MAX_TEXT_BYTES) return `"${file.name}" is larger than 500 KB.`;
	return undefined;
}

class Images extends SimpleImageAttachmentAdapter {
	override accept = [...MODEL_IMAGES].join(",");
	constructor(private readonly canReadImages: () => boolean) {
		super();
	}
	override async add(state: { file: File }): Promise<PendingAttachment> {
		if (!this.canReadImages()) throw new Error("This model cannot read images. Pick another model, or remove the image.");
		return super.add(state);
	}
	/** A large image gets smaller, as for screenshots: some models refuse images over 2000 px. */
	override async send(attachment: PendingAttachment, options?: { signal?: AbortSignal }) {
		const image = await shrinkImage(attachment.file);
		if (image === attachment.file) return super.send(attachment, options);
		return super.send({ ...attachment, file: new File([image], attachment.name, { type: image.type }) }, options);
	}
}

class TextFiles extends SimpleTextAttachmentAdapter {
	override accept = [...TEXT_TYPES, ...TEXT_EXTENSIONS].join(",");
}

/** The adapter of the composer. `canReadImages`: the model of the chat reads images. */
export const attachmentAdapter = (canReadImages: () => boolean): AttachmentAdapter =>
	new CompositeAttachmentAdapter([new Images(canReadImages), new TextFiles()]);
