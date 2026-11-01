// figma_animation_frames with real WebMs: Chrome decodes them, and each frame must be the frame at its time.
// The test videos (made with ffmpeg) have a new color every 0.5 s.

import { readFileSync } from "node:fs";
import { type Context, type Session, type ToolResult, text, toolResults, toolUse } from "../harness.ts";

const VIDEOS = ["anim", "anim-live", "end-live", "alpha", "tall"] as const;
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}.webm`, import.meta.url));

/** The color at a point of each frame, and the frame size. */
function colors(session: Session, result: ToolResult, x = 0.5): Promise<string[]> {
	const images = (result.content as { type: string; source: { media_type: string; data: string } }[])
		.filter((block) => block.type === "image")
		.map((block) => [block.source.media_type, block.source.data]);
	return session.page.evaluate(
		([images, x]) =>
			Promise.all(
				(images as string[][]).map(async ([type, data]) => {
					const image = new Image();
					image.src = `data:${type};base64,${data}`;
					await image.decode();
					const canvas = document.createElement("canvas");
					canvas.width = image.width;
					canvas.height = image.height;
					const context = canvas.getContext("2d")!;
					context.drawImage(image, 0, 0);
					const [r, g, b, a] = context.getImageData(Math.floor(image.width * (x as number)), image.height / 2, 1, 1).data;
					const name =
						a! < 30
							? "clear"
							: r! > 200 && g! > 200 && b! > 200
								? "white"
								: r! > 200 && g! > 200 && b! < 80
									? "yellow"
									: r! > 200 && g! < 80
										? "red"
										: g! > 200 && r! < 80
											? "lime"
											: b! > 200 && r! < 80
												? "blue"
												: `rgb(${r},${g},${b},${a})`;
					return `${name} ${image.width}x${image.height}`;
				}),
			),
		[images, x] as const,
	);
}
const texts = (result: ToolResult) => (result.content as { type: string; text: string }[]).filter((block) => block.type === "text").map((block) => block.text);

export default async function animation(t: Context) {
	let exports = 0;
	const session = await t.open({
		requests: {
			// Two calls for each video: with times, and without.
			export: () => ({ result: { count: 1 }, attachments: [{ name: "Hero.webm", mime: "video/webm", bytes: fixture(VIDEOS[Math.floor(exports++ / 2)]!) }] }),
		},
		model: (request) => {
			const done = toolResults(request).length;
			if (done === VIDEOS.length * 2) return text("Done: the animation works.");
			return done % 2 === 0
				? toolUse(`t${done}`, "figma_animation_frames", { node_id: "1-2", times: [0.25, 0.75, 1.25, 1.75, 5] })
				: toolUse(`t${done}`, "figma_animation_frames", { node_id: "1:2" });
		},
	});
	await session.login();
	await session.ask("Check the animation", "Done: the animation works.");
	t.check("the tool is offered", (session.model[0]!.tools ?? []).some((tool) => tool.name === "figma_animation_frames"));
	const first = session.requests.find((request) => request.type === "export");
	t.check(
		"it asks code.js for a small WebM",
		JSON.stringify(first?.params) === JSON.stringify({ nodeIds: ["1:2"], format: "WEBM", width: 480, fps: 24, quality: "LOW" }),
		JSON.stringify(first?.params),
	);
	const results = toolResults(session.model.at(-1)!);
	const of = (video: (typeof VIDEOS)[number]) => {
		const index = VIDEOS.indexOf(video) * 2;
		return { times: results[index]!, defaults: results[index + 1]! };
	};
	const types = results.flatMap((result) => (result.content as { type: string; source?: { media_type: string } }[]).filter((block) => block.type === "image").map((block) => block.source!.media_type));
	t.check("the frames are WebP", types.length === VIDEOS.length * 10 && types.every((type) => type === "image/webp"), JSON.stringify([...new Set(types)]));
	for (const [video, length, defaultTimes, defaultColors] of [
		["anim", "2 s", ["0 s", "0.5 s", "1 s", "1.5 s", "2 s"], ["red", "lime", "blue", "yellow", "yellow"]],
		// Without a duration in the file, Chrome gives the start of the last frame.
		["anim-live", "1.96 s", ["0 s", "0.49 s", "0.98 s", "1.47 s", "1.96 s"], ["red", "red", "lime", "blue", "yellow"]],
	] as const) {
		const { times, defaults } = of(video);
		t.check(
			`${video}: the model gets the length, the size and the times`,
			JSON.stringify(texts(times)) ===
				JSON.stringify([`The animation of the top-level frame of 1:2 is ${length} long. Frames of 480 × 270 px:`, "0.25 s", "0.75 s", "1.25 s", "1.75 s", length]),
			JSON.stringify(texts(times)),
		);
		const shown = await colors(session, times);
		t.check(
			`${video}: each frame is the frame at its time; after the end, the last frame`,
			JSON.stringify(shown) === JSON.stringify(["red 480x270", "lime 480x270", "blue 480x270", "yellow 480x270", "yellow 480x270"]),
			JSON.stringify(shown),
		);
		const frames = await colors(session, defaults);
		t.check(
			`${video}: without times, 5 frames from start to end`,
			JSON.stringify(texts(defaults).slice(1)) === JSON.stringify(defaultTimes) && JSON.stringify(frames) === JSON.stringify(defaultColors.map((color) => `${color} 480x270`)),
			JSON.stringify([texts(defaults).slice(1), frames]),
		);
	}
	const end = of("end-live");
	const ends = [(await colors(session, end.times)).at(-1), (await colors(session, end.defaults)).at(-1)];
	t.check("a time after the end and the default end show the real last frame", ends.every((color) => color === "white 480x270"), JSON.stringify(ends));
	// A box moves from the left (x 20-80 px at 0.1 s) to the right, on a transparent background.
	const alpha = of("alpha");
	const start = (await colors(session, alpha.defaults, 0.1))[0]!;
	const later = (await colors(session, alpha.times, 0.1)).slice(2);
	t.check("a transparent frame does not show the frame before it", !start.startsWith("clear") && later.every((color) => color === "clear 480x270"), JSON.stringify([start, later]));
	const tall = of("tall");
	const shown = await colors(session, tall.times);
	t.check(
		"the longest side is at most 2000 px",
		shown.every((color) => color === "blue 308x2000") && texts(tall.times)[0]!.endsWith("Frames of 308 × 2000 px:"),
		JSON.stringify([shown[0], texts(tall.times)[0]]),
	);
	t.check("the step is called Check animation", (await session.body()).includes("Check animation"));
	await t.screenshot(session, "animation");
}
