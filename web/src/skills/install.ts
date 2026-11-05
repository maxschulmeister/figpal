// Installs skills: from skills.sh (through the route /api/skills, because skills.sh sends no CORS headers), from
// GitHub when skills.sh does not answer, or from a zip. A skill is a folder with SKILL.md (frontmatter: name,
// description). The name and description go into every system prompt, so they are cleaned here.

import { unzipSync } from "fflate";
import { ROUTES } from "@figpal/shared/routes";
import { parse as parseYaml } from "yaml";
import type { GitHubFolder, Skill, SkillFile, SkillSource } from "./store";

export const SKILLS_ROUTE = ROUTES.skills.path;
const GITHUB_API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** Skills are text for the model. Files of these types, and files with NUL characters, stay out. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|woff2?|ttf|otf|mp3|mp4|mov|wav|wasm|docx?|xlsx?|pptx?|DS_Store)$/i;
const MAX_FILE_CHARACTERS = 2_000_000;
const MAX_SKILL_CHARACTERS = 10_000_000;
/** The Agent Skills limits. */
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

export type SkillRef =
	| { kind: "skill"; owner: string; repo: string; skill: string }
	| { kind: "repo"; owner: string; repo: string }
	| ({ kind: "github" } & GitHubFolder);
/** A reference to one skill. */
export type OneSkill = Exclude<SkillRef, { kind: "repo" }>;

/** `skipped`: the paths of files that stay out (binary or too large). */
export type Installable = { skill: Skill; files: SkillFile[]; skipped: string[] };

const NAME = "[\\w.-]+";
const COMMAND = /^(?:npx|pnpx|bunx|pnpm dlx)\s+skills(?:@\S+)?\s+add(?:\s+|$)/;
/** Options of `skills add` that take a value. */
const VALUE_OPTIONS = new Set(["--agent", "-a"]);

/**
 * Reads `npx skills add <source> [options]`, `owner/repo@skill`, a skills.sh URL or a GitHub URL. Other text, also
 * "a/b" without the command (such as "ui/ux"), is a search query: the result is undefined.
 */
export function parseSkillInput(input: string): SkillRef | undefined {
	let source = input.trim();
	let skill: string | undefined;
	const command = COMMAND.exec(source);
	if (command) {
		const words = source.slice(command[0].length).split(/\s+/).filter(Boolean);
		source = "";
		for (let index = 0; index < words.length; index++) {
			const word = words[index]!;
			const [option, value] = word.split("=", 2);
			if (option === "--skill" || option === "-s") skill = value ?? words[++index];
			else if (VALUE_OPTIONS.has(word)) index++;
			else if (!word.startsWith("-") && !source) source = word;
		}
	}
	const skillsSh = source.match(new RegExp(`^https://skills\\.sh/(${NAME})/(${NAME})/(${NAME})/?$`));
	if (skillsSh) return { kind: "skill", owner: skillsSh[1]!, repo: skillsSh[2]!, skill: skillsSh[3]! };
	const tree = source.match(new RegExp(`^https://github\\.com/(${NAME})/(${NAME})/tree/([^/\\s]+)/(\\S+?)/?$`));
	if (tree) return { kind: "github", owner: tree[1]!, repo: tree[2]!, ref: tree[3]!, path: tree[4]! };
	const url = source.match(new RegExp(`^https://github\\.com/(${NAME})/(${NAME})/?$`));
	const short = source.match(new RegExp(`^(${NAME})/(${NAME})(?:@(${NAME}))?$`));
	const repo = url ?? (short && (command || short[3]) ? short : undefined);
	if (!repo) return undefined;
	const [owner, name] = [repo[1]!, repo[2]!.replace(/\.git$/, "")];
	skill = repo[3] ?? skill;
	return skill ? { kind: "skill", owner, repo: name, skill } : { kind: "repo", owner, repo: name };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function get(url: string): Promise<Response> {
	const response = await fetch(url);
	if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
		const minutes = Math.ceil((Number(response.headers.get("x-ratelimit-reset")) * 1000 - Date.now()) / 60_000);
		const when = minutes > 0 ? `in ${minutes} minute${minutes === 1 ? "" : "s"}` : "later";
		throw new Error(`The GitHub rate limit (60 requests in an hour) is reached. Try again ${when}.`);
	}
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response;
}

function frontmatter(contents: string): Record<string, unknown> {
	const match = contents.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
	const data: unknown = match ? parseYaml(match[1]!) : undefined;
	return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

/** One line, without angle brackets: a "</skills>" in a description must not end the prompt section. */
const clean = (value: unknown) => (typeof value === "string" ? value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim() : "");

const isText = (file: SkillFile) =>
	!BINARY.test(file.path) && !file.contents.includes("\u0000") && file.contents.length <= MAX_FILE_CHARACTERS;

/** The skill from its files. SKILL.md at the top must give a name and a description. */
function skillFromFiles(files: SkillFile[], source: SkillSource, hash: string): Installable {
	const text = files.filter(isText);
	if (text.reduce((sum, file) => sum + file.contents.length, 0) > MAX_SKILL_CHARACTERS)
		throw new Error("The skill is larger than 10 MB");
	const main = text.find((file) => file.path === "SKILL.md");
	if (!main) throw new Error("The skill has no SKILL.md");
	const data = frontmatter(main.contents);
	const name = clean(data.name);
	const description = clean(data.description).slice(0, MAX_DESCRIPTION);
	if (!name || !description) throw new Error("SKILL.md must give a name and a description");
	if (name.length > MAX_NAME) throw new Error(`The skill name is longer than ${MAX_NAME} characters`);
	return {
		skill: { name, description, source, hash, enabled: true },
		files: text,
		skipped: files.filter((file) => !isText(file)).map((file) => file.path),
	};
}

type TreeEntry = { path: string; type: string; sha?: string; size?: number };
type Tree = { sha: string; entries: TreeEntry[] };

/**
 * GitHub allows 60 API requests in an hour without a login, for all programs on the network. The list of a repository
 * and the installs of its skills use one tree for 10 minutes, also at the same time (user report: the limit was
 * reached). A failed read is not kept. `fresh`: for Check for update.
 */
const TREE_TTL_MS = 10 * 60_000;
const trees = new Map<string, { at: number; tree: Promise<Tree> }>();

/** For tests: each test starts without trees. */
export const forgetGitHubTrees = () => trees.clear();

function githubTree({ owner, repo, ref }: Omit<GitHubFolder, "path">, { fresh = false } = {}): Promise<Tree> {
	const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
	const kept = trees.get(url);
	if (kept && !fresh && Date.now() - kept.at < TREE_TTL_MS) return kept.tree;
	// Expired trees go, so that large trees do not stay in memory.
	for (const [key, { at }] of trees) if (Date.now() - at >= TREE_TTL_MS) trees.delete(key);
	const tree = (async () => {
		const json = (await (await get(url)).json()) as { sha?: string; tree?: TreeEntry[]; truncated?: boolean };
		// Without all files, a skill could install with files missing.
		if (json.truncated) throw new Error(`${owner}/${repo} is too large for the GitHub API. Install the skill from skills.sh or a zip.`);
		return { sha: json.sha ?? "", entries: json.tree ?? [] };
	})();
	trees.set(url, { at: Date.now(), tree });
	tree.catch(() => trees.get(url)?.tree === tree && trees.delete(url));
	return tree;
}

/** The tree SHA of a folder: the hash of a GitHub skill. */
const folderSha = (tree: Tree, path: string) =>
	path ? (tree.entries.find((entry) => entry.type === "tree" && entry.path === path)?.sha ?? "") : tree.sha;

/**
 * The skill folders of a repository, one for each name: a folder under skills/ first, then the shortest path. A
 * SKILL.md at the top has the path "" and the name of the repository.
 */
function skillFolders(tree: Tree, repo: string): { name: string; path: string }[] {
	const folders = tree.entries
		.filter((entry) => entry.type === "blob" && /(^|\/)SKILL\.md$/.test(entry.path))
		.map((entry) => (entry.path === "SKILL.md" ? "" : entry.path.slice(0, -"/SKILL.md".length)))
		.sort((a, b) => Number(!a.startsWith("skills/")) - Number(!b.startsWith("skills/")) || a.length - b.length);
	const byName = new Map<string, string>();
	for (const path of folders) {
		const name = path ? path.split("/").at(-1)! : repo;
		if (!byName.has(name)) byName.set(name, path);
	}
	return [...byName].map(([name, path]) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function repoSkills(owner: string, repo: string): Promise<{ name: string; path: string }[]> {
	return skillFolders(await githubTree({ owner, repo, ref: "HEAD" }), repo);
}

/** The files of a folder on GitHub. The tree gives the sizes, so the limits apply before the download. */
async function fromGitHub(folder: GitHubFolder, known?: Tree): Promise<Installable> {
	const tree = known ?? (await githubTree(folder));
	const prefix = folder.path ? `${folder.path}/` : "";
	const blobs = tree.entries.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix));
	const wanted = blobs.filter((entry) => !BINARY.test(entry.path) && (entry.size ?? 0) <= MAX_FILE_CHARACTERS);
	if (wanted.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > MAX_SKILL_CHARACTERS)
		throw new Error("The skill is larger than 10 MB");
	const files = await Promise.all(
		wanted.map(async (entry) => ({
			path: entry.path.slice(prefix.length),
			contents: await (await get(`${RAW}/${folder.owner}/${folder.repo}/${folder.ref}/${entry.path}`)).text(),
		})),
	);
	const result = skillFromFiles(files, { kind: "github", ...folder }, folderSha(tree, folder.path));
	const left = blobs.filter((entry) => !wanted.includes(entry)).map((entry) => entry.path.slice(prefix.length));
	return { ...result, skipped: [...left, ...result.skipped] };
}

function isDownload(value: unknown): value is { files: SkillFile[]; hash: string } {
	const download = value as { files?: unknown; hash?: unknown } | null;
	return (
		typeof download?.hash === "string" &&
		Array.isArray(download.files) &&
		download.files.every((file) => typeof file?.path === "string" && typeof file.contents === "string")
	);
}

const downloadFromSkillsSh = async (id: string): Promise<unknown> => (await get(`${SKILLS_ROUTE}/download/${id}`)).json();

function fromDownload(id: string, download: unknown): Installable {
	if (!isDownload(download)) throw new Error("The skills.sh answer has missing fields");
	return skillFromFiles(download.files, { kind: "skills.sh", id }, download.hash);
}

/** A skill from skills.sh. If skills.sh does not answer, from GitHub. A GitHub folder comes from GitHub. */
export async function fetchSkill(ref: OneSkill): Promise<Installable> {
	if (ref.kind === "github") return fromGitHub(ref);
	const id = `${ref.owner}/${ref.repo}/${ref.skill}`;
	let skillsShError: unknown;
	const download = await downloadFromSkillsSh(id).catch((error) => {
		skillsShError = error;
	});
	if (download !== undefined) return fromDownload(id, download);
	// Give both causes: a broken route must not hide behind a GitHub error.
	try {
		const tree = await githubTree({ owner: ref.owner, repo: ref.repo, ref: "HEAD" });
		const folder = skillFolders(tree, ref.repo).find((item) => item.name === ref.skill);
		if (!folder) throw new Error(`${ref.owner}/${ref.repo} has no skill ${ref.skill}`);
		return await fromGitHub({ owner: ref.owner, repo: ref.repo, ref: "HEAD", path: folder.path }, tree);
	} catch (error) {
		throw new Error(`skills.sh: ${errorText(skillsShError)} GitHub: ${errorText(error)}`);
	}
}

/**
 * The newer version of a skill from the same source, or undefined if the hash is the same. A GitHub skill compares the
 * folder SHA before it downloads files. A zip has no updates.
 */
export async function fetchUpdate(skill: Skill): Promise<Installable | undefined> {
	const { source } = skill;
	if (source.kind === "zip") return undefined;
	let next: Installable;
	if (source.kind === "skills.sh") next = fromDownload(source.id, await downloadFromSkillsSh(source.id));
	else {
		const tree = await githubTree(source, { fresh: true });
		if (folderSha(tree, source.path) === skill.hash) return undefined;
		next = await fromGitHub(source, tree);
	}
	if (next.skill.hash === skill.hash) return undefined;
	return { ...next, skill: { ...next.skill, enabled: skill.enabled } };
}

export type SearchResult = { owner: string; repo: string; skill: string; installs: number };

export async function searchSkills(query: string): Promise<SearchResult[]> {
	const json = (await (await get(`${SKILLS_ROUTE}/search?q=${encodeURIComponent(query)}&limit=10`)).json()) as {
		skills?: unknown;
	};
	if (!Array.isArray(json.skills)) throw new Error("The skills.sh answer has missing fields");
	return json.skills.flatMap((item: { source?: unknown; skillId?: unknown; installs?: unknown }) => {
		const [owner, repo] = typeof item.source === "string" ? item.source.split("/") : [];
		if (!owner || !repo || typeof item.skillId !== "string") return [];
		return [{ owner, repo, skill: item.skillId, installs: typeof item.installs === "number" ? item.installs : 0 }];
	});
}

/**
 * A skill from a zip: the folder of the shortest SKILL.md path. Binary and large entries are not unpacked, and the
 * size limit applies before the unpacking (a zip can be small and unpack to gigabytes).
 */
export function skillFromZip(file: string, bytes: Uint8Array): Installable {
	let size = 0;
	const entries = unzipSync(bytes, {
		filter: (entry) => {
			const keep =
				!entry.name.startsWith("__MACOSX/") &&
				!entry.name.endsWith("/") &&
				!BINARY.test(entry.name) &&
				entry.originalSize <= MAX_FILE_CHARACTERS;
			if (keep) size += entry.originalSize;
			if (size > MAX_SKILL_CHARACTERS) throw new Error("The skill is larger than 10 MB");
			return keep;
		},
	});
	const paths = Object.keys(entries);
	const main = paths.filter((path) => /(^|\/)SKILL\.md$/.test(path)).sort((a, b) => a.length - b.length)[0];
	if (!main) throw new Error("The zip has no SKILL.md");
	const folder = main.slice(0, -"SKILL.md".length);
	const decoder = new TextDecoder();
	const files = paths
		.filter((path) => path.startsWith(folder))
		.map((path) => ({ path: path.slice(folder.length), contents: decoder.decode(entries[path]) }));
	return skillFromFiles(files, { kind: "zip", file }, "");
}
