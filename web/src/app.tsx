// Start-up and everything around the chat: the Claude token and the menu.

import { type FileInfo, UI_ORIGINS, type UiSource } from "@figpal/shared";
import { Button, Dialog, DropdownMenu, EllipsisIcon, IconButton, Input, Paragraph, Text, Tooltip } from "figma-kit";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { type Agent, createAgentModels, openAgent } from "./agent";
import type { Bridge } from "./bridge";
import { Chat } from "./chat";
import { clientStorageCredentials } from "./credentials";

type Phase =
	| { kind: "starting" }
	| { kind: "failed"; message: string }
	| { kind: "locked" }
	| { kind: "ready"; agent: Agent };

const INIT_TIMEOUT_MS = 5000;
/** The UI source of this page: the remote UI (VPS) or the local UI (Vite dev server). */
const uiSource = (Object.keys(UI_ORIGINS) as UiSource[]).find((source) => UI_ORIGINS[source] === location.origin);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function App({ bridge }: { bridge: Bridge }) {
	const [phase, setPhase] = useState<Phase>({ kind: "starting" });
	const [file, setFile] = useState<FileInfo>();
	const [hasToken, setHasToken] = useState<boolean>();
	const [tokenDialog, setTokenDialog] = useState(false);
	const credentials = useMemo(() => clientStorageCredentials(bridge), [bridge]);

	useEffect(() => {
		if (window.parent === window) {
			setPhase({ kind: "failed", message: "Open FigPal from the Plugins menu in Figma Desktop." });
			return;
		}
		const timer = setTimeout(
			() => setPhase({ kind: "failed", message: "The plugin did not answer. Run FigPal again." }),
			INIT_TIMEOUT_MS,
		);
		const stop = bridge.onEvent((event) => {
			if (event.type === "init") {
				clearTimeout(timer);
				setFile(event.file);
			} else if (event.type === "selection") setFile((current) => current && { ...current, selection: event.selection });
			else if (event.type === "page") setFile((current) => current && { ...current, page: event.page });
		});
		bridge.ready();
		return () => {
			stop();
			clearTimeout(timer);
		};
	}, [bridge]);

	const fileId = file?.fileId;
	useEffect(() => {
		if (!fileId) return;
		// The first failure stays: a later result must not hide it.
		const fail = (error: unknown) => setPhase({ kind: "failed", message: errorText(error) });
		credentials.read("anthropic").then((credential) => setHasToken(credential !== undefined), fail);
		openAgent(fileId, { models: createAgentModels(credentials, location.origin), bridge }).then(
			(agent) =>
				setPhase((current) =>
					current.kind === "failed" ? current : agent === "locked" ? { kind: "locked" } : { kind: "ready", agent },
				),
			fail,
		);
	}, [fileId, credentials, bridge]);

	const saveToken = async (token: string) => {
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: token }));
		setHasToken(true);
	};
	const removeToken = async () => {
		await credentials.delete("anthropic");
		setHasToken(false);
	};

	if (phase.kind === "failed") return <Notice>{phase.message}</Notice>;
	if (phase.kind === "locked")
		return <Notice>FigPal is open for this file in another window. Close it, then run FigPal again.</Notice>;
	if (phase.kind === "starting" || !file || hasToken === undefined) return null;
	if (!hasToken)
		return (
			<div className="flex h-full flex-col justify-center gap-3 p-6">
				<Text size="large" weight="strong">
					Connect Claude
				</Text>
				<TokenForm onSave={saveToken} />
			</div>
		);

	const otherUi: UiSource = uiSource === "local" ? "remote" : "local";
	const menu = (
		<DropdownMenu.Root>
			<Tooltip content="More">
				<DropdownMenu.Trigger render={<IconButton aria-label="More" />}>
					<EllipsisIcon />
				</DropdownMenu.Trigger>
			</Tooltip>
			<DropdownMenu.Portal>
				<DropdownMenu.Positioner sideOffset={6} align="end">
					<DropdownMenu.Popup style={{ minWidth: 180 }}>
						<DropdownMenu.Item onClick={() => setTokenDialog(true)}>Claude token…</DropdownMenu.Item>
						<DropdownMenu.Item onClick={() => bridge.switchUi(otherUi)}>Use the {otherUi} UI</DropdownMenu.Item>
					</DropdownMenu.Popup>
				</DropdownMenu.Positioner>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);

	return (
		<>
			<Chat
				agent={phase.agent}
				file={file}
				menu={menu}
				openExternal={(url) => bridge.request("open-external", { url }).catch((error) => console.error("FigPal:", error))}
			/>
			<Dialog.Root open={tokenDialog} onOpenChange={setTokenDialog}>
				<Dialog.Portal>
					<Dialog.Backdrop />
					<Dialog.Popup placement="center">
						<Dialog.Header>
							<Dialog.Title>Claude token</Dialog.Title>
							<Dialog.Controls>
								<Dialog.Close />
							</Dialog.Controls>
						</Dialog.Header>
						<Dialog.Section>
							<TokenForm
								onSave={async (token) => {
									await saveToken(token);
									setTokenDialog(false);
								}}
								onRemove={async () => {
									await removeToken();
									setTokenDialog(false);
								}}
							/>
						</Dialog.Section>
					</Dialog.Popup>
				</Dialog.Portal>
			</Dialog.Root>
		</>
	);
}

function Notice({ children }: { children: ReactNode }) {
	return (
		<div className="flex h-full items-center justify-center p-6 text-center">
			<Paragraph>{children}</Paragraph>
		</div>
	);
}

function TokenForm({ onSave, onRemove }: { onSave(token: string): Promise<void>; onRemove?(): Promise<void> }) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string>();

	const submit = (event: FormEvent) => {
		event.preventDefault();
		// A token copied from Terminal can contain line breaks. Tokens never contain white space.
		const token = value.replace(/\s+/g, "");
		if (!token.startsWith("sk-ant-")) {
			setError("This is not a Claude token. It starts with sk-ant-.");
			return;
		}
		onSave(token).catch((reason) => setError(errorText(reason)));
	};

	return (
		<form className="flex flex-col gap-3" onSubmit={submit}>
			<Paragraph>
				In Terminal, run <code>claude setup-token</code>. Then paste the token here.
			</Paragraph>
			<Input
				type="password"
				aria-label="Claude token"
				placeholder="sk-ant-oat01-…"
				value={value}
				onChange={(event) => {
					setValue(event.target.value);
					setError(undefined);
				}}
			/>
			{error && <Text className="text-danger">{error}</Text>}
			<div className="flex justify-end gap-2">
				{onRemove && (
					<Button type="button" onClick={() => onRemove().catch((reason) => setError(errorText(reason)))}>
						Remove token
					</Button>
				)}
				<Button type="submit" variant="primary" disabled={!value.trim()}>
					Save
				</Button>
			</div>
		</form>
	);
}
