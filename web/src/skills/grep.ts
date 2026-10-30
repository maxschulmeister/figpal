// Searches the files of a skill. The extension runs it in a Web Worker: a pattern from the model can backtrack for
// minutes on one line, and the UI thread must stay free.

import type { SkillFile } from "./store";

const MAX_LINES = 100;
const MAX_LINE_CHARACTERS = 300;

export type GrepResult = { lines: string[]; total: number };

/** The matching lines as "path:line: text": at most 100, and the total. */
export function grep(files: SkillFile[], pattern: string): GrepResult {
	const regex = new RegExp(pattern);
	const lines: string[] = [];
	let total = 0;
	for (const file of files)
		for (const [index, line] of file.contents.split("\n").entries())
			if (regex.test(line) && ++total <= MAX_LINES) lines.push(`${file.path}:${index + 1}: ${line.slice(0, MAX_LINE_CHARACTERS)}`);
	return { lines, total };
}
