// Start-up and everything around the chat: the threads, the accounts and the settings.

import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AgentChange, Conversation, ConversationId, EntryId, Harness } from "@earendil-works/pi-durable";
import { type FileInfo, UI_ORIGINS, type UiSource } from "@figpal/shared";
import {
	Button,
	ChevronDownIcon,
	ChevronLeftIcon,
	Dialog,
	IconButton,
	Paragraph,
	PlusIcon,
	SlidersIcon,
	Tabs,
	Text,
	Tooltip,
} from "figma-kit";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Accounts, errorText } from "./accounts";
import { createAgentModels, openAgent } from "./agent";
import type { Bridge } from "./bridge";
import { Chat } from "./chat";
import { clientStorageCredentials } from "./credentials";
import { loadSettings, PROVIDERS, type Settings, saveSettings } from "./settings";
import { SkillsPanel } from "./skills-panel";
import { installDefaultSkills } from "./skills/defaults";
import { ThreadList, threadTitle } from "./thread-list";
import {
	currentThread,
	deleteThread,
	forkThread,
	newThread,
	noteMessage,
	renameThread,
	selectThread,
	type ThreadList as List,
	Threads,
} from "./threads";

type Phase =
	| { kind: "starting" }
	| { kind: "failed"; message: string }
	| { kind: "locked" }
	| { kind: "ready"; harness: Harness };

const INIT_TIMEOUT_MS = 5000;
/** The UI source of this page: the remote UI (VPS) or the local UI (Vite dev server). */
const uiSource = (Object.keys(UI_ORIGINS) as UiSource[]).find((source) => UI_ORIGINS[source] === location.origin);

/** The agent of a new thread: the saved model, or the default model of the first connected provider. */
function newThreadAgent(settings: Settings, connected: ReadonlySet<string>): AgentChange | undefined {
	if (connected.has(settings.model.provider)) return settings;
	const provider = PROVIDERS.find((item) => connected.has(item.id));
	return provider && { ...settings, model: { provider: provider.id, modelId: provider.defaultModel } };
}

/** Errors of actions after the start: the chat stays open. */
const report = (error: unknown) => console.error("FigPal:", error);

export function App({ bridge }: { bridge: Bridge }) {
	const [phase, setPhase] = useState<Phase>({ kind: "starting" });
	const [file, setFile] = useState<FileInfo>();
	const [connected, setConnected] = useState<ReadonlySet<string>>();
	const [settings, setSettings] = useState<Settings>();
	const [thread, setThread] = useState<Conversation>();
	const [list, setList] = useState<List>();
	const [showThreads, setShowThreads] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsTab, setSettingsTab] = useState<string>("models");
	const busy = useRef(false);
	const credentials = useMemo(() => clientStorageCredentials(bridge), [bridge]);
	const models = useMemo(() => createAgentModels(credentials, location.origin), [credentials]);

	const fail = useCallback((error: unknown) => setPhase({ kind: "failed", message: errorText(error) }), []);
	const openExternal = useCallback(
		(url: string) => bridge.request("open-external", { url }).catch((error) => console.error("FigPal:", error)),
		[bridge],
	);
	const refreshConnected = useCallback(
		() => credentials.list().then((list) => setConnected(new Set(list.map((info) => info.providerId))), fail),
		[credentials, fail],
	);

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
		// In the background: the Skills tab shows an error.
		installDefaultSkills().catch((error) => console.warn("FigPal: default skills:", error));
		void refreshConnected();
		loadSettings(bridge).then(setSettings, fail);
		openAgent(fileId, { models, bridge }).then(
			// The first failure stays: a later result must not hide it.
			(harness) =>
				setPhase((current) =>
					current.kind === "failed" ? current : harness === "locked" ? { kind: "locked" } : { kind: "ready", harness },
				),
			fail,
		);
	}, [fileId, models, bridge, refreshConnected, fail]);

	const harness = phase.kind === "ready" ? phase.harness : undefined;
	const ready = harness !== undefined && settings !== undefined && connected !== undefined;
	// Undefined until a provider is connected, so that the first thread gets a model that works.
	const agent = useMemo(() => settings && connected && newThreadAgent(settings, connected), [settings, connected]);

	// The open thread, once. Later changes come from the thread actions.
	useEffect(() => {
		if (!harness || !agent || thread) return;
		currentThread(harness, agent).then(setThread, fail);
	}, [harness, agent, thread, fail]);

	// The thread list exists once a thread is open (currentThread makes it).
	const hasThread = thread !== undefined;
	useEffect(() => {
		if (!harness || !hasThread) return;
		let state: AttachedReplicatedState<Readonly<List> | null> | undefined;
		let closed = false;
		harness.documentState(Threads, context).then((attached) => {
			if (closed) return attached?.dispose();
			state = attached;
			attached?.subscribe((value) => setList(value ?? undefined));
		}, fail);
		return () => {
			closed = true;
			state?.dispose();
		};
	}, [harness, hasThread, fail]);

	if (phase.kind === "failed") return <Notice>{phase.message}</Notice>;
	if (phase.kind === "locked")
		return <Notice>FigPal is open for this file in another window. Close it, then run FigPal again.</Notice>;
	if (!ready || !file) return null;

	const accounts = (
		<Accounts connected={connected} models={models} credentials={credentials} openExternal={openExternal} onChange={refreshConnected} />
	);
	if (!agent)
		return (
			<div className="flex h-full flex-col justify-center gap-4 p-6">
				<Text size="large" weight="strong">
					Connect a model
				</Text>
				{accounts}
			</div>
		);

	/** One thread action at a time: a double click must not make two threads. Then the chat shows, or the list stays. */
	const run = (action: () => Promise<Conversation>, showChat = true) => {
		if (busy.current) return;
		busy.current = true;
		action()
			.then((next) => {
				setThread(next);
				if (showChat) setShowThreads(false);
			}, fail)
			.finally(() => {
				busy.current = false;
			});
	};
	const current = list?.threads.find((info) => info.id === thread?.id);
	const otherUi: UiSource = uiSource === "local" ? "remote" : "local";

	return (
		<div className="flex h-full flex-col">
			<header className="flex h-10 shrink-0 items-center gap-1 border-b border-default px-2">
				{showThreads ? (
					<>
						<IconButton aria-label="Back to the chat" onClick={() => setShowThreads(false)}>
							<ChevronLeftIcon />
						</IconButton>
						<Text weight="strong">Chats</Text>
					</>
				) : (
					<Button variant="text" className="min-w-0 gap-1" onClick={() => setShowThreads(true)}>
						<span className="truncate">{threadTitle(current)}</span>
						<ChevronDownIcon size="4" />
					</Button>
				)}
				<div className="ml-auto flex gap-1">
					<Tooltip content="New chat">
						<IconButton aria-label="New chat" onClick={() => run(() => newThread(harness, agent))}>
							<PlusIcon />
						</IconButton>
					</Tooltip>
					<Tooltip content="Settings">
						<IconButton aria-label="Settings" onClick={() => setSettingsOpen(true)}>
							<SlidersIcon />
						</IconButton>
					</Tooltip>
				</div>
			</header>
			<main className="min-h-0 flex-1 overflow-y-auto">
				{showThreads && list ? (
					<ThreadList
						list={list}
						onOpen={(id: ConversationId) =>
							id === thread?.id ? setShowThreads(false) : run(() => selectThread(harness, id))
						}
						onRename={(id, title) => renameThread(harness, id, title).catch(report)}
						// Keep the handle of the open thread, so that its chat does not load again.
						onDelete={(id) =>
							run(async () => {
								const next = await deleteThread(harness, id, agent);
								return next.id === thread?.id ? thread : next;
							}, false)
						}
					/>
				) : (
					thread && (
						<Chat
							key={thread.id}
							thread={thread}
							file={file}
							models={models}
							connected={connected}
							openExternal={openExternal}
							fork={(at: EntryId) => run(() => forkThread(thread, at, current?.title ?? ""))}
							onSend={(text) => noteMessage(harness, thread.id, text).catch(report)}
							onModelChange={(next) => {
								setSettings(next);
								saveSettings(bridge, next).catch(report);
							}}
						/>
					)
				)}
			</main>
			<Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
				<Dialog.Portal>
					<Dialog.Popup size="fullscreen" aria-label="Settings" className="flex flex-col">
						{/* Both panels stay mounted: a tab switch must not stop a login or an install. */}
						<Tabs.Root value={settingsTab} onValueChange={setSettingsTab} className="flex min-h-0 flex-1 flex-col">
							<Dialog.Header>
								<Tabs.List>
									<Tabs.Tab value="models">Models</Tabs.Tab>
									<Tabs.Tab value="skills">Skills</Tabs.Tab>
								</Tabs.List>
								<Dialog.Controls>
									<Dialog.Close />
								</Dialog.Controls>
							</Dialog.Header>
							<Tabs.Panel value="models" keepMounted className="min-h-0 flex-1 overflow-y-auto data-[hidden]:hidden">
								<Dialog.Section>{accounts}</Dialog.Section>
								<Dialog.Section>
									<div className="flex items-center justify-between gap-2">
										<Text className="text-secondary">This window uses the {uiSource} UI.</Text>
										<Button onClick={() => bridge.switchUi(otherUi)}>Use the {otherUi} UI</Button>
									</div>
								</Dialog.Section>
							</Tabs.Panel>
							<Tabs.Panel value="skills" keepMounted className="min-h-0 flex-1 overflow-y-auto data-[hidden]:hidden">
								<Dialog.Section>
									<SkillsPanel />
								</Dialog.Section>
							</Tabs.Panel>
						</Tabs.Root>
					</Dialog.Popup>
				</Dialog.Portal>
			</Dialog.Root>
		</div>
	);
}

function Notice({ children }: { children: ReactNode }) {
	return (
		<div className="flex h-full items-center justify-center p-6 text-center">
			<Paragraph>{children}</Paragraph>
		</div>
	);
}
