// Settings → Skills: install several skills of one repository (user report: after one Install, the field and the
// list of the repository were empty, so each skill needed the command again). GitHub and skills.sh are fake here.

import type { Context } from "../harness.ts";

const SKILLS = ["motion", "color", "type"];
const skillFile = (name: string) => `---\nname: ${name}\ndescription: The ${name} rules of the test repository.\n---\n\nUse ${name} well.\n`;

export default async function skills(t: Context) {
	const session = await t.open({
		setup: async (page) => {
			await page.route("https://api.github.com/repos/test/skills/git/trees/HEAD?recursive=1", (route) =>
				route.fulfill({
					json: { sha: "abc", truncated: false, tree: SKILLS.map((name) => ({ path: `skills/${name}/SKILL.md`, type: "blob", sha: name, size: 80 })) },
				}),
			);
			await page.route("**/api/skills/download/test/skills/*", (route) => {
				const name = route.request().url().split("/").at(-1)!;
				return route.fulfill({ json: { hash: name, files: [{ path: "SKILL.md", contents: skillFile(name) }] } });
			});
		},
	});
	await session.login();
	const { frame } = session;
	await frame.getByLabel("Settings").click();
	await frame.getByRole("tab", { name: "Skills" }).click();
	const field = frame.getByRole("textbox", { name: "Find or add a skill" });
	await field.fill("npx skills add https://github.com/test/skills");
	// The rows of the list: the installed skills below have no Install button.
	const list = frame.locator("li", { has: frame.getByRole("button", { name: /^(Install|Reinstall)$/ }) });
	await list.first().waitFor();
	t.check("the field lists the skills of the repository", (await list.count()) === 3, String(await list.count()));

	await list.filter({ hasText: "motion" }).getByRole("button", { name: "Install" }).click();
	await frame.getByText("Installed motion.").waitFor();
	await list.filter({ hasText: "motion" }).getByRole("button", { name: "Reinstall" }).waitFor();
	t.check(
		"after one Install, the field and the list stay, and the skill says Reinstall",
		(await field.inputValue()).includes("test/skills") && (await list.count()) === 3,
		`${await field.inputValue()} | ${await list.count()}`,
	);
	await list.filter({ hasText: "color" }).getByRole("button", { name: "Install" }).click();
	await frame.getByText("Installed color.").waitFor();
	await t.screenshot(session, "skills-repo");
	// Each installed skill has a switch, named by its name and description.
	const installed = await frame.getByRole("switch", { name: /The (motion|color) rules/ }).count();
	t.check("both skills are installed", installed === 2, String(installed));
}
