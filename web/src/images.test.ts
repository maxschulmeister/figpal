import { describe, expect, it } from "vitest";
import { imageSize } from "./images";

/** The first bytes of a PNG: the signature and the IHDR chunk with the size. */
function png(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
}

/** A JPEG with an APP0 segment before the SOF0 segment, which has the size. */
function jpeg(width: number, height: number): Uint8Array {
	return new Uint8Array([
		0xff, 0xd8,
		0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46,
		0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
	]);
}

/** The header of a GIF: the size is little-endian. */
function gif(width: number, height: number): Uint8Array {
	return new Uint8Array([71, 73, 70, 56, 57, 97, width & 0xff, width >> 8, height & 0xff, height >> 8]);
}

describe("imageSize", () => {
	it("reads the size of a PNG, a JPEG and a GIF from its header", () => {
		expect(imageSize(png(4000, 120))).toEqual({ width: 4000, height: 120 });
		expect(imageSize(jpeg(3200, 2400))).toEqual({ width: 3200, height: 2400 });
		expect(imageSize(gif(640, 480))).toEqual({ width: 640, height: 480 });
	});

	it("does not know the size of other data", () => {
		expect(imageSize(new Uint8Array([137, 80, 78, 71]))).toBeUndefined();
		expect(imageSize(new TextEncoder().encode("<svg/>"))).toBeUndefined();
		expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeUndefined();
	});
});
