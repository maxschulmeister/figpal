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
- Pi CLI extensions (`export default (pi: ExtensionAPI) => …`, Pi packages on npm). They use `registerCommand`, `pi.on(...)`, `ctx.ui` (terminal UI) and Node APIs, which pi-durable does not have. FigPal has no adapter for them. Installable extensions use the FigPal format (Phase 8).
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
| Skills and agents | Global (one list for all files) | User request. |
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
   │   └─ clientStorage: secrets, settings, thread index for each file
   └─ iframe → https://figpal.maxschulmeister.dev/   (hosted UI)
       ├─ React + assistant-ui
       ├─ pi-durable Harness
       │   ├─ IndexedDB "figpal:file:<fileId>"  (threads, tasks, transcripts)
       │   └─ IndexedDB "figpal:global"          (skills, agents)
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
  - Settings: providers and models, model allowlist for subagents, agents (Markdown editor), skills, web search, export and import.
- Every user message gets a short context block: file name, page, selection (IDs, names, types).
- Harness setup for each file: `IndexedDbStorage.open("figpal:file:<fileId>")` inside a Web Lock, then `harness.resume()`. Call `navigator.storage.persist()`.
- If a second plugin window opens the same file, it shows a notice. (pi-durable 1.4.0 `IndexedDbStorage` has no `readOnly` option.)

### Models and authentication

- A credential store in clientStorage, by provider.
- **Claude:** you paste the token from `claude setup-token`. No refresh is needed. A browser port of Pi Black wraps the Anthropic provider for OAuth request compatibility (Claude Code `2.1.280`). API-key requests stay unchanged. See [Pi Black integration](docs/pi-black.md) for the pinned source, checks, and limits.
- **ChatGPT:** device code login in the UI (`auth.openai.com` allows CORS). Token refresh also uses `auth.openai.com`. Inference goes through the route `/api/chatgpt/backend-api` (Caddy, and the dev server), because `chatgpt.com` allows CORS only from `localhost` (spike 0.4). pi-ai's "Sign in with ChatGPT" (`api.openai.com`) fails from the remote origin.
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

- One tool: `subagent({ tasks: [{ task, agent?, model? }] })`. It runs all tasks in parallel and returns all answers.
- Each task is a child conversation that the call owns (`ownership: { kind: "task" }`, `replay: "safe"`, like pi-durable example 21).
- `model` must be in the allowlist from the settings. `agent` names an agent definition.
- Agent definitions are Markdown files with frontmatter: `name`, `description`, `model`, `thinking`, `skills` (optional; all skills if not set). All tools are available to every agent.
- Subagents cannot start subagents.
- For parallel canvas work, the orchestrator gives each subagent its own frame or section (node IDs). The `code.js` queue runs Figma calls one at a time.

#### `skills`

- Storage: `figpal:global` IndexedDB, with `{ name, description, files[], source, hash, enabled }`.
- Prompt section: the name and description of each enabled skill, filtered by the agent's `skills` list.
- Tools:
  - `skill_read(name, path?)`
  - `skill_grep(name, pattern)`, for large references such as the Plugin API typings.
- Install:
  - Paste `npx skills add owner/repo[@skill]`, a skills.sh URL, or a GitHub URL.
  - Search and download use the skills.sh API through the Caddy route `/api/skills/*`.
  - The fallback is the GitHub Trees API plus `raw.githubusercontent.com` (60 requests per hour without a token).
  - You can also upload a zip.
- Update: compare `hash`, like the skills CLI.
- Suggested skills: Figma's `figma-use`, `figma-use-motion`, `figma-shaders`, `figma-use-figjam`, `figma-use-slides`, `figma-generate-library`. Their repo has no license, so use them only for yourself.

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
| `clientStorage` | Plugin ID, device | Model credentials (`figpal.credentials`), the UI source (`figpal.ui`), Tavily and Figma tokens, settings, thread index `{ fileId → [{ threadId, title, updatedAt }] }` |
| IndexedDB `figpal:file:<fileId>` | Hosted origin | pi-durable session for the file: conversations, tasks, transcripts, attachments |
| IndexedDB `figpal:global` | Hosted origin | Skills, agent definitions, installed extensions (Phase 8) |
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

- Thread list for each file: new, fork, rename, delete, last open thread.
- Settings: credentials, default model, thinking level.
- ChatGPT device login, with the Caddy route if needed.
- Credential writes in a Web Lock (`figpal:credentials`): two FigPal windows share clientStorage, and an OAuth refresh must run only once (Phase 1 review).
- Read-only mode for a second window.

Checks:

- Two files have separate thread lists.
- Restart Figma: the threads are still there.
- A second window opens the file as read-only.

### Phase 3: skills

- Global skills store, prompt section, `skill_read`, `skill_grep`.
- Install from skills.sh (Caddy route), GitHub fallback, zip upload, update, enable and disable.

Checks:

- Install `figma/mcp-server-guide@figma-use`.
- The model loads it when it must.
- `skill_grep` finds a type in the typings.

### Phase 4: subagents

- Agent definitions in the settings (Markdown editor).
- Model allowlist.
- `subagent` tool with parallel tasks, child transcripts in the UI.

Checks:

- Two subagents build two sections in parallel without conflicts.
- Abort stops both.
- A restart during a subagent run continues correctly.

### Phase 5: web

- Provider wrapper for native search and fetch.
- Tavily fallback, `image_search`, image placement (`createImageAsync`, then direct bytes).

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

### Phase 8: installable extensions

Goal: users install, update and remove extensions in the settings. FigPal does not hard-code them. Users give the extensions (URL, file or code). FigPal has no catalog of extensions.

Facts (pi-durable 1.4.0):

- pi-durable has extensions: `defineExtension({ name, tools, sections, hooks, wraps, tasks })` in a registry (`createRegistry()`). `registry.install()` and `registry.uninstall()` work while the Harness runs. An install with the same name replaces the extension. Work that started keeps the old code. New work uses the new code.
- The registry is not stored. Conversations store only extension names. After a restart, the host must install the same extensions again. Pending tasks of an extension wait until it is installed again.
- pi-durable has no loader: no package format, no `pi install`, no file discovery.
- A pi-durable extension cannot change a provider. Pi Black is a provider wrapper (`Provider → Provider`) that `createAgentModels()` applies. So the format must allow both parts.

#### Module format

An extension is one ESM file (bundled, no bare imports) with a default factory:

```ts
export default (sdk: FigpalSdk) => ({
	extension?: Extension,                                          // pi-durable: tools, sections, hooks, wraps, tasks
	providers?: Record<string, (provider: Provider) => Provider>,  // wrappers by provider ID, for example "anthropic"
});
```

- `sdk` gives `defineExtension`, `defineTool`, `section`, `hook`, `ToolTask`, `Type`, and the Figma bridge (`request`). The extension must use the same pi-durable instance as the Harness, or `hook(ToolTask, …)` does not work. A module from a `blob:` URL cannot resolve `@earendil-works/...` imports, so the host gives them.
- Order of provider wrappers: pi-ai provider → extension wrappers (in install order) → `throughRoute`.
- Each extension states the `sdk` version that it needs. FigPal refuses an extension for a different version.
- Write the format in `docs/extensions.md`, with one example extension.

#### Install and storage

- Sources: a URL, a file upload, or pasted code. A URL must allow CORS from the UI origin. FigPal adds no proxy for user URLs.
- Storage: `figpal:global` IndexedDB, next to the skills: `{ name, version, source, code, hash, enabled }`. Store the code, not only the URL: after a restart, the same code must run.
- Update: only when the user starts it. Download again, compare `hash`, and show the confirmation again if the code changed.
- Start: load each enabled extension with `import(URL.createObjectURL(blob))`, before `Harness.open()`. Install its `extension` in the registry, and apply its `providers` in `createAgentModels()`. A provider change needs a new `Models`, so it applies from the next run.
- A failed load must not stop FigPal: show the error in the settings and start without that extension. `onReport` (`extension_error`) also goes to the settings.

#### Settings UI

- List: name, version, source, enabled, error.
- Actions: install (URL, file, paste), update, enable or disable, remove.
- Remove or disable with pending tasks: show the tasks, and abort them before the uninstall. Otherwise they stay blocked.

#### Built in or installable

| Part | Where | Reason |
|---|---|---|
| `figma`, `skills`, `subagent`, `web`, Figma depth (Phases 1 to 6) | Built in | FigPal ships them. Their settings UI is part of FigPal. |
| Pi Black | Installable | Remove it from `createAgentModels()`. The FigPal port is the first test of the `providers` part. Publish it as one ESM file that users can install from a URL. Without it, Claude with a setup-token can fail. Tell users this in the Claude settings. |

An installed extension must not replace a built-in tool or section name. FigPal refuses the install.

#### Security

Other users install extensions, so the confirmation must be clear to people who do not read code.

- An extension runs on the UI origin with full access: the bridge (`figma_execute`, clientStorage with the credentials), IndexedDB, and the network. This is the same trust model as Pi CLI extensions.
- Before each install and each changed update, show a confirmation:
  - The source (domain or file name) and the code size.
  - The tools, sections, hooks and provider wrappers that the extension adds. Get them from a load into a test registry, before the real install.
  - A warning: "This extension can read your files, your API keys and tokens, and send data to the internet. Install it only if you trust the source."
  - The code, in a collapsed view.
- Install only after the user confirms. No automatic update.
- Not in scope: a sandbox. pi-durable `/codemode` (QuickJS) can run tool code isolated, but then an extension has no hooks, sections or provider wrappers.
- A CSP must allow `blob:` in `script-src`. Today the UI has no CSP. Keep this in mind for the image rule (`img-src`).

Checks:

- Install Pi Black from a URL. Claude works. Restart Figma: Pi Black loads again and Claude works.
- Install a test extension with one tool and one section. The model uses the tool. Disable it: the tool is gone from the next request.
- Restart during a call of a `replay: "safe"` tool from an extension: the call runs again after the extension loads.
- An extension that throws on load: FigPal starts, and the settings show the error.
- An extension that defines `figma_execute`: FigPal refuses the install.
- The confirmation shows the tools and provider wrappers of the test extension before the install.

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
| An installed extension is malicious (Phase 8) | It can read the credentials and the files, and send them out | Clear confirmation before each install and changed update. No automatic update. Extensions cannot replace built-in tools. |
| Code from `figma_execute` runs in the same sandbox as `code.js` | It can read `figma.clientStorage`, also the credentials. With web tools, a prompt injection can send them out. | Accepted (decision 2026-10-29). Keep it in mind for the web tools (Phase 5). |

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
- Phase 8, installable extensions, comes after all other phases.
  - Users give the extensions. FigPal has no catalog.
  - Other users install extensions too, so the install needs a clear confirmation.
  - No adapter for Pi CLI extensions.
  - Pi Black becomes an installable extension.

## Open questions

None at the moment.

