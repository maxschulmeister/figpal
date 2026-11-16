// The update of the FigPal command: a notice under the header when FigPal opens, and the version in Settings → General.
// After the update, the plugin must run again: Figma loads code.js only at the start of the plugin.

import { INSTALL_COMMAND } from "@figpal/shared";
import { Button, Dialog, Text } from "figma-kit";
import { useEffect, useState } from "react";
import { Account, errorText } from "./accounts";
import { CopyCommand } from "./local-panel";
import { CLOSED_KEY, latestVersion, runningVersion, startUpdate, updateVersion } from "./update";

/** How often FigPal asks for the version of the command after Update. */
const POLL_MS = 2000;

type Step = { kind: "idle" } | { kind: "started" } | { kind: "manual"; error?: string } | { kind: "done" };

export type UpdateState = {
	running?: string;
	/** The newer version on npm. */
	version?: string;
	/** The newer version, unless the user closed its notice. */
	notice?: string;
	step: Step;
	update(): void;
	close(): void;
};

/** Compares the versions once, when FigPal opens. After Update, it waits until the new command runs. */
export function useUpdate(): UpdateState {
	const [versions, setVersions] = useState<{ running?: string; latest?: string }>({});
	const [closed, setClosed] = useState(() => localStorage.getItem(CLOSED_KEY) ?? undefined);
	const [step, setStep] = useState<Step>({ kind: "idle" });
	useEffect(() => {
		void Promise.all([runningVersion(), latestVersion()]).then(([running, latest]) => setVersions({ running, latest }));
	}, []);
	const waiting = step.kind === "started" || step.kind === "manual";
	const { running, latest } = versions;
	useEffect(() => {
		if (!waiting) return;
		// The install stops the command for some seconds: then the request fails.
		const timer = setInterval(() => void runningVersion().then((now) => now && now !== running && setStep({ kind: "done" })), POLL_MS);
		return () => clearInterval(timer);
	}, [waiting, running]);
	const version = running && latest ? updateVersion(running, latest) : undefined;
	return {
		running,
		version,
		notice: running && latest ? updateVersion(running, latest, closed) : undefined,
		step,
		update: () => {
			// At once: a second click must not start a second install.
			setStep({ kind: "started" });
			startUpdate().then(
				({ started }) => {
					if (!started) setStep({ kind: "manual" });
				},
				(error) => setStep({ kind: "manual", error: errorText(error) }),
			);
		},
		close: () => {
			if (version) localStorage.setItem(CLOSED_KEY, version);
			setClosed(version);
		},
	};
}

const LINES: Record<Step["kind"], (version: string) => string> = {
	idle: (version) => `FigPal ${version} is available.`,
	started: (version) => `Terminal installs FigPal ${version}.`,
	manual: () => "In Terminal, run this command:",
	done: (version) => `FigPal ${version} is installed. Run FigPal again in Figma.`,
};

/** The command to copy, when FigPal cannot start the update. */
function Manual({ step }: { step: Step }) {
	if (step.kind !== "manual") return null;
	return (
		<>
			{step.error && (
				<Text role="alert" className="text-danger">
					{step.error}
				</Text>
			)}
			<CopyCommand command={INSTALL_COMMAND} />
		</>
	);
}

/** Under the header, until the user closes it. */
export function UpdateNotice({ update }: { update: UpdateState }) {
	if (!update.notice) return null;
	return (
		<div role="status" className="flex shrink-0 flex-col gap-2 border-b border-default px-3 py-2">
			<div className="flex items-center gap-2">
				<Text className="min-w-0 flex-1">{LINES[update.step.kind](update.notice)}</Text>
				{/* Later: until the next version. After Update, the notice has only a result to close. */}
				<Button onClick={update.close}>{update.step.kind === "idle" ? "Later" : "Close"}</Button>
				{update.step.kind === "idle" && (
					<Button variant="primary" onClick={update.update}>
						Update
					</Button>
				)}
			</div>
			<Manual step={update.step} />
		</div>
	);
}

/** Settings → General: the version, and Update also after the user closed the notice. */
export function UpdateSettings({ update }: { update: UpdateState }) {
	if (!update.running) return null;
	return (
		<Dialog.Section>
			<Account name="FigPal">
				<div className="flex items-center gap-2">
					<Text className="min-w-0 flex-1">Version {update.running}</Text>
					{update.version && update.step.kind === "idle" && (
						<Button variant="secondary" onClick={update.update}>
							Update
						</Button>
					)}
				</div>
				{update.version && (
					<Text role="status" className="text-secondary">
						{LINES[update.step.kind](update.version)}
					</Text>
				)}
				<Manual step={update.step} />
			</Account>
		</Dialog.Section>
	);
}
