// User report: with more than 20 images, Claude refuses a request with an image over 3,000 px, and the thread stops.
// An image that figma_execute attaches (for example an export at scale 2) goes to the model at most 2000 px wide.

import { type Context, text, toolResults, toolUse } from "../harness.ts";

export default async function largeImage(t: Context) {
	const session = await t.open({
		requests: {
			// A red PNG of 3000 × 40 px, made by Chrome.
			execute: async (_params, session) => {
				const bytes = await session.page.evaluate(async () => {
					const canvas = new OffscreenCanvas(3000, 40);
					const context = canvas.getContext("2d")!;
					context.fillStyle = "red";
					context.fillRect(0, 0, canvas.width, canvas.height);
					return [...new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer())];
				});
				return { result: { value: "1", truncated: false }, attachments: [{ name: "Hero.png", mime: "image/png", bytes: new Uint8Array(bytes) }] };
			},
		},
		model: (request) =>
			toolResults(request).length === 0 ? toolUse("t1", "figma_execute", { code: "return 1" }) : text("Done: I see the hero."),
	});
	await session.login();
	await session.ask("Check the hero", "Done: I see the hero.");
	const result = toolResults(session.model.at(-1)!)[0]!;
	// Text only (for example the note in place of an image that is too large) is a string.
	const blocks = Array.isArray(result.content) ? (result.content as { type: string; source: { media_type: string; data: string } }[]) : [];
	const image = blocks.find((block) => block.type === "image");
	const size =
		image &&
		(await session.page.evaluate(async ([type, data]) => {
			const element = new Image();
			element.src = `data:${type};base64,${data}`;
			await element.decode();
			return `${element.width} × ${element.height}`;
		}, [image.source.media_type, image.source.data] as const));
	t.check("the model gets a copy of 2000 × 27 px", size === "2000 × 27", image ? `${image.source.media_type} ${size}` : JSON.stringify(result.content));
}
