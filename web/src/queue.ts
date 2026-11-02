// The queue of a busy chat: assistant-ui's queue adapter on pi-durable's inbox. While the agent works, Enter steers
// (the message joins the running work after the current tool step) and Cmd+Enter sends after the answer.

import type { AppendMessage, ExternalThreadQueueAdapter, QueueItemState } from "@assistant-ui/react";
import type { QueuedInput, QueuedMessage, Thread } from "./transcript";

export type QueueMode = "steer" | "followUp";

/** The text of a message of the composer. */
export const textOf = (message: AppendMessage) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const item = ({ id, text }: QueuedMessage): QueueItemState => ({ id, prompt: text, parts: [{ type: "text", text }] });

export function inboxQueue(options: {
	queue: Thread["queue"];
	/** The input of a message of the composer: its text and attachments, with the Figma context. */
	input(message: AppendMessage): QueuedInput;
	/** Submits an input with `whenBusy` set to the mode. */
	submit(input: QueuedInput, mode: QueueMode): void;
	/** Withdraws a waiting message. "already_placed": the run took it first, so it is in the chat. */
	abort(id: string): Promise<string>;
}): ExternalThreadQueueAdapter {
	const { queue, input, submit, abort } = options;
	const find = (id: string) => {
		const steer = queue.steer.find((message) => message.id === id);
		if (steer) return { message: steer, mode: "steer" as const };
		const followUp = queue.followUp.find((message) => message.id === id);
		return followUp && { message: followUp, mode: "followUp" as const };
	};
	/** Withdraws it and submits it again: pi-durable cannot move or change a waiting message. */
	const resend = (id: string, next: (old: QueuedInput) => QueuedInput, mode: (old: QueueMode) => QueueMode) => {
		const found = find(id);
		if (!found) return;
		void abort(id).then((result) => {
			if (result === "aborted") submit(next(found.message.input), mode(found.mode));
		});
	};
	return {
		items: queue.followUp.map(item),
		steerItems: queue.steer.map(item),
		enqueue: (message) => submit(input(message), "followUp"),
		steer: (message) => submit(input(message), "steer"),
		move: (id, placement) => {
			if (placement.lane === "steer" && find(id)?.mode === "followUp") resend(id, (old) => old, () => "steer");
		},
		edit: (id, message) => resend(id, () => input(message), (mode) => mode),
		remove: (id) => void abort(id),
	};
}
