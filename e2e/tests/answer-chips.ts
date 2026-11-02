// Layer chips in the agent's answers: the agent links the layers that it names, and a click selects them.

import { type Context, text } from "../harness.ts";

export default async function answerChips(t: Context) {
	const session = await t.open({
		requests: {
			// The layer 1:4 is on another page.
			select: ({ nodeIds }: { nodeIds: string[] }) => ({ result: { count: nodeIds.filter((id) => id !== "1:4").length } }),
		},
		// A link text with formatting keeps its name.
		model: () => text("I fixed [**Card**](#node=1:2) and [2 icons](#node=1-3,1:4). See [the docs](https://help.figma.com)."),
	});
	await session.login();
	await session.ask("Fix the card", "I fixed");
	const { frame } = session;
	const card = frame.getByRole("button", { name: "Select 1 layer: Card" });
	const icons = frame.getByRole("button", { name: "Select 2 layers: 2 icons" });
	t.check("the linked layers are chips", (await card.count()) === 1 && (await icons.count()) === 1);
	t.check("other links stay links", (await frame.getByRole("link", { name: "the docs" }).count()) === 1);
	await icons.click();
	await session.page.waitForTimeout(400);
	const selects = session.requests.filter((request) => request.type === "select").map((request) => request.params);
	t.check("a click selects the layers", JSON.stringify(selects) === JSON.stringify([{ nodeIds: ["1:3", "1:4"] }]), JSON.stringify(selects));
	const status = await frame.getByRole("status").allInnerTexts();
	t.check("it says when it selected only some layers", status.includes("(Selected 1 of 2 layers. The others are on other pages or no longer exist.)"), JSON.stringify(status));
	await t.screenshot(session, "answer-chips");
}
