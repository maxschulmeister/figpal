import "fake-indexeddb/auto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Context, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { grep } from "../skills/grep";
import { saveSkill, setSkillEnabled } from "../skills/store";
import { skillsExtension } from "./skills";

const TYPINGS = Array.from({ length: 3000 }, (_, index) => `  line${index}(): void;`);
TYPINGS[2500] = "interface FrameNode extends DefaultFrameMixin {";

await saveSkill(
	{
		name: "figma-use",
		description: "Rules for the Plugin API.",
		source: { kind: "skills.sh", id: "figma/mcp-server-guide/figma-use" },
		hash: "h",
		enabled: true,
	},
	[
		{ path: "SKILL.md", contents: "# Figma use\nLoad fonts first." },
		{ path: "references/plugin-api.d.ts", contents: TYPINGS.join("\n") },
	],
);
await saveSkill(
	{ name: "off-skill", description: "Turned off.", source: { kind: "zip", file: "a.zip" }, hash: "h", enabled: true },
	[{ path: "SKILL.md", contents: "# Off" }],
);
await setSkillEnabled("off-skill", false);

/** Runs one tool call with a scripted model. Returns the requests that the model got. */
async function call(toolName: string, args: Parameters<typeof fauxToolCall>[1]) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "script" }] });
	const requests: Context[] = [];
	faux.setResponses([
		(request) => {
			requests.push(request);
			return fauxAssistantMessage(fauxToolCall(toolName, args), { stopReason: "toolUse" });
		},
		(request) => {
			requests.push(request);
			return fauxAssistantMessage(fauxText("Done."));
		},
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	// Node has no Web Worker: grep runs on this thread.
	registry.install(skillsExtension({ grep: async (files, pattern) => grep(files, pattern) }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "script" } } });
	await (await root.submit({ type: "input", content: "Go" }, context)).wait(context);
	await harness.close(context);
	const result = requests[1]!.messages.at(-1) as { content: { text: string }[]; isError: boolean };
	// pi-durable sends the sections as system messages, and adds the diagnostics to the result text.
	const text = result.content.map((block) => block.text).join("\n");
	return { prompt: JSON.stringify(requests[0]), text, isError: result.isError };
}

describe("skills extension", () => {
	it("lists the enabled skills in the prompt, and skill_read gives SKILL.md and the other files", async () => {
		const { prompt, text } = await call("skill_read", { name: "figma-use" });
		expect(prompt).toContain("- figma-use: Rules for the Plugin API.");
		expect(prompt).not.toContain("off-skill");
		expect(text).toContain("# Figma use\nLoad fonts first.");
		expect(text).toContain("references/plugin-api.d.ts");
	});

	it("skill_read gives a long file in parts", async () => {
		const first = await call("skill_read", { name: "figma-use", path: "references/plugin-api.d.ts" });
		expect(first.text).toContain("line0(): void;");
		expect(first.text).toMatch(/Read more with start_line: \d+/);
		const line = Number(first.text.match(/start_line: (\d+)/)![1]);
		const next = await call("skill_read", { name: "figma-use", path: "references/plugin-api.d.ts", start_line: line });
		expect(next.text).toContain(`line${line - 1}(): void;`);
		expect(next.text).not.toContain("line0(): void;");
	});

	it("skill_grep finds a type in the typings, with the path and line number", async () => {
		const { text } = await call("skill_grep", { name: "figma-use", pattern: "interface FrameNode\\b" });
		expect(text).toBe("references/plugin-api.d.ts:2501: interface FrameNode extends DefaultFrameMixin {");
	});

	it("does not read a skill that is turned off", async () => {
		const { text, isError } = await call("skill_read", { name: "off-skill" });
		expect(isError).toBe(true);
		expect(text).toContain("No enabled skill off-skill");
	});

	it("names the enabled skills when the model asks for a skill that is not installed", async () => {
		const { text, isError } = await call("skill_read", { name: "figma-generate-design" });
		expect(isError).toBe(true);
		expect(text).toContain("No enabled skill figma-generate-design. Enabled skills: figma-use.");
	});

	it("refuses a start line after the end, and a file that the skill does not have", async () => {
		const late = await call("skill_read", { name: "figma-use", start_line: 999 });
		expect(late).toMatchObject({ isError: true });
		expect(late.text).toContain("SKILL.md has 2 lines");
		const missing = await call("skill_grep", { name: "figma-use", pattern: "x", path: "nope.md" });
		expect(missing).toMatchObject({ isError: true });
		expect(missing.text).toContain("has no file nope.md");
	});
});
