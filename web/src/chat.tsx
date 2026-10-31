// The chat: assistant-ui primitives on the pi-durable conversation, with figma-kit's look.

import {
	AssistantRuntimeProvider,
	AuiIf,
	ComposerPrimitive,
	type EmptyMessagePartProps,
	ErrorPrimitive,
	MessageNotSentError,
	MessagePrimitive,
	type ReasoningMessagePartComponent,
	ThreadPrimitive,
	type ThreadMessageLike,
	type ToolCallMessagePartComponent,
	type ToolCallMessagePartProps,
	useAuiState,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import type { AgentState, Conversation, ConversationId, ConversationView, EntryId } from "@earendil-works/pi-durable";
import type { FileInfo } from "@figpal/shared";
import { Button, CheckmarkIcon, ChevronDownIcon, Collapsible, createIcon, DropdownMenu, IconButton, Text } from "figma-kit";
import { type ComponentProps, createContext, useContext, useEffect, useMemo, useState } from "react";
import remarkGfm from "remark-gfm";
import { userInput } from "./agent";
import type { SubagentDetails } from "./extensions/subagent";
import { enabledModelGroups, type Settings } from "./settings";
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
};
const ChatActions = createContext<Actions>({ openExternal() {}, openConversation: async () => undefined });

const TOOL_LABELS: Record<string, string> = { figma_execute: "Run code", figma_screenshot: "Screenshot", subagent: "Subagents" };

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

type ChatProps = Actions & {
	thread: Conversation;
	file: FileInfo;
	models: Models;
	/** Provider IDs with a saved credential: the model picker shows their models. */
	connected: ReadonlySet<string>;
	/** The enabled models in the settings: the model picker shows only these. */
	enabledModels: string[];
	/** A message was sent. */
	onSend(text: string): void;
	/** The user picked a model or thinking level. New threads use it too. */
	onModelChange(choice: ModelChoice): void;
};

export function Chat(props: ChatProps) {
	const { thread: conversation, file } = props;
	const [failure, setFailure] = useState<string>();
	const thread = useThread(conversation, setFailure);
	const runtime = useExternalStoreRuntime<ThreadMessageLike>({
		messages: thread?.messages ?? [],
		convertMessage: asIs,
		isRunning: thread?.isRunning,
		isLoading: thread === undefined,
		onNew: async (message) => {
			const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			try {
				await conversation.submit(userInput(text, file), context);
				props.onSend(text);
			} catch (error) {
				console.error("FigPal could not send the message:", error);
				// assistant-ui puts the text back into the message field.
				throw new MessageNotSentError(String(error));
			}
		},
		onCancel: () => conversation.abort(context),
	});
	const actions = useMemo(
		() => ({ openExternal: props.openExternal, fork: props.fork, openConversation: props.openConversation }),
		[props.openExternal, props.fork, props.openConversation],
	);

	if (failure) return <p className="p-6 text-danger">Cannot open the chat: {failure}</p>;
	const retry = thread?.retry;
	const selection = file.selection.length
		? file.selection.length === 1
			? file.selection[0]!.name
			: `${file.selection.length} layers selected`
		: "No selection";

	return (
		<ChatActions.Provider value={actions}>
			<AssistantRuntimeProvider runtime={runtime}>
				<ThreadPrimitive.Root className="flex h-full flex-col">
					<ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pt-4">
						<AuiIf condition={(state) => state.thread.isEmpty}>
							<p className="m-auto text-lg text-secondary">Ask FigPal to read or change this file.</p>
						</AuiIf>
						<ThreadPrimitive.Messages>{renderMessage}</ThreadPrimitive.Messages>
						<ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto flex flex-col gap-1 bg-default pb-2">
							{retry && <p className="text-secondary">The model call failed and runs again soon: {retry.error}</p>}
							<ComposerPrimitive.Root className="flex items-end gap-1 rounded-md border border-default p-1 focus-within:border-selected">
								<ComposerPrimitive.Input
									autoFocus
									rows={1}
									placeholder="Ask FigPal"
									className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1 text-lg outline-none placeholder:text-tertiary"
								/>
								<AuiIf condition={(state) => !state.thread.isRunning}>
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
							</ComposerPrimitive.Root>
							<div className="flex items-center justify-between gap-2">
								<Text className="truncate text-secondary">{selection}</Text>
								<ModelPicker
									conversation={conversation}
									agent={thread?.agent}
									models={props.models}
									connected={props.connected}
									enabledModels={props.enabledModels}
									onChange={props.onModelChange}
								/>
							</div>
						</ThreadPrimitive.ViewportFooter>
					</ThreadPrimitive.Viewport>
				</ThreadPrimitive.Root>
			</AssistantRuntimeProvider>
		</ChatActions.Provider>
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

/** The model and thinking level of the thread. pi-durable uses "off" when the thread has no thinking level. */
function ModelPicker(props: {
	conversation: Conversation;
	agent: AgentState | undefined;
	models: Models;
	connected: ReadonlySet<string>;
	enabledModels: string[];
	onChange(choice: ModelChoice): void;
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
		<DropdownMenu.Root>
			<DropdownMenu.Trigger render={<Button variant="text" className="gap-1 text-secondary" />}>
				{model?.name ?? "Model"}
				{canThink && ` · ${THINKING_LABELS[thinkingLevel]}`}
				<ChevronDownIcon size="4" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Positioner side="top" align="end" sideOffset={4}>
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
									<DropdownMenu.RadioItem key={item.id} value={item.id}>
										<DropdownMenu.RadioItemIndicator>
											<CheckmarkIcon size="4" />
										</DropdownMenu.RadioItemIndicator>
										{item.name}
									</DropdownMenu.RadioItem>
								))}
							</DropdownMenu.RadioGroup>
						))}
						{canThink && <DropdownMenu.Separator />}
						{canThink && (
							<DropdownMenu.SubmenuRoot>
								<DropdownMenu.SubmenuTrigger>Thinking: {THINKING_LABELS[thinkingLevel]}</DropdownMenu.SubmenuTrigger>
								<DropdownMenu.Portal>
									<DropdownMenu.Positioner sideOffset={12} alignOffset={-8}>
										<DropdownMenu.Popup style={{ minWidth: 140 }}>
											<DropdownMenu.RadioGroup
												value={thinkingLevel}
												onValueChange={(level: ModelThinkingLevel) => void choose({ model: ref, thinkingLevel: level })}
											>
												{levels.map((level) => (
													<DropdownMenu.RadioItem key={level} value={level}>
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
							</DropdownMenu.SubmenuRoot>
						)}
					</DropdownMenu.Popup>
				</DropdownMenu.Positioner>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

const renderMessage = ({ message }: { message: { role: string } }) =>
	message.role === "user" ? <UserMessage /> : <AssistantMessage />;

function UserMessage() {
	return (
		<MessagePrimitive.Root className="ml-10 self-end rounded-lg bg-secondary px-3 py-2 text-lg whitespace-pre-wrap break-words">
			<MessagePrimitive.Parts />
		</MessagePrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="group/message flex flex-col gap-2 text-lg break-words">
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

/** A tool call: its label and state, and when opened, the arguments and the result (text and images). */
const ToolCall: ToolCallMessagePartComponent = (props) => {
	const { toolName, args, result, isError } = props;
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
