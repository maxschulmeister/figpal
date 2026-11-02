// Token and layer exports: the files in the step, Download, and Download again after a restart of the plugin.

import { readFileSync } from "node:fs";
import { type Context, resultText, type Session, text, toolResults, toolUse } from "../harness.ts";

const VARIABLES = {
	collections: [{ id: "C:1", name: "Colors", modes: [{ modeId: "1:0", name: "Light" }], isExtension: false }],
	variables: [
		{
			id: "V:1",
			name: "color/primary",
			resolvedType: "COLOR",
			valuesByMode: { "1:0": { r: 0, g: 0, b: 1, a: 1 } },
			variableCollectionId: "C:1",
			scopes: [],
			codeSyntax: {},
			description: "",
		},
	],
};

/** Clicks the Download of the row with this file name and gives the saved file. */
async function download(session: Session, name: string) {
	const row = session.frame.locator("li", { hasText: name });
	const file = await Promise.all([session.page.waitForEvent("download", { timeout: 8000 }), row.getByRole("button", { name: "Download" }).click()]).then(
		([file]) => file,
		() => undefined,
	);
	return file && { name: file.suggestedFilename(), text: readFileSync(await file.path(), "utf8") };
}

export default async function exports(t: Context) {
	let variables: object = VARIABLES;
	let layer: "card" | "renamed" | "deleted" = "card";
	const session = await t.open({
		requests: {
			variables: () => ({ result: variables }),
			export: ({ nodeIds }: { nodeIds: string[] }) => {
				if (layer === "deleted") throw new Error("The layer with ID 1:2 no longer exists.");
				const name = layer === "renamed" ? "Card 2.svg" : "Card.svg";
				return { result: { count: nodeIds.length }, attachments: nodeIds.map(() => ({ name, mime: "image/svg+xml", bytes: new TextEncoder().encode('<svg id="card"/>') })) };
			},
			// The code of figma_execute attaches a file.
			execute: () => ({
				result: { value: "1", truncated: false },
				attachments: [{ name: "Logo.svg", mime: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>") }],
			}),
		},
		model: (request) => {
			const done = toolResults(request).length;
			if (done === 0) return toolUse("t1", "figma_export_tokens", { format: "css-vars" });
			if (done === 1) return toolUse("t2", "figma_export_nodes", { node_ids: ["1:2"], format: "SVG" });
			if (done === 2) return toolUse("t3", "figma_execute", { code: "pi.attach(new TextEncoder().encode('<svg/>'), { mime: 'image/svg+xml', name: 'Logo.svg' }); return 1;" });
			return text("Done: the tokens and the logo are ready.");
		},
	});
	await session.login();
	await session.ask("Export the tokens, the card and the logo", "Done: the tokens");
	const count = (type: string) => session.requests.filter((request) => request.type === type).length;
	const all = await session.body();
	t.check(
		"the steps show the files",
		/Export tokens \| tokens\.css \| [\d.]+ (bytes|KB) \| Download/.test(all) && /Export layers \| Card\.svg \| 16 bytes \| Download/.test(all) && /Logo\.svg \| 6 bytes \| Download/.test(all),
		all.slice(0, 400),
	);
	const summary = resultText(toolResults(session.model[1]!)[0]!);
	t.check("the model gets the summary", summary.startsWith("Exported 1 token from 1 collection as css-vars."), summary.slice(0, 120));
	await t.screenshot(session, "export");
	const first = await download(session, "tokens.css");
	t.check("Download gives the file", first?.name === "tokens.css" && first.text.includes("--color-primary"), first?.name);
	await session.restart();
	// The steps load with the conversation.
	await session.frame.getByText("Logo.svg is no longer available").waitFor({ timeout: 30_000 });
	const after = await session.body();
	t.check(
		"after a restart: the exports keep Download, and the file of the code says to ask FigPal",
		/tokens\.css \| [\d.]+ (bytes|KB) \| Download/.test(after) && /Card\.svg \| 16 bytes \| Download/.test(after) && after.includes("Logo.svg is no longer available. Ask to export again."),
		after.slice(0, 500),
	);
	await t.screenshot(session, "export-restart");
	const calls = session.model.length;
	const before = count("variables");
	const tokens = await download(session, "tokens.css");
	t.check(
		"Download after a restart makes the tokens again, without the agent",
		tokens?.name === "tokens.css" && tokens.text.includes("--color-primary") && session.model.length === calls && count("variables") === before + 1,
		tokens?.name,
	);
	const exported = count("export");
	const card = await download(session, "Card.svg");
	t.check("Download after a restart exports the layer again", card?.name === "Card.svg" && card.text === '<svg id="card"/>' && count("export") === exported + 1, card?.name);
	// The thread list replaces the chat: the step mounts again when the user comes back.
	// The title in the header: the first line, or the AI name after the first answer.
	await session.frame.locator("header button").first().click();
	await session.page.waitForTimeout(400);
	await session.frame.getByRole("button", { name: "Back to the chat" }).click();
	await session.page.waitForTimeout(800);
	const again = await download(session, "tokens.css");
	t.check("after the step mounts again, the files stay in memory", again?.name === "tokens.css" && count("variables") === before + 1, again?.name);
	await session.restart();
	layer = "renamed";
	await session.frame.locator("li", { hasText: "Card.svg" }).getByRole("button", { name: "Download" }).click();
	await session.page.waitForTimeout(800);
	const renamed = await session.body();
	t.check(
		"a renamed layer: the new file and a clear text",
		renamed.includes("The file has changed, so the export is different now. Download the new files below.") && renamed.includes("Card 2.svg"),
		renamed.slice(0, 400),
	);
	await session.restart();
	layer = "deleted";
	await session.frame.locator("li", { hasText: "Card.svg" }).getByRole("button", { name: "Download" }).click();
	await session.page.waitForTimeout(800);
	const deleted = await session.body();
	t.check("a deleted layer: a clear text", /Cannot make Card( 2)?\.svg again: the layer with ID 1:2 no longer exists\./.test(deleted), deleted.slice(0, 400));
	await session.restart();
	variables = { collections: [], variables: [] };
	await session.frame.locator("li", { hasText: "tokens.css" }).getByRole("button", { name: "Download" }).click();
	await session.page.waitForTimeout(800);
	const empty = await session.body();
	t.check("no variables: the text of the export", empty.includes("Download | The file has no local variables to export.") && !empty.includes("Cannot make tokens.css"), empty.slice(0, 300));
}
