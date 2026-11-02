import type { AppendMessage } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";
import { inboxQueue } from "./queue";
import type { QueuedInput } from "./transcript";

const message = (text: string) => ({ role: "user", content: [{ type: "text", text }], attachments: [] }) as unknown as AppendMessage;
/** The stored input of a waiting message: its model content, with an image, and its entry. */
const stored = (text: string): QueuedInput => ({
	content: [
		{ type: "text", text },
		{ type: "image", data: "iVBO", mimeType: "image/png" },
	],
	entry: { kind: "figpal.user", data: { text } },
});

function start(abortResult: "aborted" | "already_placed" = "aborted") {
	const sent: [unknown, string][] = [];
	const abort = vi.fn(async () => abortResult);
	const queue = inboxQueue({
		queue: {
			steer: [{ id: "s1", text: "Use 8 px", input: stored("Use 8 px") }],
			followUp: [{ id: "f1", text: "Then check it", input: stored("Then check it") }],
		},
		input: (value) => ({ content: (value.content[0] as { text: string }).text }),
		submit: (input, mode) => void sent.push([input, mode]),
		abort,
	});
	return { queue, sent, abort };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the queue of a busy chat", () => {
	it("shows the waiting messages of the inbox in their lanes", () => {
		const { queue } = start();
		expect(queue.steerItems).toEqual([{ id: "s1", prompt: "Use 8 px", parts: [{ type: "text", text: "Use 8 px" }] }]);
		expect(queue.items.map((item) => item.id)).toEqual(["f1"]);
	});

	// Enter while the agent works steers (assistant-ui calls steer); Cmd+Enter sends after the answer (enqueue).
	it("steers, or sends after the answer", () => {
		const { queue, sent } = start();
		queue.steer(message("Smaller"));
		queue.enqueue(message("Then the icons"));
		expect(sent).toEqual([
			[{ content: "Smaller" }, "steer"],
			[{ content: "Then the icons" }, "followUp"],
		]);
	});

	// The stored input goes again: its attachments stay.
	it("sends a waiting message now: it leaves the follow-ups and steers, with its attachments", async () => {
		const { queue, sent, abort } = start();
		queue.move("f1", { lane: "steer" });
		await flush();
		expect(abort).toHaveBeenCalledWith("f1");
		expect(sent).toEqual([[stored("Then check it"), "steer"]]);
	});

	// The run can place it first: then it is in the chat, and it must not go twice.
	it("does not send it twice when the run placed it first", async () => {
		const { queue, sent } = start("already_placed");
		queue.move("f1", { lane: "steer" });
		await flush();
		expect(sent).toEqual([]);
	});

	it("removes a waiting message", () => {
		const { queue, abort } = start();
		queue.remove("s1");
		expect(abort).toHaveBeenCalledWith("s1");
	});
});
