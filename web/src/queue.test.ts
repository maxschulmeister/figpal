import type { AppendMessage } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";
import { inboxQueue } from "./queue";

const message = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as unknown as AppendMessage;

function start(abortResult: "aborted" | "already_placed" = "aborted") {
	const sent: [string, string][] = [];
	const abort = vi.fn(async () => abortResult);
	const queue = inboxQueue({
		queue: { steer: [{ id: "s1", text: "Use 8 px" }], followUp: [{ id: "f1", text: "Then check it" }] },
		send: (text, mode) => void sent.push([text, mode]),
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
			["Smaller", "steer"],
			["Then the icons", "followUp"],
		]);
	});

	it("sends a waiting message now: it leaves the follow-ups and steers", async () => {
		const { queue, sent, abort } = start();
		queue.move("f1", { lane: "steer" });
		await flush();
		expect(abort).toHaveBeenCalledWith("f1");
		expect(sent).toEqual([["Then check it", "steer"]]);
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
