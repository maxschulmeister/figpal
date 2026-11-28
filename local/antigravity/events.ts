import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";

/** What FigPal shows of a session update: the answer, the thinking (with Antigravity's plan and its own tools), and the usage. */
export type AcpActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; delta: string }
	| { type: "usage"; used: number };

export function mapSessionUpdate(notification: SessionNotification): AcpActivity[] {
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			return update.content.type === "text" ? [{ type: "text", delta: update.content.text }] : [];
		case "agent_thought_chunk":
			return update.content.type === "text" ? [{ type: "thought", delta: update.content.text }] : [];
		case "tool_call": {
			const status = update.status ? ` — ${update.status}` : "";
			const title = clean(update.title).replace(/\s+/gu, " ").trim() || "tool";
			return [{ type: "thought", delta: `\n[Antigravity tool: ${title}${status}]\n` }];
		}
		case "plan": {
			const lines = update.entries.map((entry) => `- [${entry.status}] ${clean(entry.content)}`);
			return lines.length ? [{ type: "thought", delta: `\n[Antigravity plan]\n${lines.join("\n")}\n` }] : [];
		}
		case "usage_update":
			// Sent once per inference with the context size after it; session setup reports 0.
			return update.used > 0 ? [{ type: "usage", used: update.used }] : [];
		default:
			return [];
	}
}

function clean(value: string): string {
	return value.replace(/[^\P{Cc}\t\n\r]/gu, "").slice(0, 2_000);
}
