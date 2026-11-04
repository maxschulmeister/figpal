// The `skills` extension: the enabled skills in the prompt, and tools that read them from the global store.

import { boundOutput } from "@earendil-works/chord/output";
import { defineExtension, defineTool, section, type ToolDiagnostic } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import type { GrepResult } from "../skills/grep";
import { listSkills, type SkillFile, skillFiles } from "../skills/store";

/** A longer file comes in parts. Below pi-durable's output limits (50 KB, 2000 lines). */
const READ_BYTES = 40_000;
const READ_LINES = 1500;
const GREP_TIMEOUT_MS = 2000;

type Grep = (files: SkillFile[], pattern: string) => Promise<GrepResult>;

/** Runs grep in a Web Worker, and stops it after GREP_TIMEOUT_MS. */
const grepInWorker: Grep = (files, pattern) => {
	// A syntax error comes back at once.
	new RegExp(pattern);
	const worker = new Worker(new URL("../skills/grep-worker.ts", import.meta.url), { type: "module" });
	return new Promise((resolve, reject) => {
		const end = () => {
			clearTimeout(timer);
			worker.terminate();
		};
		const timer = setTimeout(() => {
			end();
			reject(new Error("The pattern is too slow. Use a simpler pattern, for example without nested repeats."));
		}, GREP_TIMEOUT_MS);
		worker.onmessage = (event: MessageEvent<GrepResult>) => {
			end();
			resolve(event.data);
		};
		worker.onerror = (event) => {
			end();
			reject(new Error(event.message));
		};
		worker.postMessage({ files, pattern });
	});
};

/** The files of an enabled skill. A turned-off skill is not for the model. */
async function enabledSkillFiles(name: string): Promise<SkillFile[]> {
	const enabled = (await listSkills()).filter((skill) => skill.enabled).map((skill) => skill.name);
	const files = enabled.includes(name) ? await skillFiles(name) : undefined;
	if (!files) throw new Error(`No enabled skill ${name}. Enabled skills: ${enabled.join(", ") || "none"}.`);
	return files;
}

function findFile(files: SkillFile[], name: string, path: string): SkillFile {
	const file = files.find((item) => item.path === path);
	if (!file) throw new Error(`The skill ${name} has no file ${path}`);
	return file;
}

/** The lines from `startLine` (1 is the first line) within the limits, and a note when more lines follow. */
function readLines(file: SkillFile, startLine: number): { text: string; diagnostics: ToolDiagnostic[] } {
	const lines = file.contents.split("\n");
	if (startLine > lines.length) throw new Error(`${file.path} has ${lines.length} lines`);
	const slice = boundOutput(lines.slice(startLine - 1).join("\n"), { maxBytes: READ_BYTES, maxLines: READ_LINES, retain: "head" });
	if (!slice.droppedBytes) return { text: slice.text, diagnostics: [] };
	// boundOutput keeps whole lines. It cuts a line only when that one line is longer than the limit.
	const cut = !slice.text.endsWith("\n");
	const shown = slice.text.replace(/\n$/, "").split("\n").length;
	const next = startLine + shown;
	const message = [
		cut ? `Line ${next - 1} is longer than 40 KB and was cut.` : "",
		next <= lines.length ? `Read more with start_line: ${next} (${lines.length} lines in all).` : "",
	].join(" ");
	return { text: slice.text, diagnostics: [{ severity: "info", code: "truncated", message: message.trim() }] };
}

const kilobytes = (contents: string) => `${Math.max(1, Math.round(contents.length / 1000))} KB`;

/** `grep` replaces the Web Worker in tests: Node has none. */
export function skillsExtension({ grep: search = grepInWorker }: { grep?: Grep } = {}) {
	return defineExtension({
		name: "skills",
		sections: [
			section("skills", async () => {
				const skills = (await listSkills()).filter((skill) => skill.enabled);
				if (!skills.length) return undefined;
				return [
					"Before a task that a skill covers, read the skill with skill_read; skill_grep finds text in large references.",
					"A link such as ../figma-generate-design/SKILL.md is the skill figma-generate-design. If a skill names one that is not in this list, continue without it and tell the user that they can install it in Settings.",
					"For tools of the Figma MCP server, use figma_execute for use_figma, figma_screenshot for get_screenshot, and for export_video figma_export_nodes (a file for the user) or figma_animation_frames (frames to check; no ffmpeg or jobId). Do the work of other Figma MCP tools with figma_execute, or say that FigPal cannot do it.",
					"",
					...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
				].join("\n");
			}),
		],
		tools: [
			defineTool({
				name: "skill_read",
				description:
					"Reads a file of a skill. Without path: SKILL.md and the list of the other files. A long file comes in parts.",
				parameters: obj(
					{
						name: str(),
						path: opt(str({ description: "Default SKILL.md." })),
						start_line: opt(int({ minimum: 1, description: "Line to start at. Default 1." })),
					},
					{ open: true },
				),
				replay: "safe",
				execute: async ({ name, path = "SKILL.md", start_line = 1 }) => {
					const files = await enabledSkillFiles(name);
					const file = findFile(files, name, path);
					const { text, diagnostics } = readLines(file, start_line);
					const others = files.filter((item) => item !== file);
					const list =
						path === "SKILL.md" && start_line === 1 && others.length
							? `\n\nOther files:\n${others.map((item) => `- ${item.path} (${kilobytes(item.contents)})`).join("\n")}`
							: "";
					return { output: [{ type: "text", text: text + list }], diagnostics };
				},
			}),
			defineTool({
				name: "skill_grep",
				description: "Finds lines that match a regular expression in the files of a skill. Gives path:line: text.",
				parameters: obj({ name: str(), pattern: str(), path: opt(str({ description: "Search only this file." })) }, { open: true }),
				// The Web Worker stops a slow pattern, so a rerun after a restart cannot block the UI.
				replay: "safe",
				execute: async ({ name, pattern, path }) => {
					const files = await enabledSkillFiles(name);
					const { lines, total } = await search(path === undefined ? files : [findFile(files, name, path)], pattern);
					const more = total > lines.length ? `\n… ${total - lines.length} more matches. Make the pattern narrower.` : "";
					return { output: [{ type: "text", text: (lines.join("\n") || "No matches.") + more }] };
				},
			}),
		],
	});
}
