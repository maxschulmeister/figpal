# FigPal plan

FigPal is a Figma plugin with an AI agent in it. The agent runs on pi-durable inside the plugin UI. It reads and changes the open file through the Figma Plugin API. Threads stay in storage and continue after you close and open the plugin again.

FigPal is a development plugin for Figma Desktop only. Plugin ID: `figpal`. UI: `https://figpal.maxschulmeister.dev` (static files on the VPS, only reachable through Tailscale). Repo: `github.com/maxschulmeister/figpal` (private).

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
- Publication. FigPal stays a development plugin.
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
| Small data and secrets | `figma.clientStorage` (5 MB, per plugin ID) | Official, private to the plugin, works from the main thread. |
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
- CoreDNS listens on the Tailscale IP `100.110.230.14`. Its `hosts` block resolves private names (for example `system.maxschulmeister.dev`) to that IP for tailnet devices.
- Caddy blocks for private names use `@tailscale remote_ip 100.64.0.0/10 fd7a:115c:a1e0::/48`. Other requests get `404`.
- This Mac resolves `system.maxschulmeister.dev` to `100.110.230.14` and gets `200`.

## Architecture

```
Figma Desktop
└─ FigPal plugin
   ├─ code.js (main thread)
   │   ├─ execute queue: figma_execute, screenshots, createImage
   │   ├─ events: selection and page changes → UI
   │   └─ clientStorage: secrets, settings
   └─ iframe → https://figpal.maxschulmeister.dev/   (hosted UI)
       ├─ React + assistant-ui
       ├─ pi-durable Harness
       │   ├─ IndexedDB "figpal:file:<fileId>"  (threads, tasks, transcripts)
       │   └─ IndexedDB "figpal:global"          (skills)
       ├─ extensions: figma · subagent · skills · web
       └─ models: Anthropic direct · ChatGPT direct or through a Caddy route

VPS (reached through Tailscale)
├─ CoreDNS: figpal.maxschulmeister.dev → 100.110.230.14 for tailnet devices
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
- Every user message gets a short context block: file name, page, selection (IDs, names, types).
- Harness setup for each file: `IndexedDbStorage.open("figpal:file:<fileId>")` inside a Web Lock, then `harness.resume()`. Call `navigator.storage.persist()`.
- If a second plugin window opens the same file, it shows a notice. (pi-durable 1.4.0 `IndexedDbStorage` has no `readOnly` option.)

### Models and authentication

- A credential store in clientStorage, by provider.
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
| `figma_rest(method, path, body?)` (optional) | Figma REST API with a personal access token: comments, versions, library search across files | `GET` is safe |

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

- First choice: provider-native search and fetch through the provider wrapper.
- Fallback tools, active only when the provider has no native search:
  - `web_search(q)` with Tavily (key in the settings).
  - `web_fetch(url)`.
- Images:
  - `image_search(q)` with Openverse and Wikimedia Commons (no key), or Unsplash and Pexels (key).
  - To put an image on the canvas, `figma_execute` calls `figma.createImageAsync(url)`. If that fails and the image host allows CORS, the UI gets the bytes and sends a `Uint8Array` to `figma.createImage`. If neither works (spike 0.9), decide about a small image proxy. Caddy cannot proxy arbitrary hosts without code.

### Hosting (`deploy/`)

Static files only. The host Caddy serves them. Only tailnet devices can reach them. The server stores no user data: threads stay in Figma Desktop's IndexedDB on the Mac.

Setup on the VPS (one time, in Phase 0, with your approval):

1. CoreDNS: add `100.110.230.14 figpal.maxschulmeister.dev` to the `hosts` block in `/etc/coredns/Corefile`. Restart CoreDNS.
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

Deployment: `pnpm deploy:web` builds `web/` and runs `rsync -az --delete web/dist/ root@maxschulmeister.dev:/srv/figpal/`.

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
| `clientStorage` | Plugin ID, device | Model credentials (`figpal.credentials`), settings (`figpal.settings`: model and thinking level of new threads, enabled models), the UI source (`figpal.ui`), later Tavily and Figma tokens |
| IndexedDB `figpal:file:<fileId>` | Hosted origin | pi-durable session for the file: the thread list (`figpal.threads`), conversations, tasks, transcripts, attachments |
| IndexedDB `figpal:global` | Hosted origin | Skills. Version 3 has an empty `agents` store (see [Later tasks](#later-tasks)). |
| `figma.root` plugin data | Document | `figpal.fileId` (fallback only) |

Rules:

- Never change the plugin ID. clientStorage data belongs to it.
- Never change the UI origin without a migration. IndexedDB data belongs to it.

### Domain migration

1. The new UI opens a hidden iframe on `<old-origin>/migrate`.
2. That page reads all of its IndexedDB object stores and sends them to the new origin with `postMessage` (strict origin checks on both sides).
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
| 0.13 | Tailscale DNS in Figma Desktop | Figma Desktop (Electron) resolves `figpal.maxschulmeister.dev` to `100.110.230.14` and loads the page. A request from outside the tailnet gets `404`. |
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

- Provider wrapper for native search and fetch.
- Tavily fallback, `image_search`, image placement (`createImageAsync`, then direct bytes).
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

- Run in background (hidden UI).
- Domain migration and export/import.
- Light and dark theme: figma-kit tokens, theme class from the URL hash (spike 0.16).
- Token budget check.

Checks:

- Migrate data between two test subdomains.
- Measure the token size of the tool schemas and the rules (goal: less than 3k).

## Later: optional Node host

Use it only if you need repo access, long runs while Figma is closed, or a provider that no browser path supports.

- The same extensions run in Node with SQLite storage. Only the transport changes (WebSocket instead of `postMessage`).
- It adds pi-durable `createCodingTools` with a `NodeExecutionEnv` for each repo, and the figma-console-mcp codebase extraction (`src/core/extraction`).
- A LaunchAgent (`RunAtLoad`, `KeepAlive`) starts it at login.

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
| Code from `figma_execute` runs in the same sandbox as `code.js` | It can read `figma.clientStorage`, also the credentials. A prompt injection (in the file, in a skill, later in web results) can send them out, for example with `figma.openExternal(url)`. | Accepted (decision 2026-10-29). Skills are instructions for the model: install only skills that you trust. Keep it in mind for the web tools (Phase 5). |

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

## Open questions

None at the moment.

## Later tasks

Separate tasks, not in a phase. Decide before you start one.

### Agent profiles

Profiles with their own instructions, model, thinking level and skills, for the main agent and for subagents (decided 2026-10-31: not in Phase 4).

- Use: rules that you write once, for example brand rules or "use only our library components".
- A form in the settings (name, description, model, thinking level, skills, instructions), not Markdown.
- An agent picker in the chat, next to the model picker: a thread can use a profile. The `subagent` tool gets an `agent` field.
- A stale profile must not fail: a removed skill is left out, and a model that was removed (or whose provider is not connected) falls back to the thread's model, with a warning on the profile.
- Storage: `figpal:global` already has an empty `agents` store (version 3).
- Alternative with less code: one "Instructions" field in the settings for the main agent and all subagents.

### Thread names

The UX of thread names. Now a thread takes the first line of its first message (at most 60 characters), and you can rename it.

- Idea: an AI name, like T3 Code: after the first message, a small, fast model writes a short title. A name that the user gave stays.
- Decide: which model (the provider of the thread, or a fixed small model), the cost, when it runs (the first message only, or again later), and what shows while it runs.
