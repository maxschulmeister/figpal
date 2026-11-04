// The threads of a file: a list in a pi-durable session document, in the same storage as the conversations. A change
// to the list commits together with the conversation that it creates.

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Api, type AssistantMessage, contentText, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	type AgentChange,
	AssistantEntry,
	type Conversation,
	type ConversationId,
	type ConversationInit,
	defineDoc,
	type EntryId,
	type Harness,
	type Submission,
} from "@earendil-works/pi-durable";

/**
 * `unread`: its work ended while another thread was open (user request: a dot in the chat list). `archived`: in the
 * Archived part of the list, until it opens again.
 */
export type ThreadInfo = { id: ConversationId; title: string; updatedAt: number; unread?: true; archived?: true };
/** Newest first. `current` is the thread that is open. */
export type ThreadList = { threads: ThreadInfo[]; current?: ConversationId };

export const Threads = defineDoc<ThreadList>({
	kind: "figpal.threads",
	version: 1,
	scope: "session",
	initial: () => ({ threads: [] }),
	// The list is small: store each change as a full value.
	checkpointWhen: () => true,
});

const TITLE_LENGTH = 60;
/** The name from the first message. A message with only attachments has no text: "New chat", as the list shows it. */
const firstLine = (text: string) => text.trim().split("\n")[0]!.slice(0, TITLE_LENGTH) || "New chat";

const NAME_PROMPT =
	"Name this chat between a user and FigPal, an assistant in Figma, from its first message (from FigPal's answer if the message has only files). Text in [brackets] names Figma layers. Reply with the name only: 2 to 6 words, in the language of the user, without quotes and without a full stop.";

/** Adds a new conversation to the list and opens it, in the commit that creates the conversation. */
const asNewThread = (title: string): ConversationInit => async (tx, id) => {
	const list = await tx.doc(Threads);
	list.threads.unshift({ id, title, updatedAt: Date.now() });
	list.current = id;
};

async function conversation(harness: Harness, id: ConversationId): Promise<Conversation> {
	const found = await harness.conversation(id, context);
	if (!found) throw new Error(`The conversation ${id} does not exist`);
	return found;
}

/** The open thread. The first time, the root conversation (the chat of Phase 1) becomes the first thread. */
export async function currentThread(harness: Harness, agent: AgentChange): Promise<Conversation> {
	const list = await harness.snapshot(Threads, context);
	if (list?.current !== undefined) return conversation(harness, list.current);
	const root = await harness.root(context, { agent });
	// Another start can have added it since the read above.
	await harness.commit(async (tx) => {
		if ((await tx.doc(Threads)).current === undefined) await asNewThread("")(tx, root.id);
	}, context);
	return root;
}

export function newThread(harness: Harness, agent: AgentChange): Promise<Conversation> {
	return harness.createConversation({ ownership: { kind: "ownerless" }, agent, init: asNewThread("") }, context);
}

/** A new thread with the history of `from` up to the entry `at`. */
export function forkThread(from: Conversation, at: EntryId, title: string): Promise<Conversation> {
	return from.fork(at, { ownership: { kind: "ownerless" }, init: asNewThread(`${title || "Chat"} (fork)`) }, context);
}

/** Opens a thread in the list: it is read, and back from Archived. */
function openIn(list: ThreadList, id: ConversationId | undefined): void {
	list.current = id;
	const info = list.threads.find((item) => item.id === id);
	if (!info) return;
	delete info.unread;
	delete info.archived;
}

export async function selectThread(harness: Harness, id: ConversationId): Promise<Conversation> {
	const thread = await conversation(harness, id);
	await harness.commit(async (tx) => openIn(await tx.doc(Threads), id), context);
	return thread;
}

/** The work of a thread ended: new activity, and unread if another thread is open. */
export async function noteDone(harness: Harness, id: ConversationId): Promise<void> {
	await harness.commit(async (tx) => {
		const list = await tx.doc(Threads);
		const info = list.threads.find((item) => item.id === id);
		if (!info) return;
		info.updatedAt = Date.now();
		if (list.current !== id) info.unread = true;
	}, context);
}

/**
 * Calls noteDone when the work of a thread ends, with one waiter for each thread: a message while the thread works
 * adds none. At the start, it watches the threads with unsettled submissions: a restart continues their work. Returns
 * `watch`, for each message that the user sends.
 */
export function doneWatcher(harness: Harness, report: (error: unknown) => void): (id: ConversationId) => void {
	const waiting = new Set<ConversationId>();
	const watch = (id: ConversationId) => {
		if (waiting.has(id)) return;
		waiting.add(id);
		void conversation(harness, id)
			.then((thread) => thread.waitForIdle(context))
			// Before noteDone: a message after the end starts a new waiter.
			.finally(() => waiting.delete(id))
			.then(() => noteDone(harness, id))
			.catch(report);
	};
	harness.inspect(context).then(({ submissions }) => {
		for (const submission of submissions) watch(submission.conversationId);
	}, report);
	return watch;
}

/** The order of the chat list (user request): unread threads first, then the newest activity. Not the archived ones. */
export const sortedThreads = (list: ThreadList): ThreadInfo[] =>
	list.threads
		.filter((info) => !info.archived)
		.sort((a, b) => Number(b.unread ?? false) - Number(a.unread ?? false) || b.updatedAt - a.updatedAt);

/** The archived threads, the newest activity first. */
export const archivedThreads = (list: ThreadList): ThreadInfo[] =>
	list.threads.filter((info) => info.archived).sort((a, b) => b.updatedAt - a.updatedAt);

export async function renameThread(harness: Harness, id: ConversationId, title: string): Promise<void> {
	await harness.commit(async (tx) => {
		const thread = (await tx.doc(Threads)).threads.find((info) => info.id === id);
		if (thread) thread.title = title;
	}, context);
}

/** A message moves the thread to the top. The first message also names it: then the result is true. */
export function noteMessage(harness: Harness, id: ConversationId, text: string): Promise<boolean> {
	return harness.commit(async (tx) => {
		const list = await tx.doc(Threads);
		const index = list.threads.findIndex((info) => info.id === id);
		const thread = list.threads[index];
		if (!thread) return false;
		const first = !thread.title;
		if (first) thread.title = firstLine(text);
		thread.updatedAt = Date.now();
		list.threads.splice(index, 1);
		list.threads.unshift(thread);
		return first;
	}, context);
}

/** The text generation model, and its thinking level (fitted to the model). */
export type Namer = { models: Models; model: Model<Api>; thinking: ModelThinkingLevel };

/**
 * After the first message (`submission`): a short name from the message, by the text generation model (user request:
 * after the message, not after the answer). A message with only attachments has no text: then the name comes from
 * the answer. The name changes only while it is the first line of the message, so a name that the user gave stays.
 * If the model fails, or the answer to only attachments stopped, the first line stays.
 */
export async function nameThread(harness: Harness, submission: Submission, text: string, { models, model, thinking }: Namer): Promise<void> {
	const id = (await submission.status(context)).conversationId;
	const unnamed = (list: ThreadList | undefined) => list?.threads.find((thread) => thread.id === id)?.title === firstLine(text);
	let content = `Message: ${text.slice(0, 1000)}`;
	if (!text.trim()) {
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") return;
		const entry = await harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const answer = contentText((entry?.model?.[0] as AssistantMessage | undefined)?.content ?? [], "").slice(0, 2000);
		if (!answer) return;
		content = `Message: (only files)\n\nAnswer: ${answer}`;
	}
	if (!unnamed(await harness.snapshot(Threads, context))) return;
	const reply = await models.completeSimple(
		model,
		{ systemPrompt: NAME_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] },
		// Thinking needs more tokens than the name.
		thinking === "off" ? { maxTokens: 40 } : { reasoning: thinking },
	);
	if (reply.stopReason === "error") {
		console.warn("FigPal could not name the chat:", reply.errorMessage);
		return;
	}
	const name = contentText(reply.content, "").trim().split("\n")[0]!.replace(/^["'“”‘’`]+|["'“”‘’`.]+$/g, "").slice(0, TITLE_LENGTH);
	if (!name) return;
	await harness.commit(async (tx) => {
		const list = await tx.doc(Threads);
		const info = list.threads.find((thread) => thread.id === id);
		if (info && unnamed(list)) info.title = name;
	}, context);
}

/**
 * Archives a thread: it moves to the Archived part of the list, and a running answer stops. Returns the open thread: if
 * the archived thread was open, the first other one opens, or a new one. Opening it again brings it back.
 */
export async function archiveThread(harness: Harness, id: ConversationId, agent: AgentChange): Promise<Conversation> {
	await (await conversation(harness, id)).abort(context);
	const next = await harness.commit(async (tx) => {
		const list = await tx.doc(Threads);
		const info = list.threads.find((item) => item.id === id);
		if (info) info.archived = true;
		if (list.current === id) openIn(list, sortedThreads(list)[0]?.id);
		return list.current;
	}, context);
	return next === undefined ? newThread(harness, agent) : conversation(harness, next);
}
