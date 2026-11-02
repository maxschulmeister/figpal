// Settings → Access: the local helper, the folders that it shares with FigPal's agent, and MCP for outside agents. Each
// is a section with the header of the accounts: the name, and its status on the right.

import type { FolderChange } from "@figpal/shared/local";
import {
	Button,
	CheckmarkIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CloseIcon,
	Dialog,
	IconButton,
	Label,
	Select,
	Switch,
	Text,
	Tooltip,
} from "figma-kit";
import { type ReactNode, useId, useState } from "react";
import { Account, errorText, status } from "./accounts";
import type { LocalState } from "./local";
import type { Settings } from "./settings";

const json = (value: object) => JSON.stringify(value, null, 2);
const MCP_SERVERS = json({ mcpServers: { figpal: { command: "figpal-mcp" } } });

/**
 * How each agent adds FigPal's MCP server, the figpal-mcp command of `pnpm local:install`. From their docs (2026-11);
 * the commands of OpenCode and Droid were tried. `file`: the agent has no command, the user adds the JSON there.
 */
const AGENTS: { value: string; label: string; setup: string; file?: string }[] = [
	{ value: "claude", label: "Claude Code", setup: "claude mcp add --scope user figpal -- figpal-mcp" },
	{ value: "codex", label: "Codex", setup: "codex mcp add figpal -- figpal-mcp" },
	{ value: "opencode", label: "OpenCode", setup: "opencode mcp add figpal -- figpal-mcp" },
	{ value: "cursor", label: "Cursor", setup: MCP_SERVERS, file: "~/.cursor/mcp.json" },
	{ value: "devin", label: "Devin", setup: "devin mcp add --scope user figpal -- figpal-mcp" },
	{ value: "pi", label: "pi", setup: "pi mcp add figpal -- figpal-mcp" },
	{ value: "copilot", label: "Copilot CLI", setup: "copilot mcp add figpal -- figpal-mcp" },
	{ value: "zed", label: "Zed", setup: json({ context_servers: { figpal: { command: "figpal-mcp", args: [] } } }), file: "the settings.json of Zed" },
	{ value: "droid", label: "Droid", setup: "droid mcp add figpal figpal-mcp" },
	{ value: "cline", label: "Cline", setup: "cline mcp add figpal -- figpal-mcp" },
	{ value: "manual", label: "Manual", setup: MCP_SERVERS, file: "the MCP config of your agent" },
];

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
				<Account name="Local helper" status={status(local.manage, ["Running", "Not running"])}>
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
				<Account name="MCP" status={status(local.agent, ["Connected", "Not connected"])}>
					<SwitchRow label="Enable" checked={settings.outsideAgents} onChange={(outsideAgents) => props.onChange({ outsideAgents })} />
					<AgentSetup />
				</Account>
			</Dialog.Section>
		</>
	);
}

/** The setup of FigPal's MCP server for the agent that the user picks. */
function AgentSetup() {
	const [agent, setAgent] = useState<string | null>("claude");
	const chosen = AGENTS.find((item) => item.value === agent) ?? AGENTS[0]!;
	return (
		<>
			<Select.Root items={AGENTS} value={agent} onValueChange={setAgent}>
				<Select.Trigger aria-label="Agent" className="self-start">
					<Select.Value />
					<Select.Icon>
						<ChevronDownIcon />
					</Select.Icon>
				</Select.Trigger>
				<Select.Portal>
					<Select.Positioner>
						<Select.Popup>
							<Select.ScrollUpArrow>
								<ChevronUpIcon />
							</Select.ScrollUpArrow>
							<Select.List>
								{AGENTS.map((item) => (
									<Select.Item key={item.value} value={item.value}>
										<Select.ItemIndicator>
											<CheckmarkIcon size="4" />
										</Select.ItemIndicator>
										<Select.ItemText>{item.label}</Select.ItemText>
									</Select.Item>
								))}
							</Select.List>
							<Select.ScrollDownArrow>
								<ChevronDownIcon />
							</Select.ScrollDownArrow>
						</Select.Popup>
					</Select.Positioner>
				</Select.Portal>
			</Select.Root>
			{chosen.file && <Text className="text-secondary">Add this to {chosen.file}:</Text>}
			<CopyCommand command={chosen.setup} />
		</>
	);
}

/** A switch on the right of its label, with a hint under the label. */
function SwitchRow(props: { label: string; checked: boolean; disabled?: boolean; onChange(checked: boolean): void; children?: ReactNode }) {
	const id = useId();
	return (
		<div className="flex items-start gap-2">
			<span className="flex min-w-0 flex-1 flex-col">
				<Label htmlFor={`${id}-switch`}>{props.label}</Label>
				{props.children && (
					<Text id={id} className="text-secondary">
						{props.children}
					</Text>
				)}
			</span>
			<Switch
				id={`${id}-switch`}
				className="mt-0.5 shrink-0"
				aria-describedby={props.children ? id : undefined}
				checked={props.checked}
				disabled={props.disabled}
				onCheckedChange={props.onChange}
			/>
		</div>
	);
}

/** A command for Terminal or a piece of JSON, with a Copy button. */
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
		<div className="flex items-start gap-2">
			<Text className="min-w-0 flex-1">
				<code className="block whitespace-pre-wrap break-all px-2 py-1">{command}</code>
			</Text>
			<Button variant="secondary" className="shrink-0" onClick={() => void copy()}>
				{copied ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}
