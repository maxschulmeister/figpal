// Settings → Access: the local helper, the folders that it shares with FigPal's agent, and MCP for outside agents. Each
// is a section with the header of the accounts: the name, and its status on the right.

import type { FolderChange } from "@figpal/shared/local";
import { Button, CloseIcon, Dialog, IconButton, Label, Switch, Text, Tooltip } from "figma-kit";
import { type ReactNode, useId, useState } from "react";
import { Account, errorText } from "./accounts";
import type { LocalState } from "./local";
import type { Settings } from "./settings";

export function LocalHelperSettings(props: {
	settings: Settings;
	local: LocalState;
	onChange(change: Partial<Settings>): void;
	onChangeFolders(change: FolderChange): Promise<void>;
}) {
	const { settings, local } = props;
	const [note, setNote] = useState("");
	const change = (folders: FolderChange) =>
		props.onChangeFolders(folders).then(
			() => setNote(""),
			(error) => setNote(errorText(error)),
		);

	return (
		<>
			{/* FigPal cannot pick or keep a folder of the Mac, or start an agent's helper: the local helper does it. */}
			<Dialog.Section>
				<Account name="Local helper" status={local.manage ? "Running" : "Not running"}>
					<Text className="text-secondary">Shares folders of this Mac with the agent, and connects agents such as Claude Code.</Text>
					{!local.manage && (
						<>
							<Text className="text-secondary">Run this once in the FigPal repo:</Text>
							<CopyCommand command="pnpm local:install" />
						</>
					)}
				</Account>
			</Dialog.Section>
			<Dialog.Section>
				<Account name="Shared folders">
					<Text className="text-secondary">The agent can read and write these folders, with their subfolders.</Text>
					{local.folders.length > 0 && (
						<ul className="flex flex-col">
							{local.folders.map((name) => (
								<li key={name} className="flex items-center justify-between gap-2">
									<Text className="truncate">{name}</Text>
									<Tooltip content="Remove">
										<IconButton aria-label={`Remove ${name}`} onClick={() => void change({ op: "remove", name })}>
											<CloseIcon />
										</IconButton>
									</Tooltip>
								</li>
							))}
						</ul>
					)}
					<Button variant="secondary" className="self-start" disabled={!local.manage} onClick={() => void change({ op: "add" })}>
						Add folders
					</Button>
					<SwitchRow label="Share Home" checked={local.home} disabled={!local.manage} onChange={(on) => void change({ op: "home", on })}>
						<span className="text-warning">
							The agent can then read and change all your files, including credentials if present. Use with caution.
						</span>
					</SwitchRow>
					{note && (
						<Text role="alert" className="text-danger">
							{note}
						</Text>
					)}
				</Account>
			</Dialog.Section>
			<Dialog.Section>
				<Account name="MCP" status={local.agent ? "Connected" : "Not connected"}>
					<SwitchRow label="Enable" checked={settings.outsideAgents} onChange={(outsideAgents) => props.onChange({ outsideAgents })}>
						Let agents on this Mac, such as Claude Code, use this file.
					</SwitchRow>
					<CopyCommand command="claude mcp add figpal -- figpal-mcp" />
					<Text className="text-secondary">
						The install adds FigPal to Claude Code. For Codex, write <code>codex</code> instead of <code>claude</code>.
					</Text>
				</Account>
			</Dialog.Section>
		</>
	);
}

/** A switch on the right of its label, with a hint under the label. */
function SwitchRow(props: { label: string; checked: boolean; disabled?: boolean; onChange(checked: boolean): void; children: ReactNode }) {
	const id = useId();
	return (
		<div className="flex items-start gap-2">
			<span className="flex min-w-0 flex-1 flex-col">
				<Label htmlFor={`${id}-switch`}>{props.label}</Label>
				<Text id={id} className="text-secondary">
					{props.children}
				</Text>
			</span>
			<Switch
				id={`${id}-switch`}
				className="mt-0.5 shrink-0"
				aria-describedby={id}
				checked={props.checked}
				disabled={props.disabled}
				onCheckedChange={props.onChange}
			/>
		</div>
	);
}

/** A command for Terminal, with a Copy button. */
function CopyCommand({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		await navigator.clipboard.writeText(command).catch(() => {
			// The plugin window can block the clipboard API: the older way works there.
			const area = Object.assign(document.createElement("textarea"), { value: command });
			document.body.append(area);
			area.select();
			document.execCommand("copy");
			area.remove();
		});
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};
	return (
		<div className="flex items-center gap-2">
			<Text className="min-w-0 flex-1">
				<code className="block break-all px-2 py-1">{command}</code>
			</Text>
			<Button variant="secondary" className="shrink-0" onClick={() => void copy()}>
				{copied ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}
