// A long URL (user: the message went out of the chat to the left): the text breaks in the URL, and the message and the
// answer stay in the chat.

import { type Context, text } from "../harness.ts";

export default async function longUrl(t: Context) {
	const url = `https://apps.shopify.com/fihub?locale=de&search_id=0fc9e5ba-6814-4a62-${"surface_inter_position=1&".repeat(8)}end`;
	const session = await t.open({ model: () => text(`Done: ${url}`) });
	await session.login();
	await session.ask(`See ${url}`, "Done:");
	const { frame } = session;
	/** The left and right edges of the text, and the width of the chat. */
	const edges = (shown: string) =>
		frame.getByText(shown).evaluate((el) => {
			const box = el.getBoundingClientRect();
			return { left: box.left, right: box.right, width: document.scrollingElement!.clientWidth };
		});
	const message = await edges(`See ${url}`);
	t.check("the message stays in the chat", message.left >= 0 && message.right <= message.width, JSON.stringify(message));
	const answer = await edges(`Done: ${url}`);
	t.check("the answer stays in the chat", answer.left >= 0 && answer.right <= answer.width, JSON.stringify(answer));
	await t.screenshot(session, "long-url");
}
