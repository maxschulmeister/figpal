// Settings → Access: the local helper (local/cli.ts), which shares folders with FigPal and lets outside agents in.

import { Label, Switch, Text } from "figma-kit";
import { useId } from "react";
import type { LocalState } from "./local";
import type { Settings } from "./settings";

export function LocalHelperSettings(props: {
	settings: Settings;
	local: LocalState & { connected: boolean };
	onChange(change: Partial<Settings>): void;
}) {
	const { settings, local } = props;
	const helperHint = useId();
	const agentHint = useId();
	const status = !settings.localHelper
		? "Shares folders of this machine with FigPal."
		: !local.connected
			? "Not found. Start it in the FigPal repo:"
			: local.folders.length
				? `Connected. Shared folders: ${local.folders.join(", ")}.`
				: "Connected, without shared folders.";
	return (
		<div className="flex flex-col gap-3">
			<Text weight="strong">Local helper</Text>
			<div className="flex items-start gap-2">
				<Switch
					id={`${helperHint}-switch`}
					className="mt-0.5 shrink-0"
					aria-describedby={helperHint}
					checked={settings.localHelper}
					// Without the helper, no outside agent can come in: the second switch goes off too.
					onCheckedChange={(localHelper) => props.onChange({ localHelper, ...(!localHelper && { outsideAgents: false }) })}
				/>
				<span className="flex min-w-0 flex-col">
					<Label htmlFor={`${helperHint}-switch`}>Connect to a local helper</Label>
					<Text id={helperHint} className="text-secondary">
						{status} {settings.localHelper && !local.connected && <code>node local/cli.ts --folder &lt;path&gt;</code>}
					</Text>
				</span>
			</div>
			<div className="flex items-start gap-2">
				<Switch
					id={`${agentHint}-switch`}
					className="mt-0.5 shrink-0"
					aria-describedby={agentHint}
					checked={settings.outsideAgents}
					disabled={!settings.localHelper}
					onCheckedChange={(outsideAgents) => props.onChange({ outsideAgents })}
				/>
				<span className="flex min-w-0 flex-col">
					<Label htmlFor={`${agentHint}-switch`}>Enable MCP</Label>
					<Text id={agentHint} className="text-secondary">
						An agent on this machine, such as Claude Code, can run code in this file through FigPal. Add it with{" "}
						<code>claude mcp add figpal -- node &lt;FigPal repo&gt;/local/cli.ts --mcp</code>.
					</Text>
				</span>
			</div>
		</div>
	);
}
