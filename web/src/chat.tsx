// The chat: assistant-ui primitives on the pi-durable conversation, with figma-kit's look.

import {
	type Attachment,
	AttachmentPrimitive,
	AssistantRuntimeProvider,
	AuiIf,
	ComposerPrimitive,
	type EmptyMessagePartProps,
	ErrorPrimitive,
	MessageNotSentError,
	MessagePrimitive,
	type ReasoningMessagePartComponent,
	QueueItemPrimitive,
	ThreadPrimitive,
	type ThreadMessageLike,
	type ToolCallMessagePartComponent,
	type ToolCallMessagePartProps,
	useAui,
	useAuiState,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent, ModelThinkingLevel, Static, TextContent } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import type { AgentState, Conversation, ConversationId, ConversationView, EntryId } from "@earendil-works/pi-durable";
import type { FileInfo } from "@figpal/shared";
import {
	Button,
	CheckmarkIcon,
	ChevronDownIcon,
	CloseIcon,
	Collapsible,
	createIcon,
	DropdownMenu,
	IconButton,
	PlusIcon,
	Text,
	Tooltip,
} from "figma-kit";
import { type ComponentProps, createContext, Fragment, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_HIGH, PASTE_COMMAND } from "lexical";
import { ACCEPT, attachable, attachmentAdapter, isLongText } from "./attachments";
import remarkGfm from "remark-gfm";
import { userInput } from "./agent";
import { inboxQueue, textOf } from "./queue";
import { type AuditDetails, STATUS_LABELS } from "./audit";
import type { Bridge } from "./bridge";
import { errorText } from "./accounts";
import { exportNodes, type NODE_EXPORT } from "./extensions/figma";
import type { SubagentDetails } from "./extensions/subagent";
import { downloadFile, type FileDetails, type FileRef, fileById, fileSize, keepFiles } from "./files";
import type { PillDetails } from "./lint";
import { nodeIdsOfLink } from "./node-chips";
import { ChipText, NodeChip, SelectionChips } from "./selection-chips";
import { enabledModelGroups, type Settings, type TextSize } from "./settings";
import { exportTokens, type TokenExport } from "./tokens";
import { type Thread, toThread } from "./transcript";

type ModelChoice = Pick<Settings, "model" | "thinkingLevel">;

const SendIcon = createIcon({
	displayName: "SendIcon",
	path: <path fill="var(--color-icon)" d="M12 6.3 17.35 11.65l-.7.7L12.5 8.2V18h-1V8.2l-4.15 4.15-.7-.7Z" />,
});
const StopIcon = createIcon({
	displayName: "StopIcon",
	path: <rect fill="var(--color-icon)" x="8" y="8" width="8" height="8" rx="1" />,
});

type Actions = {
	/** Opens a link in the browser: the plugin window cannot open one. */
	openExternal(url: string): void;
	/** Opens a new thread with the history up to the entry. Absent in a subagent transcript. */
	fork?(at: EntryId): void;
	/** A conversation of this file, for the transcript of a subagent. */
	openConversation(id: ConversationId): Promise<Conversation | undefined>;
	/** Makes the files of an export again, without the agent: they are gone after a restart. Undefined for other tools. */
	exportAgain(toolName: string, args: unknown): (() => Promise<FileRef[]>) | undefined;
	/** Selects the layers on the canvas and zooms to them. Gives the number that it selected. */
	selectNodes(nodeIds: string[]): Promise<number>;
};
const ChatActions = createContext<Actions>({
	openExternal() {},
	openConversation: async () => undefined,
	exportAgain: () => undefined,
	selectNodes: async () => 0,
});

const TOOL_LABELS: Record<string, string> = {
	figma_execute: "Run code",
	figma_screenshot: "Screenshot",
	figma_rest: "Figma API",
	figma_export_tokens: "Export tokens",
	figma_export_nodes: "Export layers",
	figma_diff_versions: "Compare versions",
	figma_audit_design_system: "Audit design system",
	figma_lint: "Check layers",
	figma_animation_frames: "Check animation",
	subagent: "Subagents",
};

/** The messages of the conversation, with its changes. Undefined until they are loaded. */
function useThread(conversation: Conversation | undefined, onError: (message: string) => void): Thread | undefined {
	const [view, setView] = useState<ConversationView>();
	useEffect(() => {
		if (!conversation) return;
		let state: AttachedReplicatedState<ConversationView> | undefined;
		let closed = false;
		conversation.viewState(context).then(
			(attached) => {
				if (closed) return attached.dispose();
				state = attached;
				// It also gives the current value at once.
				attached.subscribe(setView);
			},
			(error) => onError(String(error)),
		);
		return () => {
			closed = true;
			state?.dispose();
		};
	}, [conversation, onError]);
	return useMemo(() => (view ? toThread(view) : undefined), [view]);
}

/** The messages are already in the assistant-ui format. A stable function keeps assistant-ui's message cache. */
const asIs = (message: ThreadMessageLike) => message;

type ChatProps = Omit<Actions, "exportAgain" | "selectNodes"> & {
	thread: Conversation;
	file: FileInfo;
	/** The selection events of code.js, for the chips in the composer, and its variables for a token export. */
	bridge: Pick<Bridge, "onEvent" | "request">;
	models: Models;
	/** Provider IDs with a saved credential: the model picker shows their models. */
	connected: ReadonlySet<string>;
	/** The enabled models in the settings: the model picker shows only these. */
	enabledModels: string[];
	/** A message was sent. */
	onSend(text: string): void;
	/** Withdraws a waiting message of this chat. The ID is pi-durable's submission ID as text (assistant-ui's IDs). */
	abortSubmission(id: string): Promise<string>;
	textSize: TextSize;
	/** The user picked a model or thinking level. New threads use it too. */
	onModelChange(choice: ModelChoice): void;
	/** Opens Settings → Models. */
	onEditModels(): void;
};

export function Chat(props: ChatProps) {
	const { thread: conversation, file } = props;
	const [failure, setFailure] = useState<string>();
	const thread = useThread(conversation, setFailure);
	const [sendError, setSendError] = useState<string>();
	// Images need a model that reads them: the adapter asks at each image.
	const readsImages = useRef(true);
	const model = thread?.agent?.model;
	readsImages.current = !model || (props.models.getModel(model.provider, model.modelId)?.input.includes("image") ?? true);
	const attachments = useMemo(() => attachmentAdapter(() => readsImages.current), []);
	const { abortSubmission, onSend } = props;
	// While the agent works, or while messages wait: without a queue, assistant-ui sends with onNew, which puts the text
	// back when the message cannot be sent.
	const busy = thread !== undefined && (thread.isRunning || thread.queue.steer.length + thread.queue.followUp.length > 0);
	const queue = useMemo(
		() =>
			thread && busy
				? inboxQueue({
						queue: thread.queue,
						input: (message) => userInput(textOf(message), file, message.attachments),
						submit: (input, mode) => {
							const text = (input.entry?.data as { text?: string } | undefined)?.text ?? "";
							void conversation.submit({ type: "input", ...input, whenBusy: mode }, context).then(
								() => {
									setSendError(undefined);
									onSend(text);
								},
								(error) => setSendError(`FigPal could not send "${text}": ${errorText(error)}`),
							);
						},
						abort: abortSubmission,
					})
				: undefined,
		[thread, busy, conversation, file, onSend, abortSubmission],
	);
	const runtime = useExternalStoreRuntime<ThreadMessageLike>({
		queue,
		adapters: { attachments },
		messages: thread?.messages ?? [],
		convertMessage: asIs,
		isRunning: thread?.isRunning,
		isLoading: thread === undefined,
		onNew: async (message) => {
			const text = textOf(message);
			try {
				await conversation.submit(userInput(text, file, message.attachments), context);
				props.onSend(text);
			} catch (error) {
				console.error("FigPal could not send the message:", error);
				// assistant-ui puts the text back into the message field.
				throw new MessageNotSentError(String(error));
			}
		},
		onCancel: () => conversation.abort(context),
	});
	const { bridge } = props;
	const actions = useMemo(
		() => ({
			openExternal: props.openExternal,
			fork: props.fork,
			openConversation: props.openConversation,
			// The tools ran with these arguments, after the Harness checked them.
			exportAgain: (toolName: string, args: unknown) => {
				if (toolName === "figma_export_tokens") return async () => keepFiles((await exportTokens(bridge, args as TokenExport)).files);
				if (toolName === "figma_export_nodes") return async () => keepFiles(await exportNodes(bridge, args as Static<typeof NODE_EXPORT>));
				return undefined;
			},
			selectNodes: async (nodeIds: string[]) => (await bridge.request("select", { nodeIds })).result.count,
		}),
		[props.openExternal, props.fork, props.openConversation, bridge],
	);

	if (failure) return <p className="p-6 text-danger">Cannot open the chat: {failure}</p>;
	const retry = thread?.retry;

	return (
		<ChatActions.Provider value={actions}>
			<AssistantRuntimeProvider runtime={runtime}>
				<ThreadPrimitive.Root className="flex h-full flex-col" data-text-size={props.textSize}>
					{/* relative: the scroll area clips the absolute screen-reader texts of its chips; else the page grows. */}
					<ThreadPrimitive.Viewport className="relative flex flex-1 flex-col gap-4 overflow-y-auto px-4 pt-4">
						<AuiIf condition={(state) => state.thread.isEmpty}>
							<p className="m-auto text-lg text-secondary">Ask FigPal to read or change this file.</p>
						</AuiIf>
						<ThreadPrimitive.Messages>{renderMessage}</ThreadPrimitive.Messages>
						<ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto flex flex-col gap-1 bg-default pb-2">
							{retry && <p className="text-secondary">The model call failed and runs again soon: {retry.error}</p>}
							{sendError && <p className="text-danger">{sendError}</p>}
							{thread && <WaitingMessages queue={thread.queue} />}
							<Composer>
								<LexicalComposerInput
									autoFocus
									placeholder="Ask FigPal"
									directiveChip={NodeChip}
									className="chat-text max-h-40 min-w-0 flex-1 px-2 py-1"
								>
									<SelectionChips bridge={props.bridge} initial={file} />
									<PasteFiles />
								</LexicalComposerInput>
								{/* While the agent works: Send for a typed message (it steers), and Stop. */}
								<AuiIf condition={(state) => !state.thread.isRunning || !state.composer.isEmpty}>
									<ComposerPrimitive.Send asChild>
										<IconButton aria-label="Send">
											<SendIcon />
										</IconButton>
									</ComposerPrimitive.Send>
								</AuiIf>
								<AuiIf condition={(state) => state.thread.isRunning}>
									<ComposerPrimitive.Cancel asChild>
										<IconButton aria-label="Stop">
											<StopIcon />
										</IconButton>
									</ComposerPrimitive.Cancel>
								</AuiIf>
							</Composer>
							<div className="flex items-center gap-1">
								<ModelPicker
									conversation={conversation}
									agent={thread?.agent}
									models={props.models}
									connected={props.connected}
									enabledModels={props.enabledModels}
									onChange={props.onModelChange}
									onEditModels={props.onEditModels}
								/>
								{/* The right end; mr-3 keeps it off the resize grip in the corner. */}
								<div className="mr-3 ml-auto flex shrink-0 items-center">
									<ContextUsage tokens={thread?.contextTokens} model={thread?.agent?.model} models={props.models} />
								</div>
							</div>
						</ThreadPrimitive.ViewportFooter>
					</ThreadPrimitive.Viewport>
				</ThreadPrimitive.Root>
			</AssistantRuntimeProvider>
		</ChatActions.Provider>
	);
}

/** Adds files to the composer, or says why not: the "+" button, paste and drop use it. */
const AddFiles = createContext<(files: Iterable<File>) => void>(() => {});

/**
 * The composer. Enter sends; while the agent works it steers (assistant-ui). Cmd+Enter sends after the answer. Files
 * come from the "+" button, paste and drop.
 */
function Composer({ children }: { children: ReactNode }) {
	const aui = useAui();
	const chooser = useRef<HTMLInputElement>(null);
	// A note about files shows until the next message: it keeps the number of messages when it came.
	const messages = useAuiState((state) => state.thread.messages.length);
	const [noteOf, setNoteOf] = useState<{ text: string; messages: number }>();
	const note = noteOf?.messages === messages ? noteOf.text : "";
	const setNote = (text: string) => setNoteOf({ text, messages });
	const addFiles = (files: Iterable<File>) => {
		setNote("");
		for (const file of files) {
			const refused = attachable(file);
			if (refused) setNote(refused);
			else aui.composer.addAttachment(file).catch((error: unknown) => setNote(errorText(error)));
		}
	};
	return (
		<AddFiles.Provider value={addFiles}>
			{note && (
				<Text role="alert" className="text-danger">
					{note}
				</Text>
			)}
			<ComposerPrimitive.Root
				className="flex flex-col gap-1 rounded-md border border-default p-1 focus-within:border-selected"
				// Before Lexical, which would add a line.
				onKeyDownCapture={(event) => {
					if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.nativeEvent.isComposing) return;
					event.preventDefault();
					event.stopPropagation();
					if (aui.composer.getState().canSend) aui.composer.send({ steer: false });
				}}
				onDragOver={(event) => {
					if (event.dataTransfer.types.includes("Files")) event.preventDefault();
				}}
				onDrop={(event) => {
					if (event.dataTransfer.files.length === 0) return;
					event.preventDefault();
					addFiles(event.dataTransfer.files);
				}}
			>
				<ComposerFiles />
				<div className="flex items-end gap-1">
					<Tooltip content="Add files">
						{/* type="button": in the form of the composer, a button sends the message. */}
						<IconButton type="button" aria-label="Add files" onClick={() => chooser.current?.click()}>
							<PlusIcon />
						</IconButton>
					</Tooltip>
					<input
						ref={chooser}
						type="file"
						multiple
						hidden
						accept={ACCEPT}
						onChange={(event) => {
							addFiles(event.target.files ?? []);
							event.target.value = "";
						}}
					/>
					{children}
				</div>
			</ComposerPrimitive.Root>
		</AddFiles.Provider>
	);
}

/** Pasted files become attachments, and so does long pasted text (2,000 characters or 30 lines). */
function PasteFiles() {
	const [editor] = useLexicalComposerContext();
	const addFiles = useContext(AddFiles);
	useEffect(
		() =>
			editor.registerCommand(
				PASTE_COMMAND,
				(event) => {
					const data = event instanceof ClipboardEvent ? event.clipboardData : null;
					if (!data) return false;
					const text = data.getData("text/plain");
					const files = data.files.length > 0 ? [...data.files] : isLongText(text) ? [new File([text], "Pasted text.txt", { type: "text/plain" })] : [];
					if (files.length === 0) return false;
					event.preventDefault();
					addFiles(files);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
		[editor, addFiles],
	);
	return null;
}

/** The attachments in the composer, with Remove. */
function ComposerFiles() {
	const count = useAuiState((state) => state.composer.attachments.length);
	if (count === 0) return null;
	return (
		<ul aria-label="Attachments" className="flex flex-wrap gap-1">
			<ComposerPrimitive.Attachments>{({ attachment }) => <FileChip attachment={attachment} removable />}</ComposerPrimitive.Attachments>
		</ul>
	);
}

/** The attachments of a sent message. */
function SentFiles() {
	const count = useAuiState((state) => state.message.attachments?.length ?? 0);
	if (count === 0) return null;
	return (
		<ul aria-label="Attachments of the message" className="flex flex-wrap justify-end gap-1">
			<MessagePrimitive.Attachments>{({ attachment }) => <FileChip attachment={attachment} />}</MessagePrimitive.Attachments>
		</ul>
	);
}

/** An attachment: a small preview of an image, and the name. */
function FileChip({ attachment, removable }: { attachment: Attachment; removable?: boolean }) {
	const sent = attachment.content?.find((part) => part.type === "image")?.image;
	const [preview, setPreview] = useState<string>();
	const file = attachment.type === "image" && !sent ? attachment.file : undefined;
	useEffect(() => {
		if (!file) return;
		const url = URL.createObjectURL(file);
		setPreview(url);
		return () => URL.revokeObjectURL(url);
	}, [file]);
	const image = sent ?? preview;
	return (
		<li className="flex min-w-0 items-center gap-1 rounded-md border border-default bg-default py-0.5 pr-0.5 pl-1 whitespace-normal">
			{image && <img src={image} alt="" className="size-5 shrink-0 rounded-sm object-cover" />}
			<Text className="min-w-0 truncate">{attachment.name}</Text>
			{removable ? (
				<AttachmentPrimitive.Remove asChild>
					<IconButton aria-label={`Remove ${attachment.name}`}>
						<CloseIcon />
					</IconButton>
				</AttachmentPrimitive.Remove>
			) : (
				<span className="w-1" />
			)}
		</li>
	);
}

/** The messages that wait while the agent works: a steer goes in after the current tool step, a follow-up after the answer. */
function WaitingMessages({ queue }: { queue: Thread["queue"] }) {
	if (queue.steer.length + queue.followUp.length === 0) return null;
	const steer = new Set(queue.steer.map((message) => message.id));
	return (
		<ul aria-label="Waiting messages" className="flex flex-col gap-1">
			<ComposerPrimitive.Queue>
				{({ queueItem }) => (
					<li className="flex items-center gap-2 rounded-md bg-secondary py-0.5 pr-0.5 pl-2">
						<Text className="min-w-0 flex-1 truncate">
							<QueueItemPrimitive.Text />
						</Text>
						<Text className="shrink-0 text-secondary">{steer.has(queueItem.id) ? "Next" : "After the answer"}</Text>
						{!steer.has(queueItem.id) && (
							<QueueItemPrimitive.Steer asChild>
								<Button variant="text">Send now</Button>
							</QueueItemPrimitive.Steer>
						)}
						<Tooltip content="Remove">
							<QueueItemPrimitive.Remove asChild>
								<IconButton aria-label="Remove">
									<CloseIcon />
								</IconButton>
							</QueueItemPrimitive.Remove>
						</Tooltip>
					</li>
				)}
			</ComposerPrimitive.Queue>
		</ul>
	);
}

const THINKING_LABELS: Record<ModelThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/** 1,234 as "1.2k", 45,300 as "45k", 1,000,000 as "1M". */
function tokenCount(tokens: number): string {
	const [value, unit] = tokens >= 1e6 ? [tokens / 1e6, "M"] : tokens >= 1e3 ? [tokens / 1e3, "k"] : [tokens, ""];
	return `${value >= 10 || !unit ? Math.round(value) : Number(value.toFixed(1))}${unit}`;
}

/** How much of the context window the conversation fills: the size of its newest request. A short bar; the numbers in
 * the tooltip. A used context never shows 0 %. */
function ContextUsage(props: { tokens: number | undefined; model: AgentState["model"] | undefined; models: Models }) {
	const window = props.model && props.models.getModel(props.model.provider, props.model.modelId)?.contextWindow;
	if (props.tokens === undefined || !window) return null;
	const percent = Math.min(100, Math.ceil((props.tokens / window) * 100));
	return (
		<Tooltip content={`${tokenCount(props.tokens)} / ${tokenCount(window)} tokens (${percent}%)`}>
			<span data-testid="context-usage" className="flex h-6 shrink-0 items-center">
				<span aria-hidden="true" className="h-1 w-8 overflow-hidden rounded-full bg-tertiary">
					<span className="block h-full rounded-full bg-[var(--color-icon-secondary)]" style={{ width: `${percent}%` }} />
				</span>
				<span className="sr-only">
					Context: {props.tokens.toLocaleString("en-US")} of {window.toLocaleString("en-US")} tokens
				</span>
			</span>
		</Tooltip>
	);
}

/** The model and thinking level of the thread. pi-durable uses "off" when the thread has no thinking level. */
function ModelPicker(props: {
	conversation: Conversation;
	agent: AgentState | undefined;
	models: Models;
	connected: ReadonlySet<string>;
	enabledModels: string[];
	onChange(choice: ModelChoice): void;
	/** Opens Settings → Models. */
	onEditModels(): void;
}) {
	const ref = props.agent?.model;
	const thinkingLevel = props.agent?.thinkingLevel ?? "off";
	const model = ref && props.models.getModel(ref.provider, ref.modelId);
	// A model without reasoning has only "off".
	const levels = model ? getSupportedThinkingLevels(model) : [];
	const canThink = ref !== undefined && levels.length > 1;

	// Saved for new threads only when the thread took it.
	const choose = (next: ModelChoice) =>
		props.conversation.configure(next, context).then(
			() => props.onChange(next),
			(error) => console.error("FigPal could not change the model:", error),
		);
	const chooseModel = (provider: string, modelId: string) => {
		const next = props.models.getModel(provider, modelId);
		// The nearest level that the new model has, as pi-ai sends it.
		if (next) void choose({ model: { provider, modelId }, thinkingLevel: clampThinkingLevel(next, thinkingLevel) });
	};

	return (
		<>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger render={<Button variant="text" className="gap-1 text-secondary" />}>
					{model?.name ?? "Model"}
					<ChevronDownIcon size="4" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Positioner side="top" align="start" sideOffset={4}>
						<DropdownMenu.Popup style={{ minWidth: 220 }}>
							{enabledModelGroups(props.models, props.connected, props.enabledModels).map(({ provider, models }, index) => (
								<DropdownMenu.RadioGroup
									key={provider.id}
									value={ref?.provider === provider.id ? ref.modelId : ""}
									onValueChange={(modelId: string) => chooseModel(provider.id, modelId)}
								>
									{index > 0 && <DropdownMenu.Separator />}
									<DropdownMenu.GroupLabel>{provider.label}</DropdownMenu.GroupLabel>
									{models.map((item) => (
										<DropdownMenu.RadioItem key={item.id} value={item.id} closeOnClick>
											<DropdownMenu.RadioItemIndicator>
												<CheckmarkIcon size="4" />
											</DropdownMenu.RadioItemIndicator>
											{item.name}
										</DropdownMenu.RadioItem>
									))}
								</DropdownMenu.RadioGroup>
							))}
							<DropdownMenu.Separator />
							<DropdownMenu.Item onClick={props.onEditModels}>Edit Models</DropdownMenu.Item>
						</DropdownMenu.Popup>
					</DropdownMenu.Positioner>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			{canThink && (
				<DropdownMenu.Root>
					<Tooltip content="Thinking">
						<DropdownMenu.Trigger
							aria-label={`Thinking: ${THINKING_LABELS[thinkingLevel]}`}
							render={<Button variant="text" className="gap-1 text-secondary" />}
						>
							{THINKING_LABELS[thinkingLevel]}
							<ChevronDownIcon size="4" />
						</DropdownMenu.Trigger>
					</Tooltip>
					<DropdownMenu.Portal>
						<DropdownMenu.Positioner side="top" align="start" sideOffset={4}>
							<DropdownMenu.Popup style={{ minWidth: 140 }}>
								<DropdownMenu.RadioGroup
									value={thinkingLevel}
									onValueChange={(level: ModelThinkingLevel) => void choose({ model: ref, thinkingLevel: level })}
								>
									{levels.map((level) => (
										<DropdownMenu.RadioItem key={level} value={level} closeOnClick>
											<DropdownMenu.RadioItemIndicator>
												<CheckmarkIcon size="4" />
											</DropdownMenu.RadioItemIndicator>
											{THINKING_LABELS[level]}
										</DropdownMenu.RadioItem>
									))}
								</DropdownMenu.RadioGroup>
							</DropdownMenu.Popup>
						</DropdownMenu.Positioner>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			)}
		</>
	);
}

const renderMessage = ({ message }: { message: { role: string } }) =>
	message.role === "user" ? <UserMessage /> : <AssistantMessage />;

function UserMessage() {
	return (
		<MessagePrimitive.Root className="chat-text ml-10 flex flex-col gap-1 self-end rounded-lg bg-secondary px-3 py-2 whitespace-pre-wrap break-words">
			<SentFiles />
			{/* One block: the chips and the text of the message are in one line. */}
			<div>
				<MessagePrimitive.Parts components={{ Text: ChipText }} />
			</div>
		</MessagePrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="chat-text group/message flex flex-col gap-3 break-words">
			<MessagePrimitive.Parts components={PARTS} />
			<MessagePrimitive.Error>
				<ErrorPrimitive.Root className="rounded-md bg-danger-tertiary px-3 py-2 text-danger">
					<ErrorPrimitive.Message />
				</ErrorPrimitive.Root>
			</MessagePrimitive.Error>
			<ForkButton />
		</MessagePrimitive.Root>
	);
}

/** Shown on hover, after the answer ended. */
function ForkButton() {
	const { fork } = useContext(ChatActions);
	const at = useAuiState((state) => state.message.metadata.custom.lastEntryId) as EntryId | undefined;
	const running = useAuiState((state) => state.thread.isRunning);
	if (!fork || at === undefined || running) return null;
	return (
		<div className="-mt-1 flex opacity-0 group-hover/message:opacity-100 focus-within:opacity-100">
			<Button variant="text" className="text-secondary" onClick={() => fork(at)}>
				Fork from here
			</Button>
		</div>
	);
}

/** assistant-ui also shows it after a tool call and on an empty answer, so it checks the status. */
function Working({ status }: EmptyMessagePartProps) {
	if (status.type !== "running") return null;
	return <span className="animate-pulse text-secondary">Working…</span>;
}

function ExternalLink({ href, children }: ComponentProps<"a">) {
	const { openExternal } = useContext(ChatActions);
	const nodeIds = nodeIdsOfLink(href);
	if (nodeIds) return <LayerLink nodeIds={nodeIds}>{children}</LayerLink>;
	return (
		<a
			href={href}
			onClick={(event) => {
				event.preventDefault();
				if (href?.startsWith("https://")) openExternal(href);
			}}
		>
			{children}
		</a>
	);
}

/**
 * Stable objects, so that markdown is not parsed again on each render. An image in an answer becomes a link: a
 * loaded image URL could send data out (for example after a prompt injection in the file) without a click.
 */
const MARKDOWN_COMPONENTS = {
	a: ExternalLink,
	img: ({ src, alt }: ComponentProps<"img">) => (
		<ExternalLink href={typeof src === "string" ? src : undefined}>{alt || "Image"}</ExternalLink>
	),
};
const REMARK_PLUGINS = [remarkGfm];

function MarkdownText() {
	return <MarkdownTextPrimitive className="markdown" remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS} />;
}

const Reasoning: ReasoningMessagePartComponent = ({ text }) => (
	<Collapsible.Root>
		<Collapsible.Trigger>Thinking</Collapsible.Trigger>
		<Collapsible.Panel>
			<p className="whitespace-pre-wrap text-secondary">{text}</p>
		</Collapsible.Panel>
	</Collapsible.Root>
);

/** The state of a tool call after its label. Empty when it ended without an error. */
const callState = ({ status, result, isError }: ToolCallMessagePartProps) =>
	status.type === "running" ? "running" : result === undefined ? "stopped" : isError ? "failed" : "";

/** The files that a Download made again, by tool call: the step can mount again, for example after a thread switch. */
const exportedAgain = new Map<string, FileRef[]>();

/**
 * The files of a tool result, to download. FigPal keeps them only until it closes. Then a Download of an export makes
 * all its files again, without the agent. Files that the agent's code made need the agent.
 */
function ToolFiles({
	callId,
	files,
	again,
	layers,
}: { callId: string; files: FileRef[]; again?: () => Promise<FileRef[]>; layers: boolean }) {
	const [current, setCurrent] = useState(() => exportedAgain.get(callId) ?? files);
	const [running, setRunning] = useState(false);
	const [failure, setFailure] = useState<string>();
	if (!again && !current.every((file) => fileById(file.id)))
		return (
			<Text className="pl-4 text-secondary">
				{current.length === 1 ? `${current[0]!.name} is` : "The files are"} no longer available. Ask to export again.
			</Text>
		);
	const download = async (file: FileRef) => {
		const kept = fileById(file.id);
		if (kept) return downloadFile(kept);
		setRunning(true);
		setFailure(undefined);
		try {
			const next = await again!();
			exportedAgain.set(callId, next);
			setCurrent(next);
			const same = next.find((made) => made.name === file.name);
			if (same) downloadFile(fileById(same.id)!);
			// For example, a layer or a collection has a new name.
			else setFailure("The file has changed, so the export is different now. Download the new files below.");
		} catch (error) {
			const reason = errorText(error);
			// The file of a layer export names the layer. An error of a token export is about the whole export.
			setFailure(layers ? `Cannot make ${file.name} again: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : reason);
		} finally {
			setRunning(false);
		}
	};
	return (
		<div className="flex flex-col gap-1 pl-4">
			<ul className="flex flex-col gap-1">
				{current.map((file) => (
					<li key={file.id} className="flex items-center gap-2">
						<span className="min-w-0 truncate">{file.name}</span>
						<span className="shrink-0 text-secondary">{fileSize(file.size)}</span>
						<Button className="shrink-0" disabled={running} onClick={() => void download(file)}>
							Download
						</Button>
					</li>
				))}
			</ul>
			{failure && <Text className="text-danger">{failure}</Text>}
		</div>
	);
}

/** The scores of a design-system audit, out of 100. The agent explains the findings. */
function AuditScores({ audit }: AuditDetails) {
	return (
		<dl className="grid w-fit grid-cols-[1fr_auto] gap-x-6 gap-y-1 pl-4 tabular-nums">
			<dt className="font-medium">Overall</dt>
			<dd className="text-right font-medium">
				{audit.overall}/100 · {STATUS_LABELS[audit.status]}
			</dd>
			{audit.categories.map(({ label, score }) => (
				<Fragment key={label}>
					<dt className="text-secondary">{label}</dt>
					<dd className={score === null ? "text-right text-secondary" : "text-right"}>{score ?? "No data"}</dd>
				</Fragment>
			))}
		</dl>
	);
}

/** A pill for each rule or finding: a click selects its layers, so that the user can check them. */
/** Selects layers on the canvas, for the pills and the layer chips. `note` says what went wrong. */
function useLayerSelect() {
	const { selectNodes } = useContext(ChatActions);
	const [running, setRunning] = useState(false);
	const [note, setNote] = useState<{ text: string; failed: boolean }>();
	const select = async (nodeIds: string[]) => {
		setRunning(true);
		setNote(undefined);
		try {
			const count = await selectNodes(nodeIds);
			// A selection has the layers of one page.
			if (count < nodeIds.length)
				setNote({ text: `Selected ${count} of ${nodeIds.length} layers. The others are on other pages or no longer exist.`, failed: false });
		} catch (error) {
			setNote({ text: errorText(error), failed: true });
		} finally {
			setRunning(false);
		}
	};
	return { select, running, note };
}

/** The start of the name of a select button: "Select 2 layers:". */
const selectPrefix = (count: number) => `Select ${count} ${count === 1 ? "layer" : "layers"}:`;

/** A layer chip in an answer of the agent, `[Card](#node=1:2)`: a click selects its layers. */
function LayerLink({ nodeIds, children }: { nodeIds: string[]; children: ReactNode }) {
	const { select, running, note } = useLayerSelect();
	return (
		<>
			<button type="button" className="node-chip" disabled={running} onClick={() => void select(nodeIds)}>
				{/* The name: "Select 1 layer: Card", also when the link text has formatting. */}
				<span className="sr-only">{selectPrefix(nodeIds.length)} </span>
				{children}
			</button>
			<span role="status" className={`ml-1 ${note?.failed ? "text-danger" : "text-secondary"}`}>
				{note && `(${note.text})`}
			</span>
		</>
	);
}

function ToolPills({ pills }: PillDetails) {
	const { select, running, note } = useLayerSelect();
	return (
		<div className="flex flex-col gap-1 pl-4">
			<div className="flex flex-wrap gap-1">
				{pills.map(({ label, nodeIds }) => (
					<Button
						key={label}
						aria-label={`${selectPrefix(nodeIds.length)} ${label}`}
						disabled={running}
						onClick={() => void select(nodeIds)}
					>
						{label} · {nodeIds.length}
					</Button>
				))}
			</div>
			<Text role="status" className={note?.failed ? "text-danger" : "text-secondary"}>
				{note?.text}
			</Text>
		</div>
	);
}

/** A tool call: its label and state, the files to download, and when opened, the arguments and the result. */
const ToolCall: ToolCallMessagePartComponent = (props) => {
	const { toolName, args, result, isError } = props;
	const { exportAgain } = useContext(ChatActions);
	const { files, audit, pills } = (props.artifact ?? {}) as Partial<FileDetails & AuditDetails & PillDetails>;
	const content = (result ?? []) as (TextContent | ImageContent)[];
	const state = callState(props);
	const code = typeof args.code === "string" ? args.code : JSON.stringify(args, null, 2);
	return (
		<Collapsible.Root>
			<Collapsible.Trigger>
				<span className={isError ? "text-danger" : undefined}>
					{TOOL_LABELS[toolName] ?? toolName}
					{state && <span className="text-secondary"> · {state}</span>}
				</span>
			</Collapsible.Trigger>
			{files && (
				<ToolFiles
					callId={props.toolCallId}
					files={files}
					again={exportAgain(toolName, args)}
					layers={toolName === "figma_export_nodes"}
				/>
			)}
			{audit && <AuditScores audit={audit} />}
			{pills && pills.length > 0 && <ToolPills pills={pills} />}
			<Collapsible.Panel>
				<div className="flex flex-col gap-2">
					{code !== "{}" && <pre className="overflow-x-auto rounded-md bg-secondary p-2 font-mono">{code}</pre>}
					{content.map((block, index) =>
						block.type === "image" ? (
							<img
								// biome-ignore lint/suspicious/noArrayIndexKey: a tool result does not change.
								key={index}
								alt="Tool result"
								className="max-w-full self-start rounded-md border border-default"
								src={`data:${block.mimeType};base64,${block.data}`}
							/>
						) : (
							// biome-ignore lint/suspicious/noArrayIndexKey: a tool result does not change.
							<pre key={index} className={`overflow-x-auto whitespace-pre-wrap font-mono ${isError ? "text-danger" : ""}`}>
								{block.text}
							</pre>
						),
					)}
				</div>
			</Collapsible.Panel>
		</Collapsible.Root>
	);
};

/** The subagent call: the transcript of each subagent. Before the subagents exist, the call as other calls. */
const SubagentCall: ToolCallMessagePartComponent = (props) => {
	const children = (props.artifact as SubagentDetails | undefined)?.children;
	if (!children) return <ToolCall {...props} />;
	const tasks = (props.args.tasks ?? []) as { task?: string }[];
	// After the subagents exist, the call fails only when it is stopped: the label says so.
	const state = callState(props);
	return (
		<div className="flex flex-col gap-1">
			<Text className={props.isError ? "text-danger" : "text-secondary"}>
				{children.length === 1 ? "1 subagent" : `${children.length} subagents`}
				{state && ` · ${state}`}
			</Text>
			<div className="flex flex-col gap-1 border-l border-default pl-3">
				{children.map((id, index) => (
					<Collapsible.Root key={id}>
						<Collapsible.Trigger>
							{/* One line while closed, all of the task while open. */}
							<span className="line-clamp-1 text-left in-data-[panel-open]:line-clamp-none">
								{tasks[index]?.task ?? `Task ${index + 1}`}
							</span>
						</Collapsible.Trigger>
						{/* The panel mounts its content only while it is open: a closed transcript loads nothing. */}
						<Collapsible.Panel>
							<SubagentTranscript id={id} />
						</Collapsible.Panel>
					</Collapsible.Root>
				))}
			</div>
		</div>
	);
};

/** The transcript of one subagent, read-only, with the components of the chat. */
function SubagentTranscript({ id }: { id: ConversationId }) {
	const actions = useContext(ChatActions);
	const { openConversation } = actions;
	const [conversation, setConversation] = useState<Conversation>();
	const [failure, setFailure] = useState<string>();
	useEffect(() => {
		openConversation(id).then(
			(found) => (found ? setConversation(found) : setFailure("The conversation does not exist.")),
			(error) => setFailure(String(error)),
		);
	}, [openConversation, id]);
	const thread = useThread(conversation, setFailure);
	const runtime = useExternalStoreRuntime<ThreadMessageLike>({
		messages: thread?.messages ?? [],
		convertMessage: asIs,
		isRunning: thread?.isRunning,
		isLoading: thread === undefined,
		onNew: () => Promise.reject(new Error("A subagent transcript is read-only")),
	});
	// No fork: a fork of a subagent is not a thread of the file.
	const childActions = useMemo(() => ({ ...actions, fork: undefined }), [actions]);
	return (
		<div className="flex flex-col gap-2">
			{failure && <p className="text-danger">Cannot show the subagent: {failure}</p>}
			<ChatActions.Provider value={childActions}>
				<AssistantRuntimeProvider runtime={runtime}>
					<ThreadPrimitive.Root className="flex flex-col gap-2">
						<ThreadPrimitive.Messages>{renderMessage}</ThreadPrimitive.Messages>
					</ThreadPrimitive.Root>
				</AssistantRuntimeProvider>
			</ChatActions.Provider>
		</div>
	);
}

const PARTS = { Text: MarkdownText, Reasoning, tools: { by_name: { subagent: SubagentCall }, Fallback: ToolCall }, Empty: Working };
