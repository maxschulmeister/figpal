// Start-up and everything around the chat: the threads, the accounts and the settings.

import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AgentChange, Conversation, ConversationId, EntryId, Harness, SubmissionId } from "@earendil-works/pi-durable";
import type { FileInfo } from "@figpal/shared";
import {
	Button,
	ChevronDownIcon,
	ChevronLeftIcon,
	Dialog,
	EyeClosedIcon,
	IconButton,
	Paragraph,
	PlusIcon,
	SegmentedControl,
	SlidersIcon,
	Tabs,
	Text,
	Tooltip,
} from "figma-kit";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Accounts, errorText, FIGMA, TokenAccount } from "./accounts";
import { createAgentModels, openAgent } from "./agent";
import type { Bridge } from "./bridge";
import { Chat } from "./chat";
import { uiCredentials } from "./credentials";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { enabledModelGroups, loadSettings, PROVIDERS, type Settings, saveSettings, TEXT_SIZES, type TextSize, textModel } from "./settings";
import { chipLabels } from "./node-chips";
import { SkillsPanel } from "./skills-panel";
import { connectLocal, type LocalFiles, type LocalState } from "./local";
import { LocalHelperSettings } from "./local-panel";
import { installDefaultSkills } from "./skills/defaults";
import { EnabledModels, TextModel } from "./enabled-models";
import { ThreadList, threadTitle } from "./thread-list";
import {
	currentThread,
	archiveThread,
	forkThread,
	nameThread,
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

/** The agent of a new thread: the saved model, or the default model of the first connected provider. */
function newThreadAgent({ model, thinkingLevel }: Settings, connected: ReadonlySet<string>): AgentChange | undefined {
	if (connected.has(model.provider)) return { model, thinkingLevel };
	const provider = PROVIDERS.find((item) => connected.has(item.id));
	return provider && { model: { provider: provider.id, modelId: provider.defaultModel }, thinkingLevel };
}

/** Errors of actions after the start: the chat stays open. */
const report = (error: unknown) => console.error("FigPal:", error);
const NO_LOCAL: LocalState = { folders: [], manage: false, home: false };

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
	const credentials = useMemo(() => uiCredentials(bridge), [bridge]);
	const models = useMemo(() => createAgentModels(credentials, location.origin), [credentials]);
	// The models for subagents: the enabled models of the connected providers. The agent reads them when it needs them,
	// from the newest settings, without a code.js call.
	const allowedModels = useRef<string[]>([]);
	useEffect(() => {
		if (!settings || !connected) return;
		allowedModels.current = enabledModelGroups(models, connected, settings.enabledModels).flatMap(({ provider, models: list }) =>
			list.map((model) => `${provider.id}/${model.id}`),
		);
	}, [models, settings, connected]);

	const fail = useCallback((error: unknown) => setPhase({ kind: "failed", message: errorText(error) }), []);
	const [local, setLocal] = useState<LocalState>(NO_LOCAL);
	const outsideAgents = useRef(false);
	outsideAgents.current = settings?.outsideAgents ?? false;
	/** The connection to the local helpers, and the folder listeners of the agent: the agent starts before the connection. */
	const [localLink] = useState(() => ({
		connection: undefined as ReturnType<typeof connectLocal> | undefined,
		folders: [] as string[],
		listeners: new Set<(folders: string[]) => void>(),
	}));
	// FigPal looks for helpers once it knows the file: an outside agent can choose the file by its name.
	const fileName = file?.fileName;
	useEffect(() => {
		if (fileName === undefined) return;
		const connection = connectLocal({
			bridge,
			file: fileName,
			allowAgents: () => outsideAgents.current,
			onChange: (state) => {
				setLocal(state);
				localLink.folders = state.folders;
				for (const listener of localLink.listeners) listener(state.folders);
			},
		});
		localLink.connection = connection;
		return () => {
			connection.stop();
			localLink.connection = undefined;
		};
	}, [bridge, fileName, localLink]);


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
			}
			// The first chip of a new chat comes from the last selection of the user.
			else if (event.type === "selection" && !event.byAgent)
				setFile((current) => current && { ...current, selection: event.selection, selectionCount: event.selectionCount });
			else if (event.type === "page") setFile((current) => current && { ...current, page: event.page });
		});
		bridge.ready();
		return () => {
			stop();
			clearTimeout(timer);
		};
	}, [bridge]);

	const fileId = file?.fileId;
	// The key does not change while FigPal runs: it is part of the file's ID when code.js can read it.
	const fileKey = file?.fileKey ?? null;
	useEffect(() => {
		if (!fileId) return;
		// In the background: the Skills tab shows an error.
		installDefaultSkills().catch((error) => console.warn("FigPal: default skills:", error));
		void refreshConnected();
		loadSettings(bridge).then(setSettings, fail);
		const local = {
			files: (request: Parameters<LocalFiles>[0]) =>
				localLink.connection?.files(request) ?? Promise.reject(new Error("FigPal is not connected to a local helper.")),
			subscribe: (listener: (folders: string[]) => void) => {
				localLink.listeners.add(listener);
				listener(localLink.folders);
			},
		};
		openAgent(fileId, { models, bridge, credentials, fileKey, subagentModels: () => allowedModels.current, local }).then(
			// The first failure stays: a later result must not hide it.
			(harness) =>
				setPhase((current) =>
					current.kind === "failed" ? current : harness === "locked" ? { kind: "locked" } : { kind: "ready", harness },
				),
			fail,
		);
	}, [fileId, fileKey, models, bridge, credentials, refreshConnected, fail, localLink]);

	const harness = phase.kind === "ready" ? phase.harness : undefined;

	const openConversation = useCallback(
		async (id: ConversationId) => (harness ? harness.conversation(id, context) : undefined),
		[harness],
	);
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

	const updateSettings = (change: Partial<Settings>) => {
		const next = { ...settings, ...change };
		setSettings(next);
		saveSettings(bridge, next).catch(report);
	};

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
	/**
	 * Hides the panel. When no chat and no subagent works, the notice says so; code.js changes the notice only while the
	 * panel is hidden.
	 */
	const hide = () =>
		bridge
			.request("background", { message: "FigPal works in the background." })
			.then(() => harness.waitForIdle(context))
			.then(() => bridge.request("background", { message: "FigPal is done.", update: true }))
			.catch(report);

	return (
		<div className="flex h-full flex-col">
			<header className="flex h-10 shrink-0 items-center gap-1 border-b border-default px-2">
				{showThreads ? (
					<>
						<Tooltip content="Back">
							<IconButton aria-label="Back to the chat" onClick={() => setShowThreads(false)}>
								<ChevronLeftIcon />
							</IconButton>
						</Tooltip>
						<Text weight="strong">Chats</Text>
					</>
				) : (
					// figma-kit's Button does not shrink: a long title would push the icons out of the window.
					<Button variant="text" className="min-w-0 shrink gap-1" onClick={() => setShowThreads(true)}>
						<span className="truncate">{threadTitle(current)}</span>
						<ChevronDownIcon size="4" />
					</Button>
				)}
				<div className="ml-auto flex shrink-0 gap-1">
					<Tooltip content="New chat">
						<IconButton aria-label="New chat" onClick={() => run(() => newThread(harness, agent))}>
							<PlusIcon />
						</IconButton>
					</Tooltip>
					<Tooltip content="Run in the background">
						<IconButton aria-label="Run in the background" onClick={() => void hide()}>
							<EyeClosedIcon />
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
						onArchive={(id) =>
							run(async () => {
								const next = await archiveThread(harness, id, agent);
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
							bridge={bridge}
							models={models}
							connected={connected}
							enabledModels={settings.enabledModels}
							openExternal={openExternal}
							fork={(at: EntryId) => run(() => forkThread(thread, at, current?.title ?? ""))}
							openConversation={openConversation}
							onSend={(text, submission) => {
								const label = chipLabels(text);
								// After the first answer, the text generation model names the chat.
								noteMessage(harness, thread.id, label)
									.then(async (first) => {
										if (!first) return;
										const chat = (await thread.agent(context)).model ?? settings.model;
										const model = textModel(models, connected, settings.textModel, chat);
										const thinking = model && clampThinkingLevel(model, settings.textThinking);
										if (model && thinking) await nameThread(harness, submission, label, { models, model, thinking });
									})
									.catch(report);
							}}
							abortSubmission={(id) => harness.abortSubmission(Number(id) as SubmissionId, context, thread.id)}
							textSize={settings.textSize}
							onModelChange={updateSettings}
							onEditModels={() => {
								setSettingsTab("models");
								setSettingsOpen(true);
							}}
						/>
					)
				)}
			</main>
			<Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
				<Dialog.Portal>
					<Dialog.Popup size="fullscreen" className="flex flex-col">
						{/* Both panels stay mounted: a tab switch must not stop a login or an install. */}
						<Tabs.Root value={settingsTab} onValueChange={setSettingsTab} className="flex min-h-0 flex-1 flex-col">
							{/* "‹ Settings", as "‹ Chats" in the chat list: an X here would sit under the X of the plugin window. */}
							<Dialog.Header className="gap-1 px-2">
								<Tooltip content="Back">
									<Dialog.Close aria-label="Back to the chat">
										<ChevronLeftIcon />
									</Dialog.Close>
								</Tooltip>
								<Dialog.Title>Settings</Dialog.Title>
								<Tabs.List className="ml-auto">
									<Tabs.Tab value="models">Models</Tabs.Tab>
									<Tabs.Tab value="skills">Skills</Tabs.Tab>
									<Tabs.Tab value="figma">Access</Tabs.Tab>
								</Tabs.List>
							</Dialog.Header>
							<Tabs.Panel value="models" keepMounted className="min-h-0 flex-1 overflow-y-auto data-[hidden]:hidden">
								<Dialog.Section>{accounts}</Dialog.Section>
								<Dialog.Section>
									<EnabledModels
										models={models}
										connected={connected}
										value={settings.enabledModels}
										onChange={(enabledModels) => updateSettings({ enabledModels })}
									/>
								</Dialog.Section>
								<Dialog.Section>
									<TextModel
										models={models}
										connected={connected}
										value={settings}
										onChange={updateSettings}
									/>
								</Dialog.Section>
								<Dialog.Section>
									<div className="flex items-center justify-between gap-2">
										<Text weight="strong" id="text-size">
											Text size
										</Text>
										<SegmentedControl.Root
											aria-labelledby="text-size"
											value={settings.textSize}
											onValueChange={(textSize) => updateSettings({ textSize: textSize as TextSize })}
										>
											{TEXT_SIZES.map((size) => (
												<SegmentedControl.Item key={size} value={size}>
													<SegmentedControl.Text>{size[0]!.toUpperCase() + size.slice(1)}</SegmentedControl.Text>
												</SegmentedControl.Item>
											))}
										</SegmentedControl.Root>
									</div>
								</Dialog.Section>
							</Tabs.Panel>
							<Tabs.Panel value="skills" keepMounted className="min-h-0 flex-1 overflow-y-auto data-[hidden]:hidden">
								<Dialog.Section>
									<SkillsPanel />
								</Dialog.Section>
							</Tabs.Panel>
							<Tabs.Panel value="figma" keepMounted className="min-h-0 flex-1 overflow-y-auto data-[hidden]:hidden">
								<Dialog.Section>
									<TokenAccount kind={FIGMA} connected={connected} credentials={credentials} onChange={refreshConnected} />
								</Dialog.Section>
								<LocalHelperSettings
									settings={settings}
									local={local}
									onChange={updateSettings}
									onChangeFolders={(change) => localLink.connection?.changeFolders(change) ?? Promise.resolve()}
								/>
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
