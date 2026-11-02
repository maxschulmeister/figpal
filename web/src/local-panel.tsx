// Settings → Access: the folders that the local helper shares with FigPal's agent, and MCP for outside agents.

import type { FolderChange } from "@figpal/shared/local";
import { Button, CloseIcon, IconButton, Label, Switch, Text, Tooltip } from "figma-kit";
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
		<div className="flex flex-col gap-4">
			{/* FigPal cannot pick or keep a folder of the Mac: the helper does it. */}
			{!local.manage && (
				<Text className="text-secondary">
					Run <code>pnpm local:install</code> in the FigPal repo once. It starts the local helper, which shares your folders, and adds
					the <code>figpal-mcp</code> command for agents.
				</Text>
			)}
			<Account name="Shared folders">
				{local.folders.length === 0 ? (
					<Text className="text-secondary">No shared folders. The agent can read and write the folders that you add, with their subfolders.</Text>
				) : (
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
				<SwitchRow
					label="Share the home folder"
					checked={local.home}
					disabled={!local.manage}
					onChange={(on) => void change({ op: "home", on })}
				>
					The agent can then read and change all your files, also keys and passwords. Text in a Figma file can tell it to.
				</SwitchRow>
				{note && (
					<Text role="alert" className="text-danger">
						{note}
					</Text>
				)}
			</Account>
			<Account name="MCP" status={local.agent ? "Connected" : "Not connected"}>
				<SwitchRow label="Enable" checked={settings.outsideAgents} onChange={(outsideAgents) => props.onChange({ outsideAgents })}>
					Let agents on this Mac, such as Claude Code, use this file. To add FigPal to an agent:{" "}
					<code>&lt;agent&gt; mcp add figpal -- figpal-mcp</code>
				</SwitchRow>
			</Account>
		</div>
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
