// Settings → Access → Backup: the chats and the skills in a file, and back. FigPal starts again for an import.

import { Button, Dialog, Text } from "figma-kit";
import { useRef, useState } from "react";
import { Account, errorText } from "./accounts";
import { type BackupSummary, checkBackup, exportData, stageImport } from "./backup";
import { downloadBlob } from "./files";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function BackupSettings() {
	const input = useRef<HTMLInputElement>(null);
	const [chosen, setChosen] = useState<{ file: File; summary: BackupSummary }>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	const act = async (action: () => Promise<void>) => {
		setBusy(true);
		setError(undefined);
		try {
			await action();
		} catch (reason) {
			setError(errorText(reason));
		} finally {
			setBusy(false);
		}
	};
	const exportAll = () =>
		act(async () => downloadBlob(await exportData(), `figpal-backup-${new Date().toISOString().slice(0, 10)}.jsonl`));
	const choose = (file: File | undefined) => {
		if (!file) return;
		void act(async () => setChosen({ file, summary: await checkBackup(file) }));
	};
	const importChosen = () =>
		act(async () => {
			await stageImport(chosen!.file);
			location.reload();
		});

	const what = chosen && `the chats of ${plural(chosen.summary.files, "file")}${chosen.summary.skills ? " and the skills" : ""}`;
	return (
		<Dialog.Section>
			<Account name="Backup">
				<Text className="text-secondary">Your chats and skills in a file. Keys are not in it.</Text>
				{chosen ? (
					<>
						<Text>
							Import {what}? They replace the same data in FigPal. Then FigPal starts again.
						</Text>
						<div className="flex gap-2">
							<Button disabled={busy} onClick={() => setChosen(undefined)}>
								Cancel
							</Button>
							<Button variant="primary" disabled={busy} onClick={() => void importChosen()}>
								Import
							</Button>
						</div>
					</>
				) : (
					<div className="flex gap-2">
						<Button disabled={busy} onClick={() => void exportAll()}>
							Export
						</Button>
						<Button disabled={busy} onClick={() => input.current?.click()}>
							Import…
						</Button>
						<input
							ref={input}
							type="file"
							accept=".jsonl"
							aria-label="Backup file"
							hidden
							onChange={(event) => {
								choose(event.target.files?.[0]);
								event.target.value = "";
							}}
						/>
					</div>
				)}
				{error && (
					<Text role="alert" className="text-danger">
						{error}
					</Text>
				)}
			</Account>
		</Dialog.Section>
	);
}
