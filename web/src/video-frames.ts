// Still frames of a video, for the model: it cannot see an animation. The browser's own video player decodes it, so
// no library, and an exact seek gives the frame at each time.

import { MODEL_IMAGE_MAX_PX } from "@figpal/shared";

export type VideoFrames = { duration: number; width: number; height: number; frames: { time: number; data: string; mime: string }[] };

/** The frames when the model gives no times: start, end and 3 between. */
export const DEFAULT_FRAMES = 5;

/** WebP keeps transparency and is 4 to 7 times smaller than PNG. A browser that cannot make WebP gives a PNG. */
const FRAME_TYPE = "image/webp";
const FRAME_QUALITY = 0.85;

/** Waits for a video event. Rejects when the browser cannot play the video. */
function event(video: HTMLVideoElement, name: "loadeddata" | "seeked"): Promise<void> {
	return new Promise((resolve, reject) => {
		const done = () => {
			video.removeEventListener("error", failed);
			resolve();
		};
		const failed = () => {
			video.removeEventListener(name, done);
			reject(new Error(`This browser cannot play the video: ${video.error?.message || "unknown error"}.`));
		};
		video.addEventListener(name, done, { once: true });
		video.addEventListener("error", failed, { once: true });
	});
}

/** Seeks to the time and waits for its frame. `currentTime` seeks exactly, `fastSeek` can go to a keyframe. */
async function seek(video: HTMLVideoElement, time: number): Promise<void> {
	const seeked = event(video, "seeked");
	video.currentTime = time;
	await seeked;
}

/**
 * The frames at the times, as base64 images, with the longest side at most MODEL_IMAGE_MAX_PX. Times after the end
 * show the last frame. Without times: frames from start to end.
 */
export async function videoFrames(bytes: Uint8Array, mime: string, times?: number[]): Promise<VideoFrames> {
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
	const video = document.createElement("video");
	video.muted = true;
	video.preload = "auto";
	try {
		const loaded = event(video, "loadeddata");
		video.src = url;
		await loaded;
		// Some encoders write no duration in a WebM. A seek to the end makes the browser read it.
		if (!Number.isFinite(video.duration)) await seek(video, Number.MAX_SAFE_INTEGER);
		const { duration } = video;
		if (!Number.isFinite(duration)) throw new Error("This browser cannot read the length of the video.");
		const wanted = times ?? Array.from({ length: DEFAULT_FRAMES }, (_, index) => (duration * index) / (DEFAULT_FRAMES - 1));
		const canvas = document.createElement("canvas");
		const scale = Math.min(1, MODEL_IMAGE_MAX_PX / Math.max(video.videoWidth, video.videoHeight));
		canvas.width = Math.round(video.videoWidth * scale);
		canvas.height = Math.round(video.videoHeight * scale);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("This browser cannot draw the frames.");
		const frames: VideoFrames["frames"] = [];
		for (const time of wanted) {
			// A seek to the end shows the last frame. Without a duration in the file, the browser gives the start of the last
			// frame as the duration.
			const at = Math.min(time, duration);
			await seek(video, at);
			// A transparent frame does not cover the frame before it.
			context.clearRect(0, 0, canvas.width, canvas.height);
			context.drawImage(video, 0, 0, canvas.width, canvas.height);
			const [header, data] = canvas.toDataURL(FRAME_TYPE, FRAME_QUALITY).split(",");
			frames.push({ time: at, data: data!, mime: header!.slice("data:".length, header!.indexOf(";")) });
		}
		return { duration, width: canvas.width, height: canvas.height, frames };
	} finally {
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(url);
	}
}
