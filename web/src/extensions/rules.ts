// The `rules` extension: the user's rules in the prompt. It reads them at each request, so a change counts from the
// next message on, in all chats.

import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Bridge } from "../bridge";
import { readRulesPrompt } from "../rules";

export function rulesExtension(bridge: Pick<Bridge, "request">) {
	return defineExtension({
		name: "rules",
		sections: [section("rules", () => readRulesPrompt(bridge))],
	});
}
