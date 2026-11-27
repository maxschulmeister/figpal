// Images for the models. Some models refuse images over MODEL_IMAGE_MAX_PX, and Claude refuses a request with more
// than 20 images if one of them is over 3,000 px.

import { MODEL_IMAGE_MAX_PX } from "@figpal/shared";

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
/** The JPEG markers of a frame header, which has the size: SOF0 to SOF15 without DHT (C4), JPG (C8) and DAC (CC). */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** The size in the header of a PNG, a JPEG or a GIF. Undefined for other data, for example WebP. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length >= 24 && PNG.every((byte, i) => bytes[i] === byte))
		return { width: view.getUint32(16), height: view.getUint32(20) };
	if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === "GIF")
		return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
	// JPEG: the segments after the start marker, each with its length, until a frame header.
	for (let at = 2; at + 9 <= bytes.length && bytes[at] === 0xff; at += 2 + view.getUint16(at + 2)) {
		if (JPEG_FRAMES.has(bytes[at + 1]!)) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
	}
	return undefined;
}

/** The size of an image over MODEL_IMAGE_MAX_PX. Undefined for a smaller image, and for an image of unknown size. */
export function oversize(bytes: Uint8Array): { width: number; height: number } | undefined {
	const size = imageSize(bytes);
	return size && Math.max(size.width, size.height) > MODEL_IMAGE_MAX_PX ? size : undefined;
}

/** The image, or a WebP copy with the longest side at MODEL_IMAGE_MAX_PX if it is larger. Needs a browser. */
export async function shrinkImage(image: Blob): Promise<Blob> {
	const bitmap = await createImageBitmap(image);
	const scale = MODEL_IMAGE_MAX_PX / Math.max(bitmap.width, bitmap.height);
	if (scale >= 1) {
		bitmap.close();
		return image;
	}
	const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
	canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	// WebP keeps transparency and stays small; all of FigPal's models read it.
	return canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
}
