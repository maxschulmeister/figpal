import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { listSkills, removeSkill, type Skill, saveSkill, setSkillEnabled, skillFiles } from "./store";

const skill = (name: string): Skill => ({
	name,
	description: `Use ${name}.`,
	source: { kind: "skills.sh", id: `owner/repo/${name}` },
	hash: "h1",
	enabled: true,
});

describe("skills store", () => {
	it("keeps skills and their files, and lists the skills by name without the files", async () => {
		await saveSkill(skill("zeta"), [{ path: "SKILL.md", contents: "# Zeta" }]);
		await saveSkill(skill("alpha"), [
			{ path: "SKILL.md", contents: "# Alpha" },
			{ path: "references/api.md", contents: "API" },
		]);
		expect((await listSkills()).map((item) => item.name)).toEqual(["alpha", "zeta"]);
		expect(await skillFiles("alpha")).toEqual([
			{ path: "SKILL.md", contents: "# Alpha" },
			{ path: "references/api.md", contents: "API" },
		]);
	});

	it("replaces a skill on a new install, turns it off and on, and removes it with its files", async () => {
		await saveSkill(skill("beta"), [{ path: "SKILL.md", contents: "old" }]);
		await saveSkill({ ...skill("beta"), hash: "h2" }, [{ path: "SKILL.md", contents: "new" }]);
		await setSkillEnabled("beta", false);
		expect((await listSkills()).find((item) => item.name === "beta")).toMatchObject({ hash: "h2", enabled: false });
		expect(await skillFiles("beta")).toEqual([{ path: "SKILL.md", contents: "new" }]);
		await removeSkill("beta");
		expect((await listSkills()).some((item) => item.name === "beta")).toBe(false);
		expect(await skillFiles("beta")).toBeUndefined();
	});

	it("keeps the skills of a version 1 database (the first Phase 3 builds)", async () => {
		vi.stubGlobal("indexedDB", new IDBFactory());
		await new Promise<void>((resolve) => {
			const request = indexedDB.open("figpal:global", 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore("skills", { keyPath: "name" }).put(skill("old"));
				request.result.createObjectStore("files").put([{ path: "SKILL.md", contents: "# Old" }], "old");
			};
			request.onsuccess = () => {
				request.result.close();
				resolve();
			};
		});
		vi.resetModules();
		const store = await import("./store");
		expect((await store.listSkills()).map((item) => item.name)).toEqual(["old"]);
		expect(await store.skillFiles("old")).toEqual([{ path: "SKILL.md", contents: "# Old" }]);
		expect(await store.defaultSkillsInstalled()).toBe(false);
		await store.markDefaultSkillsInstalled();
		expect(await store.defaultSkillsInstalled()).toBe(true);
		vi.unstubAllGlobals();
	});
});
