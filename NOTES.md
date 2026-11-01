# Notes for later work

## Upgrades of the pi packages

The pi packages (`@earendil-works/pi-ai`, `pi-durable`, `chord`) are pinned to 1.4.0.

- **JSON Schema (breaking change expected):** the pi maintainer announced pi-schema (2026-10-31, https://x.com/badlogicgames/status/2116653884362097081), a JSON Schema builder and validator that works without `eval()`. pi-durable is expected to change its JSON validator, so the TypeBox schemas (`Type.Object`, `Type.String`, `Type.Union`, …) of the tool parameters can break. They are in `web/src/extensions/figma.ts`, `skills.ts` and `subagent.ts`. Before an upgrade, read the changelog, migrate the schemas, and run the tests and the Chrome runs.

## UI requests (user, 2026-11-01)

- The model picker closes when you select a model.
- The plugin panel can be resized, and if possible it opens at the full available height. `figma.ui.resize(width, height)` in `code.js` sets the size: the UI needs a resize handle that sends the new size to `code.js`, and `code.js` can save it in `clientStorage`. Find out what height is available: `code.js` cannot read the size of the Figma window.

## Local files and outside agents (user, 2026-11-01)

FigPal needs at least one of these. Choose and plan before building:

- **Local files:** the agent can read and write files on the user's machine, for example a codebase or an export folder. The hosted UI runs in a browser sandbox, so this needs a helper on the machine or a browser file API.
- **Access from outside, like the figma-console-mcp Desktop Bridge:** an agent in a terminal (Claude Code, pi, Codex) can act on the open Figma file through FigPal, for example with an MCP server that sends requests to `code.js`.
- **Remote threads:** a pi instance on another machine can start a thread in the plugin and follow it.

## Layer chips in the agent's answers (user, 2026-11-01, deferred)

The agent could write clickable layer chips in its answers, like the chips in the user's messages: a click selects the layers. It works for every tool, but it depends on the model writing the chips. Deferred: first the lint tool with pills under its step.

## TypeScript only (user, 2026-11-01)

Rewrite all JavaScript in TypeScript. Now two files are JavaScript:

- `plugin/src/vendor/figma-console-mcp/checks.js` (about 2,500 lines, copied from figma-console-mcp `code.js`, with `checks.d.ts` for its types). A rewrite makes a later update from upstream a manual merge, not a simple diff. The tests in `plugin/src/checks.test.ts` check its behavior.
- `plugin/build.mjs` (the esbuild script of the plugin).

## Size of the version diff answers (2026-11-01)

`figma_diff_versions` reads `GET /v1/files/KEY?depth=1` for each version, as upstream does. A review expected the `components`, `componentSets` and `styles` maps of the whole file in that answer, which could be MB for a large library. Measured on 5 of the user's files (1 to 10 pages): 1 to 4 KB, with empty maps at depth 1. The 7th call in 30 seconds got a 429, so the Tier 1 limit is the real cost, not the size. If a large library is slow, measure it, and consider reading the current pages through `code.js` (`figma.root.children`): no REST call for "current".
