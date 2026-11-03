// Settings → Rules: the rules for all files and the rules for this file. Each change saves at once.

import { MAX_RULES } from "@figpal/shared";
import { Label, Text, Textarea } from "figma-kit";
import { useEffect, useRef, useState } from "react";
import type { Bridge } from "./bridge";
import { loadRules, type Rules, saveRules } from "./rules";

export function RulesPanel({ bridge }: { bridge: Pick<Bridge, "request"> }) {
	const [rules, setRules] = useState<Rules>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		loadRules(bridge).then(setRules, (cause) => setError(`FigPal could not read the rules: ${cause}`));
	}, [bridge]);
	if (error) return <Text className="text-danger">{error}</Text>;
	if (!rules) return null;
	return (
		<div className="flex flex-col gap-4">
			<RulesText label="For all files" initial={rules.global} save={(text) => saveRules(bridge, "global", text)} />
			<RulesText label="For this file" initial={rules.file} save={(text) => saveRules(bridge, "file", text)} />
		</div>
	);
}

function RulesText({ label, initial, save }: { label: string; initial: string; save(text: string): Promise<void> }) {
	const [text, setText] = useState(initial);
	const [error, setError] = useState<string>();
	const id = `rules-${label.replaceAll(" ", "-").toLowerCase()}`;
	// Each change saves at once, one save after the other: an older save must not end after a newer one. code.js waits
	// before it writes the rules for this file into the file.
	const saves = useRef(Promise.resolve());
	return (
		<section className="flex flex-col gap-2">
			<Label htmlFor={id}>{label}</Label>
			<Textarea
				id={id}
				value={text}
				maxLength={MAX_RULES}
				minRows={4}
				maxRows={16}
				onChange={(event) => {
					const value = event.target.value;
					setText(value);
					saves.current = saves.current.then(() => save(value)).then(
						() => setError(undefined),
						(cause) => setError(`FigPal could not save: ${cause}`),
					);
				}}
			/>
			{text.length >= MAX_RULES && (
				<Text className="text-secondary">Rules can have up to {MAX_RULES.toLocaleString("en-US")} characters.</Text>
			)}
			{error && <Text className="text-danger">{error}</Text>}
		</section>
	);
}
