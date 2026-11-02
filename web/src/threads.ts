// The threads of a file: a list in a pi-durable session document, in the same storage as the conversations. A change
// to the list commits together with the conversation that it creates.

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type AgentChange,
	type Conversation,
	type ConversationId,
	type ConversationInit,
	defineDoc,
	type EntryId,
	type Harness,
} from "@earendil-works/pi-durable";

export type ThreadInfo = { id: ConversationId; title: string; updatedAt: number };
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

export async function selectThread(harness: Harness, id: ConversationId): Promise<Conversation> {
	const thread = await conversation(harness, id);
	await harness.commit(async (tx) => {
		(await tx.doc(Threads)).current = id;
	}, context);
	return thread;
}

export async function renameThread(harness: Harness, id: ConversationId, title: string): Promise<void> {
	await harness.commit(async (tx) => {
		const thread = (await tx.doc(Threads)).threads.find((info) => info.id === id);
		if (thread) thread.title = title;
	}, context);
}

/** A message moves the thread to the top. The first message also names it. */
export async function noteMessage(harness: Harness, id: ConversationId, text: string): Promise<void> {
	await harness.commit(async (tx) => {
		const list = await tx.doc(Threads);
		const index = list.threads.findIndex((info) => info.id === id);
		const thread = list.threads[index];
		if (!thread) return;
		if (!thread.title) thread.title = text.trim().split("\n")[0]!.slice(0, TITLE_LENGTH);
		thread.updatedAt = Date.now();
		list.threads.splice(index, 1);
		list.threads.unshift(thread);
	}, context);
}

/**
 * Archives a thread: removes it from the list and returns the open thread. If the archived thread was open, the newest other one
 * opens, or a new one. pi-durable cannot delete a conversation, so its entries stay in the storage.
 */
export async function archiveThread(harness: Harness, id: ConversationId, agent: AgentChange): Promise<Conversation> {
	await (await conversation(harness, id)).abort(context);
	const next = await harness.commit(async (tx) => {
		const list = await tx.doc(Threads);
		list.threads = list.threads.filter((info) => info.id !== id);
		if (list.current === id) list.current = list.threads[0]?.id;
		return list.current;
	}, context);
	return next === undefined ? newThread(harness, agent) : conversation(harness, next);
}
