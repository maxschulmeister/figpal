// Settings → Access: the folders that the local helper shares with FigPal's agent, and MCP for outside agents.

import type { FolderChange } from "@figpal/shared/local";
import { Button, CloseIcon, IconButton, Label, Switch, Text, Tooltip } from "figma-kit";
import { useId, useState } from "react";
import { errorText } from "./accounts";
import type { LocalState } from "./local";
import type { Settings } from "./settings";

export function LocalHelperSettings(props: {
	settings: Settings;
	local: LocalState;
	onChange(change: Partial<Settings>): void;
	onChangeFolders(change: FolderChange): Promise<void>;
}) {
	const { settings, local } = props;
	const homeHint = useId();
	const mcpHint = useId();
	const [note, setNote] = useState("");
	const [copied, setCopied] = useState(false);
	const change = (folders: FolderChange) =>
		props.onChangeFolders(folders).then(
			() => setNote(""),
			(error) => setNote(errorText(error)),
		);
	const command = `claude mcp add figpal -- ${local.command ?? "node <FigPal repo>/local/cli.ts --mcp"}`;
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
		<div className="flex flex-col gap-3">
			<Text weight="strong">Shared folders</Text>
			{!local.manage ? (
				<Text className="text-secondary">
					The agent can read and write folders of this Mac. To share them, run <code>pnpm local:install</code> in the FigPal repo.
				</Text>
			) : (
				<>
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
					<Button variant="secondary" className="self-start" onClick={() => void change({ op: "add" })}>
						Add folders
					</Button>
					<div className="flex items-start gap-2">
						<Switch
							id={`${homeHint}-switch`}
							className="mt-0.5 shrink-0"
							aria-describedby={homeHint}
							checked={local.home}
							onCheckedChange={(on) => void change({ op: "home", on })}
						/>
						<span className="flex min-w-0 flex-col">
							<Label htmlFor={`${homeHint}-switch`}>Share the home folder</Label>
							<Text id={homeHint} className="text-secondary">
								The agent can then read and change all your files, also keys and passwords. Text in a Figma file can tell it to.
							</Text>
						</span>
					</div>
					{note && (
						<Text role="alert" className="text-danger">
							{note}
						</Text>
					)}
				</>
			)}
			<Text weight="strong" className="mt-2">
				MCP
			</Text>
			<div className="flex items-start gap-2">
				<Switch
					id={`${mcpHint}-switch`}
					className="mt-0.5 shrink-0"
					aria-describedby={mcpHint}
					checked={settings.outsideAgents}
					onCheckedChange={(outsideAgents) => props.onChange({ outsideAgents })}
				/>
				<span className="flex min-w-0 flex-col">
					<Label htmlFor={`${mcpHint}-switch`}>Enable MCP</Label>
					<Text id={mcpHint} className="text-secondary">
						An agent on this Mac, such as Claude Code, can run code in this file through FigPal. <code>pnpm local:install</code> adds
						FigPal to Claude Code; for another agent, use this command.
						{local.agent && " An agent is connected."}
					</Text>
				</span>
			</div>
			<div className="flex items-start gap-2">
				<Text className="min-w-0 flex-1">
					<code className="block break-all px-2 py-1">{command}</code>
				</Text>
				<Button variant="secondary" className="shrink-0" onClick={() => void copy()}>
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
		</div>
	);
}
