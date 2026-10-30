import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FIGMA_SKILLS = [
	"figma-code-connect",
	"figma-code-workflows",
	"figma-create-new-file",
	"figma-design-to-code",
	"figma-generate-design",
	"figma-generate-diagram",
	"figma-generate-library",
	"figma-generative-plugins",
	"figma-implement-motion",
	"figma-shaders",
	"figma-spec",
	"figma-swiftui",
	"figma-use",
	"figma-use-figjam",
	"figma-use-motion",
	"figma-use-slides",
];

/** skills.sh answers for the Figma skills. The skills in `down` fail, also on GitHub. */
function fakeSkillsSh(down: string[] = []) {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			urls.push(url);
			const name = url.match(/^\/api\/skills\/download\/figma\/mcp-server-guide\/(.+)$/)?.[1];
			if (!name || down.includes(name)) return new Response("error", { status: 500 });
			const contents = `---\nname: ${name}\ndescription: Use ${name}.\n---\n`;
			return Response.json({ files: [{ path: "SKILL.md", contents }], hash: "h" });
		}),
	);
	return urls;
}

/** A new start of FigPal: the modules load again, the database stays. */
async function start() {
	vi.resetModules();
	return { defaults: await import("./defaults"), store: await import("./store") };
}

const names = async (store: typeof import("./store")) => (await store.listSkills()).map((skill) => skill.name);

beforeEach(() => {
	vi.unstubAllGlobals();
	vi.stubGlobal("indexedDB", new IDBFactory());
});

describe("default skills", () => {
	it("installs the Figma skills at the first start, and not again after the user removes one", async () => {
		const urls = fakeSkillsSh();
		let { defaults, store } = await start();
		await defaults.installDefaultSkills();
		expect(await names(store)).toEqual(FIGMA_SKILLS);
		await store.removeSkill("figma-shaders");

		({ defaults, store } = await start());
		urls.length = 0;
		await defaults.installDefaultSkills();
		expect(urls).toEqual([]);
		expect(await names(store)).not.toContain("figma-shaders");
	});

	it("keeps an installed skill, and tries the failed ones again at the next start", async () => {
		fakeSkillsSh(["figma-use-motion"]);
		let { defaults, store } = await start();
		await store.saveSkill(
			{ name: "figma-use", description: "Mine.", source: { kind: "zip", file: "mine.zip" }, hash: "", enabled: false },
			[{ path: "SKILL.md", contents: "Mine" }],
		);
		await expect(defaults.installDefaultSkills()).rejects.toThrow(/figma-use-motion/);
		expect((await store.listSkills()).find((skill) => skill.name === "figma-use")).toMatchObject({
			description: "Mine.",
			enabled: false,
		});

		fakeSkillsSh();
		({ defaults, store } = await start());
		await defaults.installDefaultSkills();
		expect(await names(store)).toEqual(FIGMA_SKILLS);
	});
});
