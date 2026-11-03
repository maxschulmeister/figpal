// The skills in the settings: find and install (skills.sh, GitHub, zip), turn on and off, update, remove. Results show
// while the user types. A pasted install command or URL shows its skill at once.

import { AlertDialog, Button, DropdownMenu, EllipsisIcon, IconButton, Input, Label, Switch, Text } from "figma-kit";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./accounts";
import {
	fetchSkill,
	fetchUpdate,
	type Installable,
	type OneSkill,
	parseSkillInput,
	repoSkills,
	searchSkills,
	skillFromZip,
} from "./skills/install";
import { installDefaultSkills } from "./skills/defaults";
import { listSkills, removeSkill, type Skill, type SkillSource, saveSkill, setSkillEnabled } from "./skills/store";

type Candidate = { label: string; detail: string; ref: OneSkill };

const MAX_ZIP_BYTES = 50_000_000;
const SEARCH_DELAY_MS = 300;
/** skills.sh refuses a shorter query. */
const MIN_QUERY = 2;

/** The skill of a pasted reference: no download before the install. */
const direct = (ref: OneSkill): Candidate =>
	ref.kind === "skill"
		? { label: ref.skill, detail: `${ref.owner}/${ref.repo}`, ref }
		: { label: ref.path.split("/").at(-1) || ref.repo, detail: `${ref.owner}/${ref.repo}`, ref };

/** The skills of a repository (an install command without a skill), or the skills.sh results for the text. */
async function find(text: string, repo: { owner: string; repo: string } | undefined): Promise<Candidate[]> {
	// A skill from a repository installs like any skill: skills.sh first, then the same folder on GitHub.
	if (repo)
		return (await repoSkills(repo.owner, repo.repo)).map((item) => ({
			label: item.name,
			detail: `${repo.owner}/${repo.repo}`,
			ref: { kind: "skill", owner: repo.owner, repo: repo.repo, skill: item.name },
		}));
	return (await searchSkills(text)).map((item) => ({
		label: item.skill,
		detail: `${item.owner}/${item.repo} · ${item.installs.toLocaleString("en")} installs`,
		ref: { kind: "skill", owner: item.owner, repo: item.repo, skill: item.skill },
	}));
}

const sourceText = (source: SkillSource) =>
	source.kind === "skills.sh"
		? source.id
		: source.kind === "github"
			? [source.owner, source.repo, source.path].filter(Boolean).join("/")
			: source.file;

export function SkillsPanel() {
	const [skills, setSkills] = useState<Skill[]>();
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<{ candidates: Candidate[] } | { error: string }>();
	const [searching, setSearching] = useState(false);
	const [status, setStatus] = useState<{ text: string; error?: boolean }>();
	const [busy, setBusy] = useState(false);
	const [installingDefaults, setInstallingDefaults] = useState(true);
	const [removing, setRemoving] = useState<Skill>();
	const running = useRef(false);
	const upload = useRef<HTMLInputElement>(null);

	const refresh = useCallback(() => listSkills().then(setSkills, (error) => setStatus({ text: errorText(error), error: true })), []);
	useEffect(() => {
		void refresh();
		installDefaultSkills()
			.then(refresh, (error) => setStatus({ text: errorText(error), error: true }))
			.finally(() => setInstallingDefaults(false));
	}, [refresh]);

	const text = query.trim();
	const parsed = parseSkillInput(text);
	const pasted = parsed && parsed.kind !== "repo" ? parsed : undefined;
	useEffect(() => {
		const ref = parseSkillInput(text);
		if ((ref && ref.kind !== "repo") || text.length < MIN_QUERY) return setResults(undefined);
		let current = true;
		const timer = setTimeout(() => {
			setSearching(true);
			find(text, ref)
				.then(
					(candidates) => current && setResults({ candidates }),
					(error) => current && setResults({ error: errorText(error) }),
				)
				.finally(() => current && setSearching(false));
		}, SEARCH_DELAY_MS);
		return () => {
			current = false;
			clearTimeout(timer);
			setSearching(false);
		};
	}, [text]);
	const candidates = pasted ? [direct(pasted)] : results && "candidates" in results ? results.candidates : undefined;

	/** One action at a time. The status shows its result or its error. */
	const act = async (action: () => Promise<string>) => {
		if (running.current) return;
		running.current = true;
		setBusy(true);
		setStatus(undefined);
		try {
			setStatus({ text: await action() });
		} catch (error) {
			setStatus({ text: errorText(error), error: true });
		} finally {
			running.current = false;
			setBusy(false);
			void refresh();
		}
	};

	/** Saves the skill. The status names what it replaced and what it left out. */
	const install = async ({ skill, files, skipped }: Installable, verb = "Installed") => {
		const old = skills?.find((item) => item.name === skill.name);
		await saveSkill(skill, files);
		const replaced =
			old && sourceText(old.source) !== sourceText(skill.source) ? ` It replaced the one from ${sourceText(old.source)}.` : "";
		const left = skipped.length ? ` Left out: ${skipped.join(", ")}.` : "";
		return `${verb} ${skill.name}.${replaced}${left}`;
	};

	/**
	 * Installs the skill. The field and the list stay, so the user can install more skills of the list (user report);
	 * the button of the skill then says Reinstall.
	 */
	const installCandidate = (candidate: Candidate) => act(async () => install(await fetchSkill(candidate.ref)));

	/** Enter installs a pasted skill, and empties the field after a success. Search results show without Enter. */
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!pasted) return;
		void act(async () => {
			const message = await install(await fetchSkill(direct(pasted).ref));
			setQuery("");
			return message;
		});
	};

	return (
		<div className="flex flex-col gap-4">
			<form className="flex gap-2" onSubmit={submit}>
				<Input
					className="flex-1"
					aria-label="Find or add a skill"
					placeholder="Search skills.sh, or paste npx skills add …"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setStatus(undefined);
					}}
				/>
				<Button type="button" disabled={busy} onClick={() => upload.current?.click()}>
					Upload zip
				</Button>
				<input
					ref={upload}
					type="file"
					accept=".zip,application/zip"
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (!file) return;
						void act(async () => {
							if (file.size > MAX_ZIP_BYTES) throw new Error("The zip is larger than 50 MB");
							return install(skillFromZip(file.name, new Uint8Array(await file.arrayBuffer())));
						});
					}}
				/>
			</form>
			{status?.text && <Text className={status.error ? "text-danger" : "text-secondary"}>{status.text}</Text>}
			{results && "error" in results && <Text className="text-danger">{results.error}</Text>}
			{searching && !candidates && <Text className="text-secondary">Searching…</Text>}
			{candidates?.length === 0 && <Text className="text-secondary">No skills found.</Text>}
			{candidates && candidates.length > 0 && (
				<ul className="flex flex-col">
					{candidates.map((candidate) => (
						<li key={`${candidate.detail}/${candidate.label}`} className="flex items-center gap-2 py-1">
							<div className="flex min-w-0 flex-1 flex-col">
								<Text className="truncate">{candidate.label}</Text>
								<Text className="truncate text-secondary">{candidate.detail}</Text>
							</div>
							<Button disabled={busy} onClick={() => void installCandidate(candidate)}>
								{skills?.some((skill) => skill.name === candidate.label) ? "Reinstall" : "Install"}
							</Button>
						</li>
					))}
				</ul>
			)}
			<section className="flex flex-col gap-1">
				<Text weight="strong">Installed</Text>
				{skills?.length === 0 && (
					<Text className="text-secondary">{installingDefaults ? "Installing the Figma skills…" : "No skills yet."}</Text>
				)}
				<ul className="flex flex-col">
					{skills?.map((skill) => (
						<li key={skill.name} className="flex items-start gap-2 py-2">
							<Label className="flex min-w-0 flex-1 items-start gap-2">
								<Switch
									className="mt-0.5 shrink-0"
									checked={skill.enabled}
									disabled={busy}
									onCheckedChange={(enabled) =>
										void act(async () => {
											await setSkillEnabled(skill.name, enabled);
											return "";
										})
									}
								/>
								<span className="flex min-w-0 flex-col">
									<Text weight="strong" className="truncate">
										{skill.name}
									</Text>
									<Text className="line-clamp-2 text-secondary" title={skill.description}>
										{skill.description}
									</Text>
									<Text size="small" className="truncate text-tertiary">
										{sourceText(skill.source)}
									</Text>
								</span>
							</Label>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger render={<IconButton aria-label={`More for ${skill.name}`} disabled={busy} />}>
									<EllipsisIcon />
								</DropdownMenu.Trigger>
								<DropdownMenu.Portal>
									<DropdownMenu.Positioner sideOffset={4} align="end">
										<DropdownMenu.Popup style={{ minWidth: 160 }}>
											{skill.source.kind !== "zip" && (
												<DropdownMenu.Item
													onClick={() =>
														void act(async () => {
															const next = await fetchUpdate(skill);
															return next ? install(next, "Updated") : `${skill.name} is up to date.`;
														})
													}
												>
													Check for update
												</DropdownMenu.Item>
											)}
											<DropdownMenu.Item onClick={() => setRemoving(skill)}>Remove…</DropdownMenu.Item>
										</DropdownMenu.Popup>
									</DropdownMenu.Positioner>
								</DropdownMenu.Portal>
							</DropdownMenu.Root>
						</li>
					))}
				</ul>
			</section>
			<AlertDialog.Root open={removing !== undefined} onOpenChange={(open) => open || setRemoving(undefined)}>
				<AlertDialog.Portal>
					<AlertDialog.Backdrop />
					<AlertDialog.Popup placement="center">
						<AlertDialog.Title>Remove {removing?.name}?</AlertDialog.Title>
						<AlertDialog.Description>
							{removing?.source.kind === "zip" ? "To get it back, upload the zip again." : "You can install it again."}
						</AlertDialog.Description>
						<AlertDialog.Actions>
							<AlertDialog.Close render={<Button />}>Cancel</AlertDialog.Close>
							<AlertDialog.Close
								render={<Button variant="destructive" />}
								onClick={() =>
									removing &&
									void act(async () => {
										await removeSkill(removing.name);
										return `Removed ${removing.name}.`;
									})
								}
							>
								Remove
							</AlertDialog.Close>
						</AlertDialog.Actions>
					</AlertDialog.Popup>
				</AlertDialog.Portal>
			</AlertDialog.Root>
		</div>
	);
}
