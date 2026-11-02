# Notes for later work

## Upgrades of the pi packages

The pi packages (`@earendil-works/pi-ai`, `pi-durable`, `chord`) are pinned to 1.4.0.

- **JSON Schema (breaking change expected):** the pi maintainer announced pi-schema (2026-10-31, https://x.com/badlogicgames/status/2116653884362097081), a JSON Schema builder and validator that works without `eval()`. pi-durable is expected to change its JSON validator, so the TypeBox schemas (`Type.Object`, `Type.String`, `Type.Union`, …) of the tool parameters can break. They are in `web/src/extensions/figma.ts`, `skills.ts` and `subagent.ts`. Before an upgrade, read the changelog, migrate the schemas, and run the tests and the Chrome runs.

## Local files and outside agents (user, 2026-11-01)

Done (Phase 7): the local helper `local/cli.ts` gives local files (`--folder`) and access from outside (`--mcp`). Open:

- **Remote threads:** a pi instance on another machine can start a thread in the plugin and follow it.
- **Publish on npm (user, 2026-11-02):** then `npx` starts the helper, without a clone of the repo, for example `claude mcp add figpal -- npx -y <package> --mcp`.

### Optional Node host (from PLAN.md)

Use it only if you need repo access, long runs while Figma is closed, or a provider that no browser path supports.

- The same extensions run in Node with SQLite storage. Only the transport changes (WebSocket instead of `postMessage`).
- It adds pi-durable `createCodingTools` with a `NodeExecutionEnv` for each repo, and the figma-console-mcp codebase extraction (`src/core/extraction`).
- A LaunchAgent (`RunAtLoad`, `KeepAlive`) starts it at login.

## Reply to a part of an answer (user, 2026-11-02)

The user selects text in an answer, and a "Reply" button shows next to it, as "Cite" in T3 Code. Reply puts the text in the composer as a quote; the user writes a comment for it. Several quotes in one message are possible.

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
- Alternative with less code: one "Instructions" field in the settings for the main agent and all subagents.

## Archive and delete threads (from PLAN.md, not in Phase 7)

Now "Delete" only hides a thread: pi-durable 1.4.0 cannot delete one conversation, only the whole storage of a file (`IndexedDbStorage.delete`). The user suggested two actions (2026-10-31).

- Archive: hide the thread, as "Delete" does now, with a way to show archived threads again.
- Delete: remove the entries, so that they do not fill the browser storage. This needs pi-durable support, or a "Delete all threads of this file" action.

## Thread names (from PLAN.md, not in Phase 7)

The UX of thread names. Now a thread takes the first line of its first message (at most 60 characters), and you can rename it.

- Idea: an AI name, like T3 Code: after the first message, a small, fast model writes a short title. A name that the user gave stays.
- Decide: which model (the provider of the thread, or a fixed small model), the cost, when it runs (the first message only, or again later), and what shows while it runs.
