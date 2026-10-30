// The Web Worker of skill_grep. The extension stops it when the search takes too long.

import { grep } from "./grep";
import type { SkillFile } from "./store";

// The DOM types have no worker scope: in a worker, postMessage takes only the message.
const reply = postMessage as unknown as (message: unknown) => void;

addEventListener("message", (event: MessageEvent<{ files: SkillFile[]; pattern: string }>) => {
	reply(grep(event.data.files, event.data.pattern));
});
