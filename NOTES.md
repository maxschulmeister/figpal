# Notes for later work

## Local files and outside agents (user, 2026-11-01)

Done (Phase 7): the local helper `local/cli.ts` gives local files (`--folder`) and access from outside (`figpal mcp`). Open:

- **Remote threads:** a pi instance on another machine can start a thread in the plugin and follow it.
- **Publish on npm (user, 2026-11-02):** then `npx` starts the helper, without a clone of the repo, for example `claude mcp add figpal -- npx -y <package> mcp`.

### Optional Node host (from PLAN.md)

Use it only if you need repo access, long runs while Figma is closed, or a provider that no browser path supports.

- The same extensions run in Node with SQLite storage. Only the transport changes (WebSocket instead of `postMessage`).
- It adds pi-durable `createCodingTools` with a `NodeExecutionEnv` for each repo, and the figma-console-mcp codebase extraction (`src/core/extraction`).
- A LaunchAgent (`RunAtLoad`, `KeepAlive`) starts it at login.

## Size of the version diff answers (2026-11-01)

`figma_diff_versions` reads `GET /v1/files/KEY?depth=1` for each version, as upstream does. A review expected the `components`, `componentSets` and `styles` maps of the whole file in that answer, which could be MB for a large library. Measured on 5 of the user's files (1 to 10 pages): 1 to 4 KB, with empty maps at depth 1. The 7th call in 30 seconds got a 429, so the Tier 1 limit is the real cost, not the size. If a large library is slow, measure it, and consider reading the current pages through `code.js` (`figma.root.children`): no REST call for "current".

## Domain migration and export/import (deferred by the user, 2026-11-01)

Conversations, settings and skills are stored for the origin `figpal.maxschulmeister.dev`. A new domain starts empty. Export and import of the data move it. Check: migrate data between two test subdomains.

## Agent profiles (from PLAN.md, not in Phase 7)

Profiles with their own instructions, model, thinking level and skills, for the main agent and for subagents (decided 2026-10-31: not in Phase 4).

- Use: rules that you write once, for example brand rules or "use only our library components".
- A form in the settings (name, description, model, thinking level, skills, instructions), not Markdown.
- An agent picker in the chat, next to the model picker: a thread can use a profile. The `subagent` tool gets an `agent` field.
- A stale profile must not fail: a removed skill is left out, and a model that was removed (or whose provider is not connected) falls back to the thread's model, with a warning on the profile.
- Storage: `figpal:global` already has an empty `agents` store (version 3).
- Done instead of the small option (one "Instructions" field): Settings → Rules, for all files and for this file. Profiles stay open.

## Delete threads (from PLAN.md, not in Phase 7)

Archive is done (2026-11-03): archived threads are at the end of the chat list, and opening one brings it back. Open: delete, to remove the entries so that they do not fill the browser storage. pi-durable 1.5.0 still cannot delete one conversation, only the whole storage of a file (`IndexedDbStorage.delete`): this needs pi-durable support, or a "Delete all threads of this file" action.
