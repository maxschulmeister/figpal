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
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { FileInfo } from "@figpal/shared";
import { Collapsible, createIcon, IconButton, Text } from "figma-kit";
import { type ComponentProps, createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import remarkGfm from "remark-gfm";
import { type Agent, userInput } from "./agent";
import { toThread } from "./transcript";

const SendIcon = createIcon({
	displayName: "SendIcon",
	path: <path fill="var(--color-icon)" d="M12 6.3 17.35 11.65l-.7.7L12.5 8.2V18h-1V8.2l-4.15 4.15-.7-.7Z" />,
});
const StopIcon = createIcon({
	displayName: "StopIcon",
	path: <rect fill="var(--color-icon)" x="8" y="8" width="8" height="8" rx="1" />,
});

/** Opens a link in the browser: the plugin window cannot open one. */
const OpenExternal = createContext<(url: string) => void>(() => {});

const TOOL_LABELS: Record<string, string> = { figma_execute: "Run code", figma_screenshot: "Screenshot" };

/** The messages are already in the assistant-ui format. A stable function keeps assistant-ui's message cache. */
const asIs = (message: ThreadMessageLike) => message;

export function Chat(props: { agent: Agent; file: FileInfo; menu: ReactNode; openExternal(url: string): void }) {
	const { agent, file } = props;
	const [view, setView] = useState<ConversationView>();
	const [failure, setFailure] = useState<string>();
	useEffect(() => {
		let state: AttachedReplicatedState<ConversationView> | undefined;
		let closed = false;
		agent.root.viewState(context).then(
			(attached) => {
				if (closed) return attached.dispose();
				state = attached;
				// It also gives the current value at once.
				attached.subscribe(setView);
			},
			(error) => setFailure(String(error)),
		);
		return () => {
			closed = true;
			state?.dispose();
		};
	}, [agent]);

	const thread = useMemo(() => (view ? toThread(view) : undefined), [view]);
	const runtime = useExternalStoreRuntime<ThreadMessageLike>({
		messages: thread?.messages ?? [],
		convertMessage: asIs,
		isRunning: thread?.isRunning,
		isLoading: thread === undefined,
		onNew: async (message) => {
			const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			try {
				await agent.root.submit(userInput(text, file), context);
			} catch (error) {
				console.error("FigPal could not send the message:", error);
				// assistant-ui puts the text back into the message field.
				throw new MessageNotSentError(String(error));
			}
		},
		onCancel: () => agent.root.abort(context),
	});

	if (failure) return <p className="p-6 text-danger">Cannot open the chat: {failure}</p>;
	const retry = thread?.retry;
	const selection = file.selection.length
		? file.selection.length === 1
			? file.selection[0]!.name
			: `${file.selection.length} layers selected`
		: "No selection";

	return (
		<OpenExternal.Provider value={props.openExternal}>
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
								{props.menu}
							</div>
						</ThreadPrimitive.ViewportFooter>
					</ThreadPrimitive.Viewport>
				</ThreadPrimitive.Root>
			</AssistantRuntimeProvider>
		</OpenExternal.Provider>
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
		<MessagePrimitive.Root className="flex flex-col gap-2 text-lg break-words">
			<MessagePrimitive.Parts components={PARTS} />
			<MessagePrimitive.Error>
				<ErrorPrimitive.Root className="rounded-md bg-danger-tertiary px-3 py-2 text-danger">
					<ErrorPrimitive.Message />
				</ErrorPrimitive.Root>
			</MessagePrimitive.Error>
		</MessagePrimitive.Root>
	);
}

/** assistant-ui also shows it after a tool call and on an empty answer, so it checks the status. */
function Working({ status }: EmptyMessagePartProps) {
	if (status.type !== "running") return null;
	return <span className="animate-pulse text-secondary">Working…</span>;
}

function ExternalLink({ href, children }: ComponentProps<"a">) {
	const openExternal = useContext(OpenExternal);
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

/** A tool call: its label and state, and when opened, the arguments and the result (text and images). */
const ToolCall: ToolCallMessagePartComponent = ({ toolName, args, result, isError, status }) => {
	const content = (result ?? []) as (TextContent | ImageContent)[];
	const state = status.type === "running" ? "running" : result === undefined ? "stopped" : isError ? "failed" : "";
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

const PARTS = { Text: MarkdownText, Reasoning, tools: { Fallback: ToolCall }, Empty: Working };
