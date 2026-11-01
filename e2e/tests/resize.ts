// The grip in the corner of the panel: code.js resizes the panel, here the fake page resizes the iframe.

import type { Context } from "../harness.ts";

export default async function resize(t: Context) {
	const session = await t.open({
		requests: {
			resize: async ({ width, height }: { width: number; height: number }, session) => {
				await session.page.locator("#f").evaluate((frame, [w, h]) => Object.assign((frame as HTMLElement).style, { width: `${w}px`, height: `${h}px` }), [width, height]);
				return { result: { width, height } };
			},
		},
	});
	await session.login();
	const sizes = () => session.requests.filter((request) => request.type === "resize").map((request) => request.params);
	const grip = session.frame.getByRole("button", { name: "Resize FigPal" });
	const box = (await grip.boundingBox())!;
	const { page } = session;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2 - 40, { steps: 3 });
	await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 80, { steps: 3 });
	await page.mouse.up();
	await page.waitForTimeout(300);
	t.check("a drag resizes the panel", JSON.stringify(sizes().at(-1)) === JSON.stringify({ width: 360, height: 600 }), JSON.stringify(sizes()));
	await grip.focus();
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("ArrowRight");
	await page.waitForTimeout(300);
	t.check("the arrow keys resize it", JSON.stringify(sizes().at(-1)) === JSON.stringify({ width: 380, height: 580 }), JSON.stringify(sizes().slice(-2)));
	const corner = await grip.boundingBox();
	t.check("the grip stays in the corner", corner !== null && Math.abs(corner.x + corner.width - 380) < 2 && Math.abs(corner.y + corner.height - 580) < 2 && corner.width >= 24, JSON.stringify(corner));
	await t.screenshot(session, "resize");
}
