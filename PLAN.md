# FigPal plan

FigPal is a Figma plugin with an AI agent in it. The agent runs on pi-durable inside the plugin UI. It reads and changes the open file through the Figma Plugin API. Threads stay in storage and continue after you close and open the plugin again.

FigPal is a development plugin for Figma Desktop only. Plugin ID: `figpal`. UI: `http://localhost:9310`, served by the FigPal command on the user's Mac (the npm package `figpal`, Phase 8). Before Phase 8: `https://figpal.maxschulmeister.dev` (static files on the VPS, only reachable through Tailscale). Repo: `github.com/maxschulmeister/figpal`.

The old FigPal (a code generator that you start from quick actions) is on branch `backup/original-main`. A tarball of the old folder is at `~/Documents/figpal-backup-20261029-222910.tar.gz` (it includes `.env`).

## Goals

- A chat agent in a Figma plugin, with a UI like assistant-ui.
- A small token cost: a few tools, not 130 MCP tools.
- Durable threads for each Figma file. A run that stops continues when you open the plugin again.
- Use of model subscriptions (Claude, ChatGPT). API keys are also possible.
- Simple subagents that work in parallel.
- Skills, managed in the settings. You can install skills from skills.sh.
- Web research, including images for the canvas.
- No local daemon and no MCP server.

## Not in scope (for now)

- Access to a code repository (code ↔ design). See [Later](#later-optional-node-host).
- Figma's own AI features (`generate_image`, Figma Make). The Plugin API does not give access to them.
- The Figma Community. FigPal stays a development plugin: users get it from GitHub and npm (Phase 8).
- Figma in a browser. Figma Desktop is the only target.

## Decisions

| Topic | Decision | Reason |
|---|---|---|
| Agent runtime | `@earendil-works/pi-durable` in the browser | It is durable, it has forks and conversations, and it runs in a browser. |
| UI components | Chat: assistant-ui. All other UI (settings, lists, dialogs): [figma-kit](https://github.com/tigranpetrossian/figma-kit) (React, Base UI, UI3 look, Tailwind v4, MIT, beta) | The user wants a Figma look outside the chat. `@create-figma-plugin/ui` is Preact, and its last release is from 2025-08. figma-kit is React like assistant-ui, and both use Tailwind v4. The hosted page does not get Figma's tokens: import `figma-kit/figma-development-theme.css` and set the theme class from the URL hash (spike 0.16). Pin the beta version. |
| Base code | A new, thin core. Copy selected MIT modules from figma-console-mcp and figwright when a feature needs them. | figma-console-mcp is a 59k-line Node MCP server. Its value is mostly in tool schemas (about 48k tokens). Its `EXECUTE_CODE` core is about 60 lines. A fork diverges on the first day. |
| Figma access | One tool that runs Plugin API JavaScript (`figma_execute`), plus a screenshot tool | Frontier models know the Plugin API well. Figma's own `use_figma` uses the same model. It covers Motion, variables, components, Slots, shaders, Draw, FigJam and Slides. |
| Plugin ID | `figpal` (development plugin, not released) | clientStorage data belongs to the plugin ID. Do not change it. |
| Figma client | Figma Desktop only | Enough for this use. Less to test. |
| UI hosting | The plugin iframe goes to `https://figpal.maxschulmeister.dev` | The default plugin iframe has a `null` origin. IndexedDB does not work there. A real origin also lets the UI use same-origin proxy routes. A hosted UI needs less code than a bundled UI with a separate storage page. |
| Server | Static files, served by the host Caddy. Tailscale only. No app process, no container. | The VPS already serves Tailscale-only sites this way (`system.` and `manifest.maxschulmeister.dev`). It puts the least on the server. Visitors from the internet get a 404. |
| Proxy | Caddy `reverse_proxy` routes to fixed hosts, only when a spike shows the need | No code. No secret is needed, because only the tailnet can reach the site. |
| Large data | IndexedDB on the hosted origin | No 5 MB limit. pi-durable has an IndexedDB backend. |
| Small data | `figma.clientStorage` (5 MB, per plugin ID) | Official, private to the plugin, works from the main thread. |
| Secrets (model credentials) | `localStorage` of the UI origin | Code from `figma_execute` can read clientStorage, but not the storage of the UI (decision 2026-10-31). |
| Threads | Per Figma file | User request. |
| Skills | Global (one list for all files) | User request. |
| Web search | The model provider's own search tool. Tavily is the fallback. | No separate process, no key, and no VPS IP blocks. |

## Facts we checked (2026-10-29)

CORS preflight results from the plugin origins (`null` and `https://www.figma.com`):

| Endpoint | Result |
|---|---|
| `api.anthropic.com/v1/messages` | Allowed (`*`), including `x-app`, `user-agent` and `anthropic-dangerous-direct-browser-access`. Only if the request has `anthropic-dangerous-direct-browser-access` (pi-ai sends it). |
| `api.openai.com/v1` | Allowed (`*`) |
| `platform.claude.com/v1/oauth/token` | Blocked ("Disallowed CORS origin") |
| `chatgpt.com/backend-api/codex` | Blocked ("Disallowed CORS origin"). Allowed only from `http://localhost` origins. |
| `auth.openai.com` (token, device code) | Allowed |
| `api.githubcopilot.com`, `api.github.com/copilot_internal/v2/token` | Allowed |
| `api.figma.com` | Allowed (`X-Figma-Token`, `Authorization`) |
| `api.github.com`, `raw.githubusercontent.com` | Allowed |
| `skills.sh/api/search`, `skills.sh/api/download/...` | No CORS header. Use a Caddy route or the GitHub fallback. |
| Tavily, Openverse, Wikimedia Commons, Unsplash, Pexels, Jina Reader | Allowed |

Other facts:

- `claude setup-token` makes a long-lived `sk-ant-oat01-…` token. pi-ai sends it as a Bearer token. Anthropic refuses browser requests for subscription accounts, so FigPal sends Claude requests through the route `/api/anthropic`, which removes the browser headers (spike 0.3).
- The pi-ai OAuth login modules use Node (`node:http` callback server). pi has headless logins: a Claude setup-token, a Codex device code, and the GitHub device flow.
- The pi-ai Codex WebSocket transport sends headers. A browser WebSocket cannot send headers.
- pi-ai has `onPayload` for Anthropic and Codex requests. pi-durable does not expose it. pi-ai does not parse server tool blocks.
- pi-durable runs a tool again after a restart only if the tool has `replay: "safe"`. Other tools give the model an `interrupted` result.
- pi-durable `IndexedDbStorage` needs one owner at a time. Use a Web Lock.
- `figma.fileKey` is only available to private plugins with `enablePrivatePluginApi`.
- `figma.createImageAsync(url)` accepts PNG, JPEG and GIF up to 4096 px. The docs do not say if CORS applies.
- Figma runs one plugin at a time in a file.

Facts from the spike (see `docs/spike.md`):

- `networkAccess` does not apply to the navigated (hosted) iframe. It applies to `code.js` and to the first document.
- Figma adds the `--figma-color-*` variables only to the first document. `code.js` gives the theme class to the hosted UI in the URL hash.
- Figma Desktop 126 (Chromium 150) loads `http://localhost` in the plugin iframe. Local Network Access does not block it.
- In Figma Desktop, messages from `code.js` do not come from `window.parent`. The UI checks the origin (`https://www.figma.com`), not the source window.
- `chatgpt.com` allows CORS from `http://localhost:5173`, but not from the hosted origin.
- A Sign in with ChatGPT token on `api.openai.com` accepts only newer models (not `gpt-4`).

VPS facts (read-only checks):

- Ubuntu 24.04. Host Caddy v2.11 handles TLS on ports 80 and 443. Dokploy (Docker Swarm, Traefik) runs other apps.
- `*.maxschulmeister.dev` points to the VPS. The records are DNS-only (Cloudflare does not proxy them).
- CoreDNS listens on the Tailscale IP the Tailscale IP of the VPS. Its `hosts` block resolves private names (for example `system.maxschulmeister.dev`) to that IP for tailnet devices.
- Caddy blocks for private names use `@tailscale remote_ip 100.64.0.0/10 fd7a:115c:a1e0::/48`. Other requests get `404`.
- This Mac resolves `system.maxschulmeister.dev` to the Tailscale IP of the VPS and gets `200`.

## Architecture

Phase 8 replaced the VPS: the FigPal command on the Mac serves the UI and the routes (`local/ui-server.ts`). The diagram and the hosting section below show the state before Phase 8.

```
Figma Desktop
└─ FigPal plugin
   ├─ code.js (main thread)
   │   ├─ execute queue: figma_execute, screenshots, createImage
   │   ├─ events: selection and page changes → UI
   │   └─ clientStorage: settings
   └─ iframe → https://figpal.maxschulmeister.dev/   (hosted UI)
       ├─ React + assistant-ui
       ├─ pi-durable Harness
       │   ├─ IndexedDB "figpal:file:<fileId>"  (threads, tasks, transcripts)
       │   └─ IndexedDB "figpal:global"          (skills)
       ├─ extensions: figma · subagent · skills · web
       └─ models: Anthropic direct · ChatGPT direct or through a Caddy route

VPS (reached through Tailscale)
├─ CoreDNS: figpal.maxschulmeister.dev → its Tailscale IP for tailnet devices
└─ host Caddy: figpal.maxschulmeister.dev, @tailscale only, else 404
    ├─ file_server /srv/figpal   (built UI)
    └─ optional reverse_proxy routes, same origin:
        /api/skills/* → skills.sh · /api/chatgpt/* → chatgpt.com
```

### Message flow for a tool call

1. The model calls `figma_execute` in the UI (pi-durable tool task).
2. The UI sends `{ id, type: "execute", code, timeoutMs }` to `code.js` with `parent.postMessage({ pluginMessage, pluginId }, "https://www.figma.com")`.
3. `code.js` puts the call in a queue. It runs one call at a time.
4. `code.js` sends back `{ id, ok, result | error, attachments[] }`.
5. The tool returns the result to the model. Images go to the model. Other files become a download in the UI.

## Repository layout

```
figpal/
├─ PLAN.md
├─ package.json            pnpm workspace
├─ plugin/                 manifest.json, src/code.ts (built to code.js)
├─ web/                    hosted UI (Vite + React + assistant-ui + figma-kit + pi-durable)
│  └─ src/extensions/      figma.ts; later subagent, skills, web
├─ deploy/                 Caddy block, CoreDNS line, deploy script (rsync to /srv/figpal)
└─ shared/                 message protocol types (UI ↔ code.js)
```

## Components

### Plugin (`plugin/`)

- `manifest.json`:
  - `id: "figpal"`, `name: "FigPal"`, `editorType: ["figma"]` (add `figjam` and `slides` later).
  - `documentAccess: "dynamic-page"`, `enablePrivatePluginApi: true` (for `figma.fileKey`).
  - `networkAccess.allowedDomains`: `https://figpal.maxschulmeister.dev`, the model APIs, `api.figma.com`, GitHub, the image and search services. Use `"*"` with a `reasoning` text if the list becomes too long.
  - `devAllowedDomains`: `http://localhost:<port>` for the UI dev server.
- `code.ts`:
  - `figma.showUI('<script>location.href="https://figpal.maxschulmeister.dev/"</script>', { themeColors: true, width, height })`. A setting in clientStorage (`figpal.ui`: `remote` or `local`) selects the UI URL. `local` is the Vite dev server. The window title shows the setting ("FigPal (remote)"). The page and the offline page can switch it.
  - **Load check:** `code.js` waits for a `ready` message from the UI. If no message comes in time, it shows a small local page: "Cannot reach FigPal. Connect Tailscale and run the plugin again."
  - Message router with request IDs.
  - **Execute:** wrap the code in an async IIFE and run it with indirect `eval` (global scope, no access to the plugin's locals). Top-level `await` and `return` are supported. The result is JSON. There is a timeout and an output limit (about 20 KB, like `use_figma`). Copy the result analysis from figma-console-mcp `code.js` (MIT).
  - **Helpers** in the execute scope (`pi.*`):
    - `pi.attach(bytes, { mime, name })` sends a file to the UI.
    - `pi.context(node, opts)` returns compact node JSON (port of the figwright serializer, MIT).
    - More helpers later (lint, Motion).
  - **Screenshot:** `exportAsync` to PNG, with a scale limit.
  - **File ID:** use `figma.fileKey` if available. If not, use a UUID in `figma.root.getPluginData("figpal.fileId")`, made on first use. A duplicated file copies the UUID, so the copy starts with the same thread list.
  - **clientStorage API** for the UI: `get`, `set` and `delete`, restricted to the `figpal.` prefix.
  - **Events:** selection and current page changes go to the UI.
  - **Run in background:** `figma.ui.hide()` and show again. Check if the iframe keeps running when it is hidden.

### Hosted UI (`web/`)

- React + assistant-ui with an `ExternalStoreRuntime`. The pi-durable `viewState()` of the conversation feeds it (`web/src/transcript.ts`).
- Screens:
  - Thread list for the current file: new, fork, rename, delete.
  - Chat: streamed text, tool calls (collapsible), subagent transcripts under their call, attachments.
  - Settings: providers and models, enabled models (for the model menu and subagents), skills, web search, export and import.
- Every user message gets a short context block: file name and page. Node references (IDs, names, types) come from the selection chips at their places in the message.
- Harness setup for each file: `IndexedDbStorage.open("figpal:file:<fileId>")` inside a Web Lock, then `harness.resume()`. Call `navigator.storage.persist()`.
- If a second plugin window opens the same file, it shows a notice. (pi-durable 1.4.0 `IndexedDbStorage` has no `readOnly` option.)

### Models and authentication

- A credential store in the `localStorage` of the UI origin, by provider. Code from `figma_execute` cannot read it.
- **Claude:** you paste the token from `claude setup-token`. No refresh is needed. A browser port of Pi Black wraps the Anthropic provider for OAuth request compatibility (Claude Code `2.1.280`). API-key requests stay unchanged. See [Pi Black integration](docs/pi-black.md) for the pinned source, checks, and limits.
- **ChatGPT:** device code login in the UI (`auth.openai.com` allows CORS). Token refresh also uses `auth.openai.com`. pi-ai's Codex OAuth module needs Node, so `web/src/providers/chatgpt.ts` is a browser port of its device code login and refresh (MIT). Inference goes through the route `/api/chatgpt/backend-api` (Caddy, and the dev server), because `chatgpt.com` allows CORS only from `localhost` (spike 0.4). pi-ai's "Sign in with ChatGPT" (`api.openai.com`) fails from the remote origin.
- **API keys:** for every provider that allows browser calls.
- **Provider wrapper:** wrap the pi-ai provider to add server tools with `onPayload`:
  - Anthropic: `web_search_20250305`, `web_fetch_20250910`.
  - OpenAI Responses: `{ type: "web_search" }`.
  - Make sure that pi-ai ignores the server tool blocks and keeps the text and citations.

### Extensions

#### `figma`

| Tool | Description | Replay |
|---|---|---|
| `figma_execute(code, timeout_ms?)` | Runs Plugin API JavaScript. Top-level `await`, `return` gives JSON. `pi.*` helpers are available. | Not safe (`interrupted` after a restart) |
| `figma_screenshot(node_id?, scale?)` | Returns a PNG of a node or of the viewport | Safe |
| `figma_rest(method, path, body?)` | Figma REST API with a personal access token: comments, versions, library search across files | Not safe (a POST must not run two times) |

- A short rules section in the system prompt, written in our own words: fonts, `layoutSizing` order, read-only paints, pages, colors in the 0–1 range, return node IDs, verify with a screenshot.
- Goal: less than 3k tokens for all tool schemas plus the rules.

#### `subagent`

- One tool: `subagent({ tasks: [{ task, model? }] })`. It runs all tasks in parallel and returns all answers.
- Each task is a child conversation that the call owns (`ownership: { kind: "task" }`, `replay: "safe"`, like pi-durable example 21).
- A subagent is a copy of the main agent: the same model, tools and skills. `model` must be one of the enabled models in the settings.
- Subagents cannot start subagents.
- For parallel canvas work, the orchestrator gives each subagent its own frame or section (node IDs). The `code.js` queue runs Figma calls one at a time.

#### `skills`

- Storage: `figpal:global` IndexedDB, with `{ name, description, files[], source, hash, enabled }`.
- Prompt section: the name and description of each enabled skill.
- Tools:
  - `skill_read(name, path?)`
  - `skill_grep(name, pattern)`, for large references such as the Plugin API typings.
- Install:
  - Paste `npx skills add owner/repo[@skill]`, a skills.sh URL, or a GitHub URL.
  - Search and download use the skills.sh API through the Caddy route `/api/skills/*`.
  - The fallback is the GitHub Trees API plus `raw.githubusercontent.com` (60 requests per hour without a token).
  - You can also upload a zip.
- Update: compare `hash`, like the skills CLI.
- Default skills: the 16 skills in `skills/` of Figma's `figma/mcp-server-guide`. FigPal downloads them from skills.sh at the first start. Their repo has no license, so FigPal does not ship them.

#### `web`

- Provider-native web search through the provider wrapper (`throughRoute` in `agent.ts`). A prompt section asks for the sources as Markdown links.
- Images: the agent finds an image URL with web search, and `figma_execute` calls `figma.createImageAsync(url)` (`allowedDomains: ["*"]`). No image search tool and no API keys (decision 2026-10-31).
- Not built (decision 2026-10-31): the Tavily fallback, `web_fetch`, and image bytes from the UI to `figma.createImage`.

### Hosting (`deploy/`, removed in Phase 8)

Static files only. The host Caddy serves them. Only tailnet devices can reach them. The server stores no user data: threads stay in Figma Desktop's IndexedDB on the Mac.

Setup on the VPS (one time, in Phase 0, with your approval):

1. CoreDNS: add `<Tailscale IP> figpal.maxschulmeister.dev` to the `hosts` block in `/etc/coredns/Corefile`. Restart CoreDNS.
2. Caddy: add this block to `/etc/caddy/Caddyfile`, next to `system.maxschulmeister.dev`. Do not add it to `dokploy-apps.caddy`, because `caddy-dokploy-sync` writes that file. Run `caddy validate`, then reload Caddy. The block below is the outline. The current block, with the proxy routes and correct cache headers, is `deploy/Caddyfile.figpal`.

```caddyfile
figpal.maxschulmeister.dev {
	@tailscale remote_ip 100.64.0.0/10 fd7a:115c:a1e0::/48
	handle @tailscale {
		# Optional proxy routes go here (see below).
		root * /srv/figpal
		header /assets/* Cache-Control "public, max-age=31536000, immutable"
		header /index.html Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
	handle {
		respond "Not Found" 404
	}
}
```

3. Create `/srv/figpal`.

Deployment: `pnpm deploy:web` builds `web/` and copies `web/dist/` to `/srv/figpal/` on the VPS with rsync (removed in Phase 8).

Headers:

- No `X-Frame-Options`. Figma must show the page in its iframe.
- As hardening, try `Content-Security-Policy: frame-ancestors https://www.figma.com` (spike 0.12).

Development: Vite serves the UI on `localhost`. The development build of the plugin goes to that URL. Vite's dev proxy has the same `/api/*` routes as Caddy.

#### Optional proxy routes

Add a route only when a spike shows that a direct call fails. The routes are on the same origin as the UI, so CORS does not apply. Only the tailnet can reach them, so they need no secret. Examples:

```caddyfile
handle_path /api/skills/* {
	rewrite * /api{uri}
	reverse_proxy https://skills.sh {
		header_up Host skills.sh
		header_up -Origin
	}
}
handle_path /api/chatgpt/* {
	reverse_proxy https://chatgpt.com {
		header_up Host chatgpt.com
		header_up -Origin
	}
}
```

Rules:

- Fixed hosts only. Never an open proxy.
- Caddy must not log request headers (credentials).

## Storage summary

| Store | Scope | Contents |
|---|---|---|
| `clientStorage` | Plugin ID, device | Settings (`figpal.settings`: model and thinking level of new threads, enabled models), the UI source (`figpal.ui`). No secrets: code from `figma_execute` can read it. |
| `localStorage` | Hosted origin | Credentials (`figpal.credentials`): the model accounts and the Figma token (`figma`). Each UI origin (remote, local) has its own. |
| IndexedDB `figpal:file:<fileId>` | Hosted origin | pi-durable session for the file: the thread list (`figpal.threads`), conversations, tasks, transcripts, attachments |
| IndexedDB `figpal:global` | Hosted origin | Skills. Version 3 has an empty `agents` store (see "Agent profiles" in `NOTES.md`). |
| `figma.root` plugin data | Document | `figpal.fileId` (fallback only) |

Rules:

- Never change the plugin ID. clientStorage data belongs to it.
- Never change the UI origin without a migration. IndexedDB data belongs to it.

### Domain migration

1. The new UI opens a hidden iframe on `<old-origin>/migrate`.
2. That page reads all of its IndexedDB object stores and its `localStorage` (the credentials) and sends them to the new origin with `postMessage` (strict origin checks on both sides).
3. The new UI writes them, checks the counts, and marks the migration as done.
4. Manual fallback: "Export all" and "Import" in the settings (one file).

## Code to reuse (MIT, keep the license notices)

| Source | Part | When |
|---|---|---|
| figma-console-mcp `figma-desktop-bridge/code.js` | `EXECUTE_CODE` wrapper and result analysis | Phase 1 |
| figwright `packages/plugin/src` | Serializer (`get-design-context`), yielding during long reads, duplicate-safe retries | Phase 1–2 |
| figwright | Motion helpers, video export settings | Phase 6 |
| figma-console-mcp `code.js` | `LINT_DESIGN`, `AUDIT_COMPONENT_ACCESSIBILITY`, `ANALYZE_COMPONENT_SET` | Phase 6 |
| figma-console-mcp `src/core/tokens` | Token parsers and formatters (6.1k lines, 1 Node file to replace) | Phase 6 |
| figma-console-mcp `src/core/diff` | Version diff engine (886 lines, no Node) | Phase 6 |
| figma-console-mcp `src/apps/design-system-dashboard/scoring` | Design-system audit scoring (3.1k lines, no Node) | Phase 6 |

## Phases

Each phase ends with its checks.

### Phase 0: spike (remove the main risks)

Build the minimum: a plugin that goes to a local and a hosted page, with one hard-coded tool. Do the one-time VPS setup (CoreDNS line, Caddy block, `/srv/figpal`) and deploy a test page.

| # | Check | Pass condition |
|---|---|---|
| 0.1 | IndexedDB in the hosted iframe | Data stays after you restart Figma Desktop. |
| 0.2 | `networkAccess` with a hosted iframe | Calls to the UI origin and `api.anthropic.com` work. Calls to domains that are not on the list fail. |
| 0.3 | Claude setup-token from the iframe | A streamed answer works. If the browser drops the `user-agent` header, record the effect. |
| 0.4 | ChatGPT | Device login works. Record the result of a direct inference call. If it fails, test the Caddy route `/api/chatgpt/*`. |
| 0.5 | pi-durable browser bundle | It builds with Vite. Record the bundle size (QuickJS, photon, TypeBox). |
| 0.6 | Execute | `eval` of an async IIFE works. Timeout and output limit work. |
| 0.7 | Resume | Close the plugin during a run. Open it again. The run continues, and `figma_execute` gives `interrupted`. |
| 0.8 | Provider-native search | `web_search` works with the Claude token and with ChatGPT. pi-ai keeps the text. |
| 0.9 | `createImageAsync` | Works with an image URL from a host without CORS. |
| 0.10 | `figma.fileKey` | Available in a development plugin with `enablePrivatePluginApi`. |
| 0.11 | Hidden UI | After `figma.ui.hide()`, the iframe keeps running and a run continues. |
| 0.12 | `frame-ancestors https://www.figma.com` | Figma Desktop still shows the page. If not, remove the header. |
| 0.13 | Tailscale DNS in Figma Desktop | Figma Desktop (Electron) resolves `figpal.maxschulmeister.dev` to the Tailscale IP of the VPS and loads the page. A request from outside the tailnet gets `404`. |
| 0.14 | Tailscale off | The plugin shows the "Connect Tailscale" page. It does not hang. |
| 0.15 | skills.sh | Record if search and download need the Caddy route. Test the GitHub fallback. |
| 0.16 | Theme colors | Record if Figma adds the `--figma-color-*` variables to the hosted iframe. |

Write the results in `docs/spike.md`. Change this plan where a check fails.

### Phase 1: MVP

Status: code done (2026-10-30). Unit tests, and an end-to-end run in Chrome (fake `code.js`, scripted Anthropic answers, a reload during a tool call) pass. The manual checks in Figma Desktop are open.

- Workspace setup: pnpm, TypeScript, Vite, lint, Vitest.
- Plugin: router, execute queue, screenshot, file ID, clientStorage API, events.
- UI: one thread, chat, tool call display.
- `figma` extension with the rules section.
- Claude through the setup-token.

Checks:

- Unit tests for the message protocol and the execute wrapper.
- Manual test: "Make a card with auto layout", then a screenshot check.
- Resume test (same as 0.7).

### Phase 2: threads and settings

Status: code done (2026-10-30). Unit tests and an end-to-end run in Chrome (mocked Claude, ChatGPT login and route) pass. The manual checks in Figma Desktop are open.

- Thread list for each file: new, fork, rename, delete, last open thread.
- Settings: credentials, default model, thinking level.
- ChatGPT device login, with the Caddy route if needed.
- Credential writes in a Web Lock: two FigPal windows share clientStorage, and an OAuth refresh must run only once (Phase 1 review).
- A second window shows a notice. pi-durable 1.4.0 has no read-only storage (done in Phase 1).

Checks:

- Two files have separate thread lists.
- Restart Figma: the threads are still there.
- A second window shows the notice.

### Phase 3: skills

Status: code done (2026-10-30). Unit tests and an end-to-end run in Chrome (real skills.sh and GitHub, scripted Claude) pass: `figma-use` installs, and `skill_grep` finds `interface FrameNode` in its typings. The manual check in Figma Desktop (the model loads the skill when it must) is open.

- Global skills store, prompt section, `skill_read`, `skill_grep`.
- Install from skills.sh (Caddy route), GitHub fallback, zip upload, update, enable and disable.

Checks:

- The Figma skills install at the first start.
- Install a skill: paste `npx skills add owner/repo@skill`.
- The model loads `figma-use` when it must.
- `skill_grep` finds a type in the typings.

### Phase 4: subagents

Status: code done (2026-10-31). Unit tests (scripted model: parallel run, the model of a task, abort, restart) and an end-to-end run in Chrome (two subagents ask the model at the same time, a reload during a run, Stop) pass. The manual check in Figma Desktop is open.

- Enabled models (like pi's scoped models), for the model menu and for subagents.
- `subagent` tool with parallel tasks, child transcripts in the UI.

Checks:

- Two subagents build two sections in parallel without conflicts.
- Abort stops both.
- A restart during a subagent run continues correctly.

### Phase 5: web

Status: done (2026-10-31). Unit tests and an end-to-end run in Chrome (scripted Claude, the CSP on the remote UI, the credential move) pass. The user tested web search with sources and image placement in Figma Desktop.

- Provider wrapper for native search and fetch.
- Tavily fallback, `image_search`, image placement (`createImageAsync`, then direct bytes). Built: image placement with `createImageAsync`; images come from web search (see the decision log).
- Caddy: `Content-Security-Policy: img-src 'self' data:` (and the image hosts that the UI must show), so that no image URL from model output can load without a click. The chat already shows markdown images as links (Phase 1). Follow the VPS procedure.

Checks:

- "Find a hero photo of mountains and put it in the selected frame."
- A search answer shows its sources.

### Phase 6: Figma depth

- `figma_rest` with a personal access token.
- Copied modules: lint and accessibility, component set analysis, tokens export, version diff, design-system audit.
- Motion helpers and video export through `pi.attach`.

Checks:

- Export a Motion frame to MP4.
- Run the accessibility audit on a component.
- Export tokens to DTCG and download them.

### Phase 7: polish

Scope (user decision, 2026-11-01). Details of the requests are in `NOTES.md`.

- Browser checks in the repo (`e2e/`, `pnpm e2e`): the Chrome checks of `/tmp/pw` with real pass/fail results.
- Token budget check: measure the tool schemas and the rules, then make them smaller (done: a unit test limits them to 3,200 tokens).
- Run in the background (hidden UI): `figma.ui.hide()` keeps the UI running. Find out first how the user shows it again.
- UI requests: the model picker closes when the user picks a model; a resizable panel at full height; the context window usage next to the model picker.
- Layer chips in the agent's answers.
- TypeScript only: `checks.js` and `plugin/build.mjs` (done).
- Local files and outside agents, with the optional Node host. Choose and plan before building (done: the local helper; remote threads and the Node host stay in `NOTES.md`).
- Done before this phase: light and dark theme (figma-kit tokens, theme class from the URL hash, spike 0.16).

Checks:

- Measure the token size of the tool schemas and the rules (goal: less than 3k; result: about 3,130 with the rules for skills, limit 3,200).
- The agent finishes a task while the UI is hidden.

### Phase 8: public launch

Decisions (user, 2026-11-05):

- **Where:** GitHub and npm (the package `figpal`), not the Figma Community. Figma's review guidelines refuse "a general-purpose AI chat interface in Figma, including … bring their own API key" and plugins that "expose an MCP server". Users import the manifest in Figma Desktop, as a development plugin.
- **No hosting:** the npm package has the UI, the plugin and the local helper. The helper serves the UI and the routes on `http://localhost:9310`. This reverses "No local UI" (2026-11-03). Without a public server, the routes are not open relays, and `code.js` and the UI always come from the same version. The VPS site goes after the user moved his data.
- **macOS only.** Windows (Figma Desktop also runs there) is later.
- **Accounts:** the Claude token (Pi Black) and Sign in with ChatGPT stay. The README says that the use of a subscription is unofficial and that API keys are the alternative.
- **Models:** all providers of pi-ai, with API keys, also those that need more fields (Azure, Cloudflare, Bedrock, Vertex), in a settings UI for many providers.
- **License:** AGPL-3.0. apca-w3 and colorparsley (AGPL) stay.
- **The local helper and MCP** are part of the launch.
- **The user's data moves:** export on the old UI, import in the new one. The user enters the keys again: the file has no secrets.

Work, in this order:

1. Export and import of the chats and skills. One last deploy of the old UI, for the export.
2. The helper serves the UI and the routes. The plugin loads the local UI, and tells the user how to start FigPal when the helper does not run.
3. The npm package: `npx figpal install` and `npx figpal uninstall`.
4. All providers.
5. License, notices, README, CI, a secret scan of the history. VPS details out of the repo.

Checks: a clean macOS user account with only Node: `npx figpal install`, import the manifest, connect a key, the manual checks of Phases 1–7; an agent with `figpal mcp`.

Status (2026-11-05, branch `feature/public-launch`, not merged): code done for steps 1–5, with unit tests and browser checks (`backup`, `start`, `providers`). The old UI on the VPS has the backup (deployed from commit `99830d9`). The user's checks in Figma Desktop pass (2026-11-05): the first page without the command and its start by itself, Claude, ChatGPT, a provider with an API key, web search, an image on the canvas, MCP from Claude Code, a shared folder; the user's data moved with the backup. Done after that: the VPS site is gone (the Caddy block, the CoreDNS line and `/srv/figpal`; backups `*.bak-figpal-remove-20261105-231110` on the VPS; the health of the other 20 sites and 4 names is the same before and after), gitleaks found no leaks in 475 commits of all branches, the README is short for users (the build and the checks are in `CONTRIBUTING.md`). Not done (user decisions): the clean-account check, and a rewrite of the history (old commits name the Tailscale IP and the SSH user). Open: the npm publish. Not done (user decisions): Amazon Bedrock, and a confirmation before the first use of the rules of a file.

## Risks

| Risk | Effect | Action |
|---|---|---|
| pi-durable is experimental, and its API changes without notice | Breaks on upgrade | Pin the version. Put the pi-durable API behind a small adapter. |
| Subscription terms of the providers | Account risk | Check the terms. Keep API keys as an alternative. |
| Anthropic refuses browser requests for Claude subscription accounts ("CORS requests are not allowed for this Organization"). Chromium also replaces the `user-agent` that the page sets. | No direct Claude calls from the UI | Spike 0.3: the route `/api/anthropic` (dev server and Caddy) removes the browser headers and sets the Claude Code user-agent. |
| ChatGPT inference blocked by CORS | No direct ChatGPT | Caddy route. Cloudflare in front of `chatgpt.com` can challenge VPS IPs. |
| VPS is down or Tailscale is off | The plugin cannot load its UI | Caddy runs as a system service. The plugin shows "Connect Tailscale". Later: a service worker caches the UI. |
| Figma Desktop does not use the Tailscale DNS | The UI does not load | Spike 0.13. Fallback: a Tailscale-only Caddy site on the `ts.maxschulmeister.dev` names, or the Tailscale IP with its own certificate. |
| Chromium Local Network Access blocks a local address (`localhost`, `100.64.0.0/10`) in the plugin iframe | The dev server and the Tailscale-only UI do not load | Spike 0.13 and the local run. Chrome 156 blocks it. Fallback: static files on the public IP (no secrets in them), or a bundled UI. See `docs/spike.md`. |
| IndexedDB is cleared with the Figma cache | Threads are lost | `navigator.storage.persist()`, export, optional sync to the VPS later. |
| Figma skills have no license | Cannot be shipped with FigPal | Install them per user from skills.sh only. |
| Long `figma_execute` calls block Figma | Figma does not respond | Timeout, yielding helpers, rules section. After a timeout, canvas calls fail until the old call ends. |
| Code from `figma_execute` runs in the same sandbox as `code.js` | It can read `figma.clientStorage` and the open file. Since Phase 5, `allowedDomains: ["*"]` lets it send data to any host with `fetch` or an image URL, and `figma.openExternal(url)` opens the browser. A prompt injection (in the file, in a skill, in web results) can use this. | The credentials are in the storage of the UI since 2026-10-31, out of reach of this code and of the model. Accepted: injected code could send content of the open file out (the code shows in the chat as "Run code"). With a Figma token, the agent can also read (and, with write scopes, change) other files through `figma_rest`, so the settings recommend read-only scopes. A check for network calls in the code would be easy to get around. Skills are instructions for the model: install only skills that you trust. |

## Decision log

2026-10-29:

- Plugin ID `figpal`. Development plugin only. Figma Desktop only.
- Hosted UI (option C) instead of a bundled UI with a storage page (option B): less code, and both need the VPS at start.
- UI on `figpal.maxschulmeister.dev`: static files through the host Caddy, Tailscale only. No Dokploy app and no server process.
- Proxy routes in Caddy only when a spike shows the need.
- Private GitHub repo `maxschulmeister/figpal` as the remote (backup, not for deployment).
- Credentials stay in `figma.clientStorage`, also if `figma_execute` code can read them.
- VPS setup done: CoreDNS line, Caddy block (`deploy/Caddyfile.figpal`), `/srv/figpal`.
- Run the `simplify` review after each phase.

2026-10-30:

- The hosted UI stays (no local server that must always run). A UI inside the plugin (null origin) has no IndexedDB, and it cannot call Claude.
- Claude goes through the route `/api/anthropic`: in the dev server and in Caddy on the VPS. The token passes through the VPS. Caddy does not store it.
- Phase 1:
  - The chat replaced the spike page. The request types `hide` and `create-image` went with it: Phase 5 (images) and Phase 7 (run in background) add them again. The spike code is in commit `bdd8cd5`.
  - `allowedDomains` has only the UI origin, because `networkAccess` does not limit the hosted UI (spike 0.2). Phase 5 changes it to `"*"` for images.
  - Credentials are a pi-ai `CredentialStore` on the clientStorage key `figpal.credentials`. The spike key `figpal.spike.anthropic` is not read: paste the token again once.
  - The route is a provider wrapper (`throughRoute`), not a proxy around `Models`.
  - The model is `claude-sonnet-5-5` until the Phase 2 settings.
  - The file storage is IndexedDB `figpal:file:<fileId>`. The spike databases (`figpal:spike:file:*`) stay unused.
  - The UI is not in React `StrictMode`: its double start of effects would open the file storage twice, and the Web Lock would refuse the second one.
  - Lint: Biome, lint rules only (no formatter).
  - Markdown images in answers show as links. A loaded image URL could send data out without a click (for example after a prompt injection in the file). Tool screenshots are `data:` URLs.
  - Stop does not wait for code.js: a tool call stops at once. code.js cannot stop the code, and its queue runs the next call after it.
- Phase 2:
  - The thread list is a pi-durable session document (`figpal.threads`) in the storage of the file, not in clientStorage. A new thread or fork commits together with its list entry. The Phase 1 chat (the root conversation) becomes the first thread.
  - Delete removes a thread from the list. pi-durable cannot delete a conversation, so its entries stay in IndexedDB.
  - Fork: "Fork from here" on an answer. The fork keeps the history and the model up to that answer.
  - Model and thinking level: a picker for the open thread. The last choice is the setting for new threads (clientStorage, all files).
  - ChatGPT: a browser port of pi-ai's device code login and refresh. pi-ai refreshes the token in the credential store's Web Lock. Closing the settings stops a login.
  - The first thread opens only after a provider is connected, with that provider's model. Thread actions run one at a time (a double click makes one thread).
- Phase 3:
  - The store is IndexedDB `figpal:global` with object stores for the skill list and for the files of each skill. The list does not load the files (`figma-use` has 650 KB of references). Version 2 adds `meta`.
  - Default skills: at the first start, FigPal installs the 16 skills in `skills/` of `figma/mcp-server-guide` from skills.sh, in the background (user request). `meta` records when all are installed, so a removed skill stays removed. A failed download is tried again at the next start. The record is in `figpal:global`, not in clientStorage: a cleared database gets the skills again. Some of these skills need Figma MCP tools that FigPal does not have (`create_shader`, `generate_diagram`, `create_new_file`, `create_generative_plugin`) or a codebase (Code Connect, design to code).
  - The first test in Figma: the model read `figma-use`, then asked for `figma-generate-design` (`figma-use` links `../figma-generate-design/SKILL.md`), which was not installed. Now the section says that such a link is a skill, and what to do when a named skill is not in the list. The error lists the enabled skills.
  - Install: from skills.sh through `/api/skills`. GitHub only when skills.sh does not answer; an invalid skill from skills.sh stays an error. In a repository, a folder under `skills/` comes first (figma/mcp-server-guide has `figma-use` in two folders). Binary files stay out.
  - Update: compares the hash of the same source (the skills.sh hash, or the GitHub tree SHA of the folder). A zip has no updates.
  - `skill_read` gives a long file in parts of at most 40 KB and 1500 lines, below pi-durable's tool output limits (50 KB, 2000 lines), so that the "Read more" note stays.
  - The skills section tells the model to use `figma_execute` for `use_figma` and `figma_screenshot` for `get_screenshot`, and to do the work of other Figma MCP tools with `figma_execute`.
  - The agent `skills` filter was planned with agent definitions in Phase 4. Phase 4 did not add them (see the 2026-10-31 log): all enabled skills are in the prompt.
  - Settings is a full-window dialog with the tabs Models and Skills. Both tabs stay mounted, so a tab switch does not stop a login or an install.
  - `skill_grep` runs in a Web Worker and stops after 2 seconds. A pattern from the model can backtrack for minutes on one line (spike: `interface\s+(\w+\s*)+\{` on the Plugin API typings), and pi-durable runs the tool again after a restart.
  - Skill names and descriptions go into every system prompt, so the install makes them one line without `<` and `>`, with at most 64 and 1024 characters. The settings show two lines of the description (all of it in the tooltip) and the source.
  - Find a skill: results show while the user types (skills.sh search after 300 ms, at least 2 characters). A pasted install command or URL shows its skill at once with **Install**; Enter installs it. `owner/repo` without the command is search text (`ui/ux`).
  - A skill from a repository list installs like any skill: skills.sh first, then the same folder on GitHub.
  - `figpal:global` closes itself when a newer FigPal upgrades the database (Phase 4 adds agents).
  - figma-kit's submenu trigger makes a Base UI warning in development builds ("render prop received a function named Nr"). Its minified build renames a render function. It is harmless.

2026-10-31:

- Phase 4:
  - `subagent({ tasks: [{ task, model? }] })` makes all children in one commit, owned by the tool task, and runs them at the same time. A child is a copy of the thread's agent without the `subagent` extension, so it has the same tools and cannot start subagents. It starts without history: the main agent must write each task so that it stands alone (the section says so, and to give each subagent its own frame).
  - A rerun after a restart finds its children (`scanConversations` by owner task) and its submissions (request ID), and it does not check the model again: the allowed models can be different now.
  - No agent profiles (user decision, after a first build with Markdown agent definitions). A subagent is a copy of the main agent, and the main agent writes the role and the rules into each task. Profiles would also need a picker for the main agent, and a stale profile (a removed model) can make a subagent fail. They are a later task. The test build made `figpal:global` version 3 with an `agents` store, so the version and the empty store stay: a database cannot go back to a lower version.
  - Enabled models (user request, like pi's scoped models `enabledModels`): one list in `figpal.settings` for the chat's model menu and for subagents. No selection means all models of the connected providers. If no enabled model is of a connected provider, all apply, so the menu is never empty. The main agent can give a task only an enabled model; without one, a subagent uses the thread's model. The extension reads the list from the settings in memory, not from `code.js`: the sections render before each model request, and a busy `code.js` (a long `figma_execute` in another subagent) must not delay them.
  - The Models tab edits the list with figma-kit's `Combobox` (Base UI): multiple selection, a search field, a group for each provider. A checkmark adds a model; no checkmark means all models, so a short list takes a few clicks. Below the combobox, the selected models show as a list, each with a remove button (user request). The choices for a provider that is not connected stay. A first build had a checkbox for each model ("Models for subagents"): too long, and only for subagents.
  - The models come from the pi-ai catalog of the pinned version (1.4.0, 2026-10-21). pi's source has newer models (for example GPT-6.1 Terra) before a release has them: a pi-ai upgrade adds them.
  - The chat shows each subagent under the call: its task (one line while closed), and when opened, its transcript: a read-only assistant-ui runtime for each child, with the chat's components, without "Fork from here". The tool details name the children; while the call runs, they come from `pi.live`.
  - Simplify review:
    - A subagent transcript loads only while its panel is open, and it depends only on the stable `openConversation`. Before, each App render (each Figma selection event) loaded every child view again on the Session line.
    - Each answer gets an equal part of 40 KB, so that pi-durable's output limit cannot drop the last subagents. A failed subagent gives its error detail (for example a rate limit). `</subagent` in an answer is escaped.
    - The subagent tool checks that an allowed model is in the catalog. The agent sees only the allowed models of connected providers.
    - Open (low likelihood): a run that continues at start-up before the settings load sees no allowed models. A fix changes the start order.
  - Settings (user request): the header of the full-window dialog is "‹ Settings" with the tabs on the right, as the chat list has "‹ Chats". Before, an X on the right sat right under the X of the plugin window, which closes FigPal. Both back arrows have the tooltip "Back". The dialog stays, so the chat (and a message that is not sent) stays open behind it.
  - The header (found in the Phase 4 test): figma-kit's `Button` has `flex-shrink: 0`, so a long thread title pushed the buttons out of the window and gave it a horizontal scroll bar. The title button now shrinks (bug since Phase 2).
  - Cmd+A (found in the Phase 4 test): on macOS, the app's Edit menu selects text, and in Figma Desktop that menu item is Figma's own command. The plugin window gets the key event but no selection. `main.tsx` selects the text of the focused input or text area, and stops the key there.

2026-10-31 (Phase 5):

- Native web search: `throughRoute` adds the provider's own tool to each request with pi-ai's `onPayload` (Claude `web_search_20250305` with `max_uses: 5`, ChatGPT `{ type: "web_search" }`), after an `onPayload` of the caller. Pi Black keeps it. Subagents get it too.
- pi-ai 1.4.0 keeps only the answer text: it drops Anthropic's `server_tool_use` and `web_search_tool_result` blocks and the citations, and OpenAI's `url_citation` annotations. So the `web` section tells the model to end a search answer with its sources as Markdown links; the chat opens them in the browser.
- No image search tool and no API keys (user decision, after the Figma test): the agent finds images with web search and places them with `figma.createImageAsync`. The web section says how: a direct PNG, JPEG or GIF URL (a WebP or AVIF URL fails; many hosts give a JPEG with a format parameter such as `?fm=jpg`), an image whose license lets the user use it, and the creator and license in the answer when it is not CC0 or public domain. A first build had `image_search` with Openverse and Wikimedia Commons (no key, CORS `*`). It was removed: Openverse's search often did not answer (also from curl, while its other endpoints did), Wikimedia has few stock photos, and sources with better photos (Unsplash, Pexels) need keys.
- Placement: `figma_execute` calls `figma.createImageAsync(url)` (rule in the figma section). The manifest has `allowedDomains: ["*"]` with a reason (spike 0.9).
- Caddy: `Content-Security-Policy: frame-ancestors https://www.figma.com; img-src 'self' data:` (VPS procedure: health snapshots the same before and after, only the figpal route changed). A `data:` image loads; an image from another host is blocked.
- Credentials (user decision, after the simplify review): `allowedDomains: ["*"]` lets code from `figma_execute` send data to any host without a click. With the credentials in clientStorage, that code could read and send the Claude token and the ChatGPT login. An allowlist of image hosts would block Unsplash, Pexels and URLs that the user gives. So the credentials moved to the `localStorage` of the UI origin, which that code cannot read; this replaces the decision of 2026-10-29. The first use moves the credentials of an older FigPal there and deletes them from clientStorage. The local and the remote UI have different origins, so each has its own login. `["*"]` stays.
- Left out, with the reason:
  - The Tavily fallback: both FigPal providers have native search.
  - Image bytes from the UI to `figma.createImage`: with `"*"`, `createImageAsync` loads from every host, and both take the same formats.
  - `web_fetch`: Claude's tool needs a beta header that only a live token can check. ChatGPT's search opens pages itself. Add it if a test shows the need.

2026-10-31 (Phase 6):

- Delivery (user decision): run simplify and commit after each chunk, not only after the whole phase. Chunk 1 contains REST access, the three copied checks, selection chips, and model controls. Token export, version diff, design-system scoring, and Motion export are later chunks.
- Chunk 1 review (three reviewers on the full diff, also the copied code). Fixed:
  - Lint loads styles and variables only for the rules that use them. The accessibility audit reads only the 20 color pairs that it checks. `figma_rest` keeps only the first 40 KB of an answer in memory.
  - Bugs in the copied checks (user decision: fix them in FigPal's copy and list each fix at the top of `checks.ts`; no report to figma-console-mcp). Large text uses Figma's numeric font weight. Contrast uses the colors that show (paint opacity), for text, controls and focus rings. An unknown lint rule throws. The three checks share one search for the default variant: Figma's default, or with a state axis the variant with a resting state value (whole values such as "Default" or "Enabled", so "Size=Base" does not count). Before, the lint and the audit took the first child. Variant names without a space after the comma work. A removed paint is `null` in `diffFromDefault`. An "Interaction" axis and names such as "Controls/Button" count as interactive, and presentational names (badge, tag, …) stay presentational. The lint walk lets timers and input run every 500 nodes.
  - Agent selections: Figma does not tell who changed the selection. A watch of the `selection` setter is not possible (Figma test 2026-11-01): the accessor on the page prototype cannot be redefined (`configurable: false`), and page objects are not extensible, so they cannot get an own property. A Proxy around the `figma` object that the code gets was rejected: comparisons such as `node.parent === figma.currentPage` would fail. So the rule stays: a selection change while `figma_execute` code runs counts as the code's, and so does the selection that the code left, until a different selection. Limit: a click by the user while code runs adds no chip.
  - Highlighted text stays when you select a node: the chip goes after it. A caret inside a word puts the chip after the word (user request), so the chip does not split the word.
  - The pi checks refuse a wrong node argument, such as a list of nodes, instead of a scan of the whole page.
  - `figma_rest` uses pi-durable's output limit (`outputLimits`: the first 40 KB), not its own buffer (user decision: the pi maintainers improve it), and stops reading after it. The model gets the same text. pi-durable's note counts only the bytes that FigPal read, so FigPal adds that the answer is longer.
  - Chip size: assistant-ui's directive parser reads at most 1024 characters of chip data, so a chip keeps the nodes that fit (about 20) and layer names of at most 40 characters (Figma names a text layer with its text). Selection events have the count of all nodes (`selectionCount`; code.js sends at most 50). The label shows the count of all ("300 Nodes"; the type only when all nodes are known), and the model gets "and N more".
  - The UI checks selection events at the entry point. An event of an older `code.js` (no page or `byAgent`) is ignored, with a console message to run the newest plugin.
  - The first chip of a new chat comes from the last selection of the user, not of the agent. Names in the `<figma>` block have no `<` or `>`.
  - Spaces (user request: one function, not separate rules): a chip has exactly one space before it and after it when text or a chip is next to it. Lexical node transforms run the function after each change of a chip or of the text next to one. Backspace or Delete next to a chip, or next to its space, removes the chip and the space after it.

- `figma_rest(method, path, body?)` in the `figma` extension. `api.figma.com` allows CORS from every origin (`*`, also for `X-Figma-Token` and POST), so the UI calls it directly, with no Caddy route.
  - The token is the credential `figma` in the UI's credential store (`localStorage`), out of reach of `figma_execute` code. pi-ai never lists the store, so an ID that is not a provider is safe.
  - The token goes only to `https://api.figma.com/v1/…` or `/v2/…`: a path such as `//host` is refused.
  - Errors give Figma's status and answer, and `Retry-After` for 429. Answers are cut after 40 KB with a hint (`depth`, `ids`, `/nodes`).
  - Replay is `unsafe`: pi-durable sets it per tool, and a POST must not run two times after a restart.
  - The `<figma>` block gives the file key (`figma.fileKey`, `FileInfo.fileKey`), so the model can build REST paths and file links.
  - Settings → Access (user decision 2026-11-01: "Figma" says nothing in a Figma plugin, and "API" reads like an API of the plugin): a token form, the same component as the Claude token (`TokenAccount`). FigPal does not check the token when you save it: every endpoint needs a scope, and the scopes are the user's choice.
- Checks from figma-console-mcp `code.js` (commit `5ef4df3`, MIT): `plugin/src/vendor/figma-console-mcp/checks.ts` (with its LICENSE) has the handlers `LINT_DESIGN`, `AUDIT_COMPONENT_ACCESSIBILITY` and `ANALYZE_COMPONENT_SET`. They are `pi.lint(node?, options)`, `pi.auditAccessibility(node?)` and `pi.analyzeComponentSet(node)` in `figma_execute`, so there is no new tool.
  - The top of the file lists the changes: functions that return or throw instead of messages, no logs, and no names of MCP tools.
  - `figma.variables.getVariableById` is sync, and a plugin with `documentAccess: "dynamic-page"` cannot call it. So the `token-misuse` rule did nothing. It now uses the names of the local variables, which the lint loads before the walk. Variables from libraries are not checked.
  - Biome skips `vendor/`: the copy keeps its style, so a later update is a simple diff.
  - figma-console-mcp's tests copy the math instead of running `code.js`, so none were ported. FigPal's tests run the copy through `execute` on a fake Plugin API tree.
- Model controls (user request): the model and thinking level are separate menus on the left below the prompt. The model menu ends with "Edit Models", which opens Settings → Models even if another settings tab was open. The thinking menu shows only the levels that the model supports.
- Selection chips (user request, like pen.dev): a message can be about more than one selection, for example "select a node, give feedback, select another, give feedback". The selection goes into the text as a chip, and each piece of feedback stays next to its node.
  - Rules: a new selection inserts a chip at the caret, with a space after it (not a second one if a space follows). If the caret is right after a chip and its space (nothing typed after it, or the user clicked the chip), the selection replaces it, and an empty selection removes it. Several selected nodes make one chip: "2 Frames" for one type ("Text layers" for text), else "5 Nodes" (user request). The field starts with a chip of the selection when the chat opens, and is empty after Send.
  - Keys: Backspace or Delete next to a chip removes the whole chip and its space, but keeps a space between two words. Chrome cannot move the caret over an inline element that is not editable, and Lexical's plain-text mode leaves that to Chrome, so the arrow keys jump over a chip in FigPal's code.
  - Selections that `figma_execute` code makes add no chip. `code.js` marks a selection event `byAgent` while the code runs (code that timed out runs until it ends), and also for the selection that the code left, until a different selection: Figma can report the change after the code ends. The event also has the page, because React state can be one event late after a page change.
  - Only the chips count: the `<figma>` block has the file and the page, no "Selection" line. The model gets each chip as `<nodes page="Home (0:1)">Card (FRAME, 1:2), …</nodes>` at its place in the text. The transcript keeps the chips (an assistant-ui directive `:node{…}` with the page and nodes as JSON). A thread title uses the chip labels. The selection line under the field was removed: the chips show it.
  - The field is assistant-ui's Lexical input (`@assistant-ui/react-lexical` 0.2.20, Lexical 0.53.0), because a textarea cannot show chips. A Lexical plugin (`selection-chips.tsx`) inserts the chips. An update while the user is in Figma skips the DOM selection, so the plugin window does not take the focus. Lexical handles Cmd+A and Cmd+Z in its own code: with the key events as Figma Desktop sends them (no menu command), both work in Chrome. The main bundle grew from 1.70 MB to 1.94 MB.
- Exports (user decision): an exported file stays in memory until FigPal closes, not in the thread. After a restart, the export step shows that the file is gone, with a button that runs the export again without the agent. That works because exports are read-only functions in `code.js`.
- Token export (part 2): the tool `figma_export_tokens` reads the local variables through a read-only `variables` request in `code.js`, and the UI converts and formats them with the copied converter and formatters of figma-console-mcp (`web/src/vendor/figma-console-mcp/tokens`, its README lists the copied files, changes and fixes). They run in the UI, not in `code.js`: the plugin stays small, and "Export again" needs only the read-only request.
  - Formats: DTCG, Tokens Studio, CSS variables, Tailwind v4 and v3, SCSS, a TypeScript module, flat and nested JSON, Style Dictionary v3. Not Less: upstream has only a stub.
  - Options: collections (names or IDs) and modes (names), both without case, with a clear error for an unknown name; prefix; one file per mode or per collection; DTCG dialect. Not color format and size unit: no copied formatter reads them. The prefix is not removed from variable names, unlike upstream, which removes it as plain text ("c" made "color" "olor").
  - Extended collections are left out with a warning. When the model names one, the error says why.
  - A collection without the selected modes is left out with a warning, not exported as an empty or incomplete file.
  - The copied files get `// @ts-nocheck`: FigPal's TypeScript settings are stricter, and about 60 changed lines would make an update hard. The upstream formatter tests run in FigPal.
- Downloads (part 2): files of tool results are in memory only (`web/src/files.ts`). The step shows each file with its size and a Download button (a blob URL and `<a download>`, which works in Figma Desktop). After a restart, Download of an export makes all files of its step again, without the agent (user request), and saves the clicked one; the new file shows the current state of the file. Files from the agent's code (`pi.attach`) say that they are no longer available: their code can change the file, so it does not run again.
  - `figma_export_nodes(node_ids, format, scale?)` exports layers as SVG, PDF, PNG or JPG through a read-only `export` request in `code.js`, named after the layer. The rules tell the model to use the export tools, not `pi.attach`, for files the user wants.
  - Token file names stay automatic (user decision): `tokens.css`, or collection and mode names with one file per collection or mode.
  - `figma_execute` keeps attachments that are not PNG, JPEG, GIF or WebP (for example SVG or PDF) as downloads. Before, they went to the model as images, which models cannot read.
- Version diff (part 3): `figma_diff_versions(from_version, to_version = "current", node_ids?, mode?)` uses the diff engine and changelog formatter of figma-console-mcp (`web/src/vendor/figma-console-mcp/diff`, its README lists the copied files and fixes). The agent gets version IDs with `figma_rest` `/versions`; the file key comes from `code.js` (`FileInfo.fileKey`), and without it the tool explains that it cannot work.
  - Figma's limits for file calls are strict (Tier 1: 10 to 20 a minute for most seats, about 20 a month for View and Collab seats). So the tool reads all nodes in one call for each version: at most 4 calls, where upstream makes 2 for each node. A 429 says when to try again, as in `figma_rest`.
  - The tool tells the model what it compares and what not (descriptions, variant options, layout, fills, instances, variable values), so the model does not say "no changes" for changes that it cannot see.
  - No cache of versions and no author lookup: past versions show "metadata not available", the current version its date. `NOTES.md` has options for large files.
- Design-system audit (part 4): `figma_audit_design_system(category?)` scores the open file with the scoring engine of figma-console-mcp (`web/src/vendor/figma-console-mcp/audit`, its README lists the copied files and fixes).
  - Data from `code.js` only (user decision): the local variables (the `variables` request of the token export) and a new read-only `components` request (components, component sets and styles of all pages, with `findAllWithCriteria`). No REST calls and no token, and the scores show the file as it is now, also unpublished changes. No cache: the read is local.
  - The model gets upstream's text report, and with `category` all findings of one category as JSON. The fix hints keep upstream's text but not its tool names (user decision): FigPal fixes with `figma_execute`. Layer names in the report are in quotes, so a name cannot add lines that the model reads as the report.
  - Checks without data do not count (user decision, after a test: upstream counts them, mostly as 100, so an empty file scored 62/100). A category without other checks shows "No data" and is left out of the overall score. Measured on typical files, no score goes up; missing tokens or components still fail in the token and coverage checks. A file without local components and variables (a file that uses a library) gets no score: the tool says that there is nothing to audit and points to `pi.lint()`. The report says what it read.
  - The chat shows the overall score and the 6 category scores under the step (user decision); the agent explains the findings.
  - The plugin does not read the property definitions of component sets: the audit does not need them, and Figma throws for a set with errors.
- Layer checks with pills (part 5): `figma_lint(node_id?, rules?, max_findings?)` runs the copied lint through a read-only `lint` request; the model gets the findings as JSON. Under the step, one pill for each rule ("Color without variable · 12"); a click selects the layers through a `select` request (the current page if it has some of them, else the first page; then zoom), and the step says when it selected only some. The selection is the user's, so it goes into the message box as a chip (user decision). The audit gives pills for its component findings; their locations list all components.
  - WCAG 3 (user decision): APCA, with the official `apca-w3` package unchanged (its license and colorparsley's AGPL-3 notice accepted). No setting: the lint has the rule `apca-contrast` next to `wcag-contrast` (font table by size and weight, the same severity), and the audit has two contrast findings, WCAG 2 (4.5:1) and APCA (Lc 60, the minimum for content text), both in the accessibility score. When they disagree, the agent asks which standard to meet. Lc keeps its sign (negative for light text on dark), as the APCA rules require.
  - The `lint` request runs outside `figma_execute`, so the lint has the same time limit and says how far it got. The default limit is 200 findings: a text that fails both contrast checks takes 2 places.
  - IDs from Figma links (`1-2`) work in all layer tools (`nodeIdOf`).
- Motion (last part): Figma's default skills `figma-use-motion` and `figma-implement-motion` teach the Motion API, and the model writes it with `figma_execute`. No copy of figwright's Motion tools: they wrap single API calls, and its reader adds about 400 lines for a small gain.
  - Video downloads: `figma_export_nodes` takes MP4, WEBM and GIF. A layer gives the animation of its top-level frame (only those have animations), one file for each frame. Videos take only the scales of Figma's export panel.
  - `figma_animation_frames(node_id, times?, width?)`: a screenshot shows a frame at rest, and the Plugin API cannot move the playhead. So code.js exports a small WebM (480 px, 24 fps, LOW), and a hidden `<video>` takes the frames at the times (exact seek with `currentTime`). The model gets at most 6 WebP frames, at most 2000 px on the longest side. The skills' `export_video` with ffmpeg maps to it.
  - Research (2026-11-01): the browser's own player needs no library. ffmpeg.wasm is about 10 MB with GPL parts, and its fast version needs cross-origin isolation, which Figma's iframe cannot get. Mediabunny (MPL-2.0, about 70 KB) uses the same decoders. If WebM does not play in Figma, use GIF with `ImageDecoder`.
  - Figma opens its own "Video Export" tab at a video export, and later exports use the open tab (user test). The plugin cannot stop it.
  - Images for the model: at most 2000 px on the longest side (`MODEL_IMAGE_MAX_PX`, also for screenshots): Claude rejects larger images in requests with more than 20 images, and the images stay in the conversation.
- Deploy (2026-11-01): `deploy.sh` keeps old files in `/assets` and deletes those older than 30 days. An open FigPal window loads parts of its build later (for example the ChatGPT provider), and the server sends `index.html` for a deleted file, so the import failed after a deploy.
- Browser checks (Phase 7, step 1): `e2e/` with Playwright (`playwright-core`) and the installed Chrome. The fake Figma page sends each `code.js` request to Node, where the check answers it in TypeScript; the model is a mocked Anthropic route. Node runs the TypeScript directly, no build. The checks make no calls to the internet (the default skills are blocked), an uncaught page error fails a check, and Ctrl-C stops Vite. Only the 9 scripts with real checks moved; the older scripts in `/tmp/pw` only printed results.
- Token budget (Phase 7, step 2): the rules and the tools go with each request (cached, but in the context window). The unit test "token budget" measures the leading system message at about 3.5 characters for each token, with FigPal's fixed rules for skills (one short skill) and one subagent model, but not the user's skill list. Before about 3,900, now about 3,130; the test fails at 3,200, so a new rule must take the place of an old one. The goal of 3,000 would cost guidance that the agent uses (Plugin API rules, the tool mapping for skills). After a review with the user, one cut line came back as one rule: "Only figma_execute changes the layers: the checks and exports only read them" (it was on 4 tools; without it, the agent can be too careful); about 3,190. Changes: lists of names are a JSON Schema `enum` (pi-ai `StringEnum`, a third of the size of a union of literals); the "Tools:" list of the rules repeated the tool descriptions, so its guidance moved into the tools; shorter texts. The 16 default Figma skills add about 7,000 characters; their descriptions stay complete, as the Agent Skills format loads them, and the user can turn skills off.
- UI requests (Phase 7, step 3): the model and thinking menus close on a choice (Base UI `closeOnClick`). The context usage on the right of the picker row (a short bar; the tooltip says "45k / 1M tokens (5%)"; user request after the step) is the size of the newest request as its provider reported it (pi-ai `calculateContextTokens`), not an estimate, and only from answers after the newest compaction (as pi-durable's `estimateContext`): until the next answer, it shows nothing; screen readers get "Context: 45,000 of 1,000,000 tokens". The panel opens at the height of the visible canvas (`figma.viewport.bounds × zoom`, less 64 px for the title bar), because code.js cannot read the size of the Figma window; a grip in the corner (mouse or arrow keys) sends `resize`, and code.js keeps the size within the canvas and saves it in clientStorage. The canvas never makes the panel smaller than the default width (420 px) and the minimum height (400 px): the panel once opened very narrow in Figma, probably because the canvas read too small while the file loaded. The grip is a figma-kit IconButton (24 px) with its own icon. A drag starts from the size of the window; a cancelled drag sends nothing more.
- Run in the background (Phase 7, step 4): the button "Run in the background" (a closed eye) sends `background`; it is the eye button in the header, between New chat and Settings (user requests after the step: first a "–" in the header, then next to Stop, above the message box and in the model row, only while the agent works; last back in the header, always); code.js hides the panel (`figma.ui.hide()`, the UI keeps running) and shows a Figma notice that stays (`timeout: Infinity`) with a Show button. When no chat and no subagent works (pi-durable `Harness.waitForIdle`, so it does not depend on the open chat), the notice says "FigPal is done."; this update changes only a notice that is still there, so it cannot hide the panel after Show. code.js shows the new notice before it hides the panel, and when the user closes the notice, FigPal closes (user request after the step: the notice has Show; first, closing it showed the panel). A plugin cannot add a toolbar button, and a second run of the plugin from the menu may restart it; the runs are durable, so a restart continues them.
- Layer chips in answers (Phase 7, step 5): the rules ask the model to link the layers that it names, `[Card](#node=1:2)` or `[2 icons](#node=1:3,1:4)`; the chat shows such a link as a chip, and a click selects the layers (the `select` request of the pills, with the same note when only some are selected). A fragment link, because the Markdown renderer removes links with an unknown scheme. Other links stay links. A link with more than 200 IDs is not a layer link (code.js looks up each ID), and duplicates collapse. The name of a chip is "Select 1 layer: Card", also for a link text with formatting. It depends on the model writing the links; the rule costs about 30 tokens (budget about 3,160 of 3,200).
- TypeScript only (Phase 7, step 6): the copied checks are `checks.ts` with `// @ts-nocheck`, as the other copied code in `web/src/vendor`: the code stays as upstream wrote it, so an update stays a diff, and the exported functions have their types (no `checks.d.ts`). The plugin bundle is the same except for the file name in a comment. `plugin/build.ts` runs in Node directly; `tsconfig.build.json` checks it with the Node types, which the Figma sandbox code in `src/` must not have.
- Local helper (Phase 7, step 7; user: "choose and plan before building"): one Node program, `local/cli.ts`, for both needs. FigPal's UI connects to it with a WebSocket on 127.0.0.1, ports 9300 to 9309 (figma-console-mcp's bridge uses 9223 to 9232); the helper accepts only FigPal's origins (a web page can connect to localhost, but cannot fake its origin). `--folder` shares folders: FigPal's agent gets `local_list`, `local_read` and `local_write` while a helper with folders is connected (the extension is installed then, so the tools cost no tokens without one); paths stay in the folders, also through symbolic links. `--mcp` makes it an MCP server for outside agents, with `figma_execute` and `figma_screenshot`; FigPal runs their requests in code.js only when the user allows outside agents. Both are settings in Access, off by default: looking for the helper writes an error in the console for each failed try, and an outside agent can change the file. The newest FigPal window gets the requests. Not built: remote threads, and the Node host (pi-durable in Node); they stay in `NOTES.md`. The three reviews failed (an access error of the review system), so their points were checked by hand: a page cannot fake its origin (also against DNS rebinding); a local program can connect, but it can read the files anyway; paths, linked files and linked folders stay in the shared folders (tests); reads stop at 1 MB, and lists and reads are cut at 40 KB for the model. Risk to know: a prompt injection in a Figma file can make the agent write in a shared folder.
- Local helper, second design (user review after step 7): no setting to connect, no paths to type. `pnpm local:install` writes a LaunchAgent (`dev.figpal.local`, `RunAtLoad`, `KeepAlive`, with the absolute paths of Node and `local/cli.ts`: run it again after a move or a new Node version) and runs `claude mcp add --scope user figpal -- <node> <cli> --mcp`; `pnpm local:uninstall` removes both. Without flags the helper keeps the folders in `~/.config/figpal/local.json`: FigPal sends `folders` changes (add: the helper opens the macOS folder picker with `osascript`, because a web page cannot name a path; remove; the home folder, which the user asked for as a setting, with a warning), the helper checks the names, saves, and says hello again to all windows. Folders that are gone are left out, so the helper still starts. `--mcp` keeps stdio (no URL and no fixed port in the agent config: each MCP helper takes a free port, and FigPal looks on all ports every 30 s and when its window gets the focus). Each window tells the helpers the name of its file; with several files, the MCP tools need `file` (FigPal opens once for each file). After the user's review of the Access tab: one install note covers both parts and shows only while the helper is not running; the folder controls show but are off without it (FigPal cannot pick or keep a folder of the Mac); MCP has the header of the accounts with "Connected" when an agent's helper is connected, and "Enable" with the switch on the right; the install makes a `figpal-mcp` shell script next to `node` (on the PATH where that Node is; Claude Code gets its full path), so the command for other agents is `<agent> mcp add figpal -- figpal-mcp` (Codex needs `--`). Second review of the Access tab: each part is a section with the header of the accounts (name, status on the right), one line that says what it does, then its controls: "Local helper" (Running / Not running; when it does not run, the install command with a Copy button, the one place for the install), "Shared folders" (the folder controls are off without the helper), and "MCP" (Connected / Not connected; Enable; then the user picks the agent, and FigPal shows its command or, for Cursor, Zed and Manual, the JSON, with a Copy button: Claude Code, Codex, OpenCode, Cursor, Devin, pi, Copilot CLI, Zed, Droid, Cline, Manual; from their docs, and the commands of OpenCode and Droid were tried). A disabled figma-kit Switch has another color than an enabled one, as in Figma. "Share Home" has its warning in the warning color. `--origin` replaces FigPal's origins (it added to them first): the user's FigPal connected to the test helpers of the browser checks, sent "Add folders" to one, and lost the request when the test stopped it. A window counts for an agent's request only after it names its file: a window that opens at that moment does not block it. Later: npm and `npx` (`NOTES.md`). Tested on this Mac: the install starts the helper, Claude Code connects, the uninstall removes all; the folder picker needs a person.
- Local helper, one bridge for all agents (user, 2026-11-02): each agent session started its own `--mcp` helper with its own port, so seven pi sessions filled the ports 9300 to 9309, and a new session failed, while FigPal still said "Connected" (to the helpers of the other sessions). The MCP processes also did not stop when the agent closed stdin (the MCP SDK's stdio transport does not see the end of stdin): now they stop then. As figma-console-mcp, one command works alone: `figpal` is the bridge (folders, and the requests of outside agents; the install starts it at login), and agents run `figpal mcp`. `figpal mcp` uses the running bridge on the path `/agent` (only clients without an origin: a web page always sends its origin), or, when none runs, is the bridge itself, without the folders (two bridges can run, for example while the install restarts `figpal`: FigPal must not show the folders twice); when that agent stops, another `figpal mcp` takes over. A bridge first looks for a running bridge on all ports, then starts one. It answers an agent's request that it does not know (a newer `figpal mcp`), so that the agent does not wait forever. MCP has no status next to its switch (user, after the change): it said "Connected" also when MCP was off, and "Not connected" when all worked and no agent ran. The switch is the state: when it is off, FigPal refuses each request of an agent. The bridge still sends `agent: false` in the hello, because FigPal before this change checks it. `--port` limits the ports (tests: a test agent must not use the user's bridge). The install adds `figpal` and removes the old `figpal-mcp`.

- Chat text (user: hard to read; user chose A plus a setting): answers, the user's messages and the composer use 13 px on 20 px (Figma's 12 px on 16 px is for labels), with more space between paragraphs, list items and headings. Settings → Models → Text size: Small (12/18), Medium (13/20, the default), Large (14/22). FigPal loads Inter (`@fontsource-variable/inter`, split by alphabet) from its own server: the plugin window does not get Figma's fonts, and without Inter on the Mac the UI used the system font.
- Only the chat scrolls (user report: a second scroll bar, with white space below the composer): the screen-reader text of layer chips has `position: absolute`, and the scroll area had no position, so these texts made the page taller. The scroll area is `relative`; the e2e check `scroll` measures the page.

- Statuses in the settings (user request): green when on (Connected, Signed in, Running); grey when off and nothing is wrong (the Figma token, the local helper and MCP are optional, and one model account is enough); red when FigPal cannot work: no model account, so Claude and ChatGPT both say "Not connected" / "Not signed in". Every account now shows its status, also when it is off.

- Chat basics (user, after Phase 7): steering, attachments, reply to a part of an answer, in this order (the agent chose: steering is the most basic). assistant-ui has the parts (its message queue, attachment adapters and chips, the selection toolbar); FigPal adds the link to pi-durable and the parts that assistant-ui's Lexical composer lacks. User decisions: Enter steers while the agent works, Cmd+Enter sends after the answer; pasted text of 2,000 characters or 30 lines becomes an attachment (the agent chose the numbers); Reply puts the selected text at the cursor as a Markdown quote.
- Steering: assistant-ui's `queue` adapter on pi-durable's inbox (`web/src/queue.ts`). While the agent works, Enter calls `steer` (pi-durable `whenBusy: "steer"`: after the current tool step) and Cmd+Enter calls `enqueue` (`"followUp"`: after the answer); FigPal catches Cmd+Enter before Lexical, which would add a line. The waiting messages come from `docs["pi.inbox"]` (the typed text of their `figpal.user` entry), so they survive a reload; they show above the composer ("Next" or "After the answer"), with "Send now" (withdraw, send as a steer) and Remove (`harness.abortSubmission`; a message that the run took first is not sent twice). The queue is on only while the agent works or messages wait: otherwise assistant-ui sends with onNew, which puts the text back when sending fails. After Stop, waiting messages stay and go in with the next message. assistant-ui's own `createMessageQueue` keeps the queue in the browser, so it does not fit. The reviews could not run (the Codex CLI is not signed in); their points were checked by hand.

- Attachments: assistant-ui's image and text adapters (`web/src/attachments.ts`), with FigPal's limits: images (PNG, JPEG, GIF, WebP) only for a model that reads images, and over 2000 px they get smaller (WebP, as for screenshots); text files by type or name (code, Markdown, JSON, CSV, SVG, …) up to 500 KB, as text in `<attachment name="…">`; other files (PDF: pi-ai sends only text and images) get a note that says why. The "+" button, paste and drop add files (a Lexical paste plugin: assistant-ui's Lexical composer has none); pasted text of 2,000 characters or 30 lines becomes "Pasted text.txt". `userInput` sends the images as images and the files as text; the `figpal.user` entry keeps their names, and the images stay in its model content, so the sent message shows its chips. "Send now" of a waiting message sends its stored input again, so its attachments stay. A button in the composer form needs `type="button"`, else it sends the message. `e2e/run.ts` stops Vite also after an unhandled rejection.

- Reply: assistant-ui's selection toolbar (`SelectionToolbarPrimitive.Root`: it shows at the selection in a message, and keeps the selection on a click) with FigPal's own Reply button, because assistant-ui's Quote puts one quote above the composer and its selection hook is not public. Reply puts the selected text into the composer at the cursor as a Markdown quote (`> …`, on its own line, then an empty line for the reply); several quotes in one message work. A small Lexical plugin keeps the editor of the composer for it. Group A is done; its reviews could not run (the Codex CLI is not signed in) and were checked by hand.

- After the user's test of group A: (1) Reply showed a raw `>`: a quote is now a chip, `:quote{name="{\"quote\":…}"}` (JSON, so the name may have line breaks), on its own line in the composer and a block in the sent message; the model still gets Markdown quote lines; a quote over 900 characters stays Markdown text. (2) A pasted image showed a broken image: the page policy allows `img-src 'self' data:`, so previews are data URLs, not blob: URLs; the e2e check decodes the preview, which catches it against the deployed page. (3) "Clumsy, pills too big, spacing not consistent": chips are 20 px with an 18 px Remove, waiting rows 24 px, steps of an answer 24 px rows close together (figma-kit's Collapsible has 8 px padding), text blocks 8 px apart, 8 px between the parts under the chat, and the hidden "Fork from here" row no longer adds space after an answer. The e2e check of the bridge waits as the user does (focus, then the folders in Access) before it asks the agent: it failed sometimes when the agent asked before FigPal was connected.

- "Delete" is "Archive" (user: "if delete is not possible currently the label should be Archive"): the menu item, the dialog and `archiveThread`; the dialog button is primary, not red, because the entries stay in the storage. A real delete and showing archived chats again stay in `NOTES.md` (group B). New e2e check `archive`.

- AI chat names (user: like T3 Code; a "Text generation model" setting under Settings → Models; run after the first answer): `nameThread` waits for the answer of the first message (its submission, so a waiting follow-up does not change it), and asks the text generation model with no tools for 2 to 6 words, at most 40 tokens; the message goes in up to 1,000 characters, the answer up to 2,000. Automatic (the default) is the cheapest model of the chat's provider by price (now Claude Haiku 5.5 and GPT-6 Luna), so it stays right when the catalog changes; a chosen model of a provider that is not connected falls back to Automatic. The AI name replaces the name only while it is the first line of the message: a name that the user gave stays, also during the request, and then no request goes. A stopped answer or a model failure keeps the first line. A first message with only attachments now gets "New chat" as its name, so the next message does not count as the first. The e2e harness answers naming requests with "Test chat" and keeps them out of `session.model` (option `naming`). Reviews (gpt-6.1-sol, xhigh, through pi) found 7 points; all fixed: wait for the submission, not for idle; no name after a stopped answer; pi-ai `contentText`; attachment-only first messages; input limits; no request after a rename; e2e harness.

- Thinking for the text generation model (user request after the test of AI names): a select next to the model, `textThinking`, Off by default (names stay fast). It offers the levels of the chosen model; for Automatic, the levels of the cheapest model of each connected provider. It shows the level that the model uses (pi-ai `clampThinkingLevel`: Claude Sonnet 5.5 cannot think Off, so Off shows as Low), and hides when the model has one level only. Each request fits the level to the model; with thinking, no 40-token cap (thinking needs more). The thinking labels moved to `settings.ts` (the chat menu uses them too). Note: for Claude 5.5 models pi-ai sends the level as a last message with `output_config.effort`; the top-level `output_config` always says "high". No reviews (a change that the user asked for).

- The window title is "FigPal" (user request: no "(remote)").
- No local UI (user choice A): FigPal always loads the deployed UI. Gone: the Settings row "Use the local UI", the button on the offline page, the clientStorage key `figpal.ui` (an old value does nothing), the `switch-ui` message, `devAllowedDomains` in the manifest, and the local origin of the helper (`LOCAL_ORIGINS` is the deployed origin; the e2e checks pass `--origin`). A UI change reaches Figma with `pnpm deploy:web`. Vite stays for the e2e checks (Chrome with a fake Figma). `pnpm dev` still starts Vite and the plugin build in watch mode.

- Rules (user request, like AGENTS.md; tabs Rules, Models, Skills, Access; no file name, note or counter; Settings still opens on Models): "For all files" is in clientStorage (`figpal.rules`, only this user); "For this file" is in the file (`figma.root` plugin data `figpal.rules`, new request `rules`), so everyone with the file gets it. Both go into each model request through the extension `rules` (installed last), which reads them at each request, so a change counts from the next message, in all chats; pi-durable's `instructions` would keep a copy in each chat. The rules for this file come last and win. 4,000 characters each: `maxLength` with a note at the limit, checked in code.js, and cut on load. Each change saves at once, one save after the other; code.js writes the file rules 500 ms after the last change, or when FigPal closes, so typing does not change the file at each key. If code.js cannot give the rules (a plugin from before this change), the chat goes on without them. Reviews (gpt-6.1-sol, xhigh, through pi): efficiency none; reuse 1 (figma-kit `Label`); quality 4 (lost drafts on failed saves, lost keys when FigPal closes within the wait, saves out of order, loaded text over the limit); all fixed. Not fixed: two FigPal windows that change the rules for all files at the same time (the last write wins). Risk to know: anyone who can edit the file can change its rules, which go into the agent's prompt.

- Skills (user report: "clicking install on one resets the field"): Install in the list keeps the field and the list, so several skills of one repository install one after the other; the button then says Reinstall. Only Enter (one pasted skill) empties the field after a success. New e2e check `skills` (fake GitHub and skills.sh).
- Message box below the window after a long answer (user report with screenshots: two scroll bars; once the header, once the message box out of view): the cause did not show in the e2e harness (long text, code, table, thinking and tool steps, streaming, after Settings, the chat list, the eye button, a new chat). Fixed in the layout, whatever makes content taller: the page never scrolls (`html` hidden; `body` relative and clip, so absolute elements belong to it; `#app` clip; clip also stops scrolling by code), `<main>` scrolls only for the chat list (clip with the chat), and the chat's scroll area has `min-h-0`. The `scroll` check adds 4,000 px tall content to the page, `<main>` and the chat, scrolls by code, and checks that the header and the message box stay in view (it failed before: the header at -1000 px). Popups still show (picker and tooltip screenshots).

- GitHub rate limit (user report: "The GitHub rate limit (60 requests in an hour) is reached"; GitHub allows 60 API requests in an hour without a login, for all programs behind the IP address): measured in the harness, the list of a repository and each install of its skills (without skills.sh) read the same tree again, and the Figma skills at start read it once for each skill when skills.sh fails (16 calls). Now a tree is kept for 10 minutes and shared, also by calls at the same time; a failed read is not kept; expired trees go; Check for update reads fresh. The error says when GitHub allows requests again (`x-ratelimit-reset`, rounded up). Reviews: reuse none; efficiency 1 (expired trees in memory), fixed; quality 2: the time in the text could come before the reset, fixed; a push to the repository within the 10 minutes can install a skill with the file list of the kept tree: not fixed (rare; a fix costs one more call for each repository; Check for update finds it).

- Unread chats (user request: "an indicator in the chat list for any chats that are done and unread"): when the work of a chat ends (`waitForIdle` after each message) and another chat is open, `noteDone` marks it `unread` in the thread list (saved, so it survives a reload); opening it (`selectThread`) clears it. A blue dot (`--figma-color-bg-brand`) after the title in the list, and next to the chat title in the header while another chat is unread; screen readers get "Unread". New e2e check `unread`. No reviews (a change that the user asked for).

- Chat list (user requests, 2026-11-03): (1) The AI name comes after the first message, from the message only (not after the first answer); a message with only attachments has no text, so its answer names the chat, as before. (2) The list shows unread chats first, then the newest activity (`sortedThreads`); the end of the work (`noteDone`) counts as activity. (3) Archived chats: Archive sets `archived` instead of removing the chat; the chats are in a folded "Archived (N)" part at the end of the list; opening one (`selectThread`) brings it back. Archive can be undone now, so it has no dialog (a running answer still stops). Chats that were archived before stay gone (until today they were "deleted"). Custom names: already there (⋯ → Rename…). Delete stays open (pi-durable 1.4.0 cannot delete one conversation). No reviews (changes that the user asked for).

- Simplify review of the scroll fix, unread chats and the chat list (gpt-6.1-sol, xhigh, through pi; 3 reviewers): (1) all three found that archiving the open chat opened the next one without reading it, so its dot stayed: `openIn` now does the open step for `selectThread` and `archiveThread`; (2) each message added a waiter, so N `noteDone` commits at one end of the work, and (3) work that a restart continues was never marked: `doneWatcher` keeps one waiter for each chat, and at the start watches the chats with unsettled submissions (`harness.inspect()`). Tests for each.

- Chat list groups (user request, like T3 Code's sidebar, without Snoozed): Done (unread), Working, Settled, Archived (folded), each with the newest activity first (`threadGroups`, which replaces `sortedThreads` and `archivedThreads`). Working is not saved: `doneWatcher` gives the threads with work at each change (`onWorking`), also work that a restart continues; it reports after `noteDone`, so a thread goes from Working to Done without Settled between. A thread that works is in Working, also when it is unread. A group without threads has no heading; each group is a region named by its heading. The e2e check `unread` follows one chat from Working to Done to Settled. No reviews (a change that the user asked for).

- Chat list groups, part 2 (user request): Done has no heading and is at the top; Working, Settled and Archived are at the bottom of the list, like T3 Code's sidebar, each with a heading that folds ("Settled (3)"). Working and Settled are open at first, Archived folded; the app keeps the state while FigPal is open (not saved). figma-kit's Collapsible needed two changes: the panel without its 16 px indent (the rows line up and the list did not scroll sideways), and the padding around the 100% wide trigger, not on it (else the list scrolled sideways after a click). The bottom groups keep 24 px free below them, so the ⋯ of the last row is not under the resize grip. e2e: `unread` checks the layout and the folding; `archive` checks that the list never scrolls sideways.

- pi packages 1.5.0 (plan agreed with the user, 2026-11-04): `pi-durable`, `pi-ai` and `chord` 1.5.0, and `pi-schema` 1.5.0 is new. For users: Claude no longer fails with "Invalid effort level" in organizations that limit the effort; large tool calls stream in linear time (before: quadratic); faster storage; schema checks without `eval`; GPT-6.1 Terra; long chats open with their newest messages.
  - Tool schemas: pi-ai no longer exports TypeBox. The schemas use pi-schema's builders, and each object has `{ open: true }`, as TypeBox's objects were open, so the model gets the same JSON Schema (14 of 15 tools give the same JSON; `figma_rest.body` has `additionalProperties: {}` instead of `true`, with the same meaning). pi-ai checks the arguments with pi-schema and its coercion.
  - Chat view: `viewState()` is gone. `watchTranscript` (transcript.ts) watches the conversation and merges each value into pi-durable's `ConversationTranscript`. The watch has only the newest 50 entries, so a long chat opens with its newest messages and **Load earlier** at the top (assistant-ui's `hasEarlier`, `onLoadEarlier` and `ThreadPrimitive.LoadEarlier`; pages of 50 entries). The chat starts at a user message: `toThread` hides the end of an earlier answer before it, and `watchTranscript` loads pages until a user message is loaded (one run can have more entries than a page). So each answer keeps its ID (`after-<user entry>`), and assistant-ui keeps the scroll position when earlier messages come (its check needs the old first message in the new list). A subagent transcript has no FigPal user message, so it loads all entries, as before.
  - Compaction summaries are now in the transcript in ID order (1.4 cut the entries before the newest one): the chat shows the messages from before a compaction, and the context size counts only answers after the newest summary.
  - The free space of a short chat moved from the footer's `mt-auto` to an empty div. assistant-ui adds the footer's margin to its height and measures again only when the footer changes size, so the large margin of the empty chat stayed: about 300 px above the end counted as "at the bottom", and new content or Load earlier scrolled the chat to the end. The layout is the same (measured: empty chat and long chat).
  - Chat list: `documentState()` is gone; `watchDoc()`. `onReport` gets one `Report`.
  - Saved chats: `upgrade.test.ts` opens a stored pi-durable 1.4.0 IndexedDB fixture (`fixtures/pi-durable-1.4.0.json`, made with FigPal's `startAgent` on 1.4.0): the chat list, a chat with a tool call, a fork, and a chat with a model request in progress (`pi.live` version 1 without `run.turns`). 1.5 counts the lost request as a failed attempt and asks again; a new message in an old chat gets its answer. e2e: new check `earlier`.
  - Reviews (gpt-6.1-sol, xhigh, through pi; 3 reviewers): reuse none. Quality: (1) entries that came while the first pages loaded could go missing (a gap of the watch): `watchTranscript` now loads each gap; (2) Load earlier showed nothing when the answer before covered more than a page (also found by efficiency): it now loads until an earlier user message shows; (3) a failed first load left the watch open: it stops; (4) the scroll check measured after the click: it now measures before and allows 2 px (it fails with the old footer). Tests for each. Views come from `transcript.merge(watch.value)`, so a slow load never shows an old view. Efficiency, not fixed: `toThread` builds all loaded messages again for each streamed part (11 ms at 21,000 entries); 1.4 did the same over the whole active transcript, and a reopened chat now has only its newest window.

- Settle by choice (user request): reading a chat no longer settles it; only ⋯ → Settle does (`ThreadInfo.settled`, `settleThread`). Unread is only the dot now. A settled chat has ⋯ → Unsettle, like T3 Code's Un-settle, and a new message also takes it out of Settled (`noteMessage`), so its next answer shows in Done. A chat that works is in Working, also when it is settled. Chats from before have no flag, so they show in Done until the user settles them. No reviews (a change that the user asked for). e2e: `unread` settles and unsettles a chat; `archive` checks the menu.

2026-11-05 (Phase 8, public launch):

- Backup (Settings → Access → Backup): a JSONL file with one line for each record of the databases `figpal:…` (pi-durable keeps JSON records: it also has a JSONL storage), the schema in a line before the records of each database. A value that JSON would change (bytes, Map, Set, Blob) stops the export. The keys stay out. Import: the UI checks the whole file, keeps it in the database `figpal-import`, and starts again; at the start, before FigPal opens its storage, each database of the file replaces the database of the same name (FigPal in another file blocks it: the page says so). The staged file goes also after a failure. Settings and rules do not move: they are in clientStorage (plugin ID) and in the files. The old UI got the backup in one last deploy (commit `99830d9`, checked against the deployed page with `pnpm e2e backup --ui …`).
- The FigPal command serves the UI on `http://localhost:9310` (`local/ui-server.ts`; first `127.0.0.1`, see the user test below); a fixed port, because the data belongs to the origin. Static files as the Caddy block served them (the page revalidates, `/assets` is immutable, the same CSP); a file that is not there gets 404, not the page. `/health` says `{ app: "figpal", version }`. It serves the UI only when it has a UI folder (`ui/` next to `cli.mjs` in the package, or `--ui`), so the commands of the tests in the repo do not take the port. `--ui-port` for tests.
- Routes: one table in `shared/src/routes.ts` for the command and Vite (the browser checks). All routes remove the browser headers and set the user-agent from `x-figpal-user-agent`. `/api/forward/<host>/<path>` goes to `https://<host>/<path>`, for the providers with API keys. Only the UI can use them: a request with another origin, or with `Sec-Fetch-Site` other than `same-origin`, gets 403 (a same-origin GET has no Origin header); the Host header must be `127.0.0.1` or `localhost` with the port (DNS rebinding). No list of hosts: only the UI can use the route, and its code can call any host anyway.
- The first page of the plugin asks `/health` (`fetch` with `no-cors`: a refused connection fails at once), and until FigPal answers it shows "FigPal is not running" with `npx figpal@latest install` and Copy, and asks again every 2 s. It sends `loading` before it goes to the UI; code.js starts its 10 s wait for `ready` then, not at the start (the wait for the command has no limit). The offline page says "FigPal did not start" with Try again. The manifest has `devAllowedDomains: ["http://localhost:9310"]`. Settings → Access lost the "Local helper" section: the command serves the UI, so it runs when the UI shows.
- npm package `figpal` (`local/`, AGPL-3.0, `os: darwin`, Node 22 or later): `local/build.ts` bundles `cli.ts` with esbuild (one file; a `require` for the CommonJS of `ws`), and adds the UI, the plugin (with `main: "code.js"`), the license, the notices and `licenses.md`. `pnpm package` builds it; `pnpm local:install` installs it from the repo. Checked with `npm pack`: the unpacked package serves the UI and answers MCP.
- `figpal install` (`local/install.ts`): copies `cli.mjs`, the UI and the plugin to `~/Library/Application Support/FigPal` (npx keeps its files in a cache; Figma and the LaunchAgent need fixed paths), keeps the UI files of earlier builds for 30 days (an open window loads parts of its build later), writes the LaunchAgent (the same label `dev.figpal.local`, so it replaces the helper of `pnpm local:install`), the `figpal` command next to node (it removes a link there first: a write through the link of `npm install -g figpal` would change npm's file), and Claude Code's MCP server. It uses the node of the PATH when that is the same program, so that a Homebrew update keeps the LaunchAgent working. It stops before any change when another program uses the port (`lsof` names it), and waits until the new version answers. The first install puts the manifest path on the clipboard. `figpal uninstall` removes all of it; the shared folders and the chats stay. The system calls are a parameter (`System`): the tests run the whole install in a folder. It did not run on the user's Mac in this session: it replaces the running helper.
- Providers: all providers of pi-ai with an API key setup and chat models (`apiKeyProviders`), without Claude and ChatGPT (their own cards; the Claude card also takes an Anthropic API key) and Amazon Bedrock: its AWS SDK uses Node's HTTP handler, so it would need the model calls in the command (not built; user decision open). Settings → Models → "Add a provider" (a combobox with a search) runs pi-ai's own setup (`models.login(id, "api_key")`): its questions show one at a time. FigPal adds the endpoint question for Azure (pi-ai reads it from the environment in Node) and answers "api-key" for Vertex (a browser cannot read ADC or a credentials file). The requests go through `/api/forward` with pi-ai's `fetch` option (all chat APIs take it, except Bedrock). Web search: Claude, ChatGPT and OpenAI (Responses) keep the provider's own tool; the web section tells other models that they cannot search, so that they do not make up results. The model of a new chat: the saved one, else FigPal's default of the first connected provider (Claude, ChatGPT, then by name), else that provider's first model. The main bundle grew from 2.1 to 3.1 MB (pi-ai's catalogs); it loads from the Mac.
- License: AGPL-3.0 (`LICENSE`), `THIRD_PARTY_NOTICES.md`, and `licenses.md` in each build with the bundled libraries and their license texts (`local/licenses.ts`; Vite's own license file fails with EISDIR on a package with a license folder).
- CI: `.github/workflows/checks.yml` (macOS: typecheck, lint, tests, package, browser checks) and `release.yml` (a tag `v<version>` publishes `figpal` with provenance; needs the secret `NPM_TOKEN`).
- Review (gpt-6.1-sol, xhigh, through pi; the call said "fetch failed", but the review ran). All 8 points fixed, each with a test that fails without the fix:
  1. An answer of a provider that broke off after its headers had no error handler and stopped the command: `pipeline` ends the response, and the request has an error handler.
  2. A backup record without its key passed the check, and the import deleted the old database before it failed: the check reads the key of each record (in the line, or at the key path of the store), and the import writes all databases into new databases next to the old ones first (`figpal-import:<name>`); only then does each one replace the old one.
  3. The export read each store, and each page, in its own transaction: now one read transaction for each database, so the backup has one state of it (a task never without its entry).
  4. `figpal install` of the installed command stopped FigPal, then failed to copy its files onto themselves: it refuses before any change, and names `npx figpal@latest install`.
  5. The installed `cli.js` had no `package.json` with `"type": "module"`, so Node 22.0 to 22.6 could not run it: the command is `cli.mjs`.
  6. A program on the port that accepts the connection but never answers kept the first page empty: each health request stops after 2 s, as "not running".
  7. pi-ai's Google and Vertex adapters refuse a custom fetch: their base URL goes to the forward route (`BASE_URL_ROUTES`; Vertex with an API key uses `aiplatform.googleapis.com`).
  8. The Copy check tested only the label: the browser check now reads the clipboard. Copy says "Copied" only after the copy; else the command stays selected, and the button says "Press Cmd+C".
  Also by hand: Copy works when the page has no clipboard API (a synchronous error skipped the older way). Unverified until they run: the first-page probe in Figma Desktop, and `pnpm publish` with provenance in the release workflow.
- The repo: `deploy/` and `deploy:web` are gone; the docs no longer name the Tailscale IP or the SSH user. The history still has them. A pattern scan of the history (all branches) found no keys or `.env` files; run gitleaks before the repo goes public.

- User test of the install (2026-11-05):
  - Figma refused the manifest: "Invalid value for devAllowedDomains. 'http://127.0.0.1:9310' must be a valid URL" (its docs show `http://localhost:3000`). The UI origin is now `http://localhost:9310`; the command still listens on `127.0.0.1` only, and the browser finds it there. No data was lost: the plugin had not loaded from `127.0.0.1` yet. A plugin test checks that the manifest allows the UI origin.
  - The first `pnpm local:install` failed: "macOS did not start FigPal" (`launchctl bootstrap` right after the `bootout` of the old helper); the second worked. The install tries the start again for 5 seconds. Its probe asks `127.0.0.1`, where the command listens (Node can try `::1` first for `localhost`).
- User decisions (2026-11-05): no Amazon Bedrock (it needs the model calls in the command: not easy); no confirmation before the first use of the rules of a file.

## Open questions

None at the moment.
