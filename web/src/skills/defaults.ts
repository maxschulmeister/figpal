// The skills that FigPal installs at the first start: the skills of Figma's MCP server guide. After that, they are
// like other skills: the user can turn them off, update them and remove them. A removed skill stays removed.

import { fetchSkill } from "./install";
import { defaultSkillsInstalled, listSkills, markDefaultSkillsInstalled, saveSkill } from "./store";

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

let installing: Promise<void> | undefined;

/**
 * Installs the default skills that are not installed, once for each start. If a download fails, it rejects, and the
 * next start installs the missing skills.
 */
export function installDefaultSkills(): Promise<void> {
	installing ??= (async () => {
		if (await defaultSkillsInstalled()) return;
		const installed = new Set((await listSkills()).map((skill) => skill.name));
		const missing = FIGMA_SKILLS.filter((name) => !installed.has(name));
		const results = await Promise.allSettled(
			missing.map(async (name) => {
				const { skill, files } = await fetchSkill({ kind: "skill", owner: "figma", repo: "mcp-server-guide", skill: name });
				await saveSkill(skill, files);
			}),
		);
		const failed = missing.filter((_, index) => results[index]!.status === "rejected");
		if (failed.length) throw new Error(`These Figma skills did not install: ${failed.join(", ")}. FigPal tries again at the next start.`);
		await markDefaultSkillsInstalled();
	})();
	return installing;
}
