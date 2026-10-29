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
| `api.anthropic.com/v1/messages` | Allowed (`*`), including `x-app`, `user-agent` and `anthropic-dangerous-direct-browser-access` |
| `platform.claude.com/v1/oauth/token` | Blocked ("Disallowed CORS origin") |
| `chatgpt.com/backend-api/codex` | Blocked ("Disallowed CORS origin") |
| `auth.openai.com` (token, device code) | Allowed |
| `api.githubcopilot.com`, `api.github.com/copilot_internal/v2/token` | Allowed |
| `api.figma.com` | Allowed (`X-Figma-Token`, `Authorization`) |
| `api.github.com`, `raw.githubusercontent.com` | Allowed |
| `skills.sh/api/search`, `skills.sh/api/download/...` | No CORS header. Use a Caddy route or the GitHub fallback. |
| Tavily, Openverse, Wikimedia Commons, Unsplash, Pexels, Jina Reader | Allowed |

Other facts:

- `claude setup-token` makes a long-lived `sk-ant-oat01-…` token. pi-ai sends it as a Bearer token with the browser header.
- The pi-ai OAuth login modules use Node (`node:http` callback server). pi has headless logins: a Claude setup-token, a Codex device code, and the GitHub device flow.
- The pi-ai Codex WebSocket transport sends headers. A browser WebSocket cannot send headers.
- pi-ai has `onPayload` for Anthropic and Codex requests. pi-durable does not expose it. pi-ai does not parse server tool blocks.
- pi-durable runs a tool again after a restart only if the tool has `replay: "safe"`. Other tools give the model an `interrupted` result.
- pi-durable `IndexedDbStorage` needs one owner at a time. Use a Web Lock.
- `figma.fileKey` is only available to private plugins with `enablePrivatePluginApi`.
- `figma.createImageAsync(url)` accepts PNG, JPEG and GIF up to 4096 px. The docs do not say if CORS applies.
- Figma runs one plugin at a time in a file.

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
├─ web/                    hosted UI (Vite + React + assistant-ui + pi-durable)
│  └─ src/extensions/      figma/, subagent/, skills/, web/
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
  - `figma.showUI('<script>location.href="https://figpal.maxschulmeister.dev/"</script>', { themeColors: true, width, height })`. In development, use the local dev server URL (a build flag selects it).
  - **Load check:** `code.js` waits for a `ready` message from the UI. If no message comes in time, it shows a small local page: "Cannot reach FigPal. Connect Tailscale and run the plugin again."
  - Message router with request IDs.
  - **Execute:** wrap the code in an async IIFE and run it with `eval` (Figma blocks the `AsyncFunction` constructor). Top-level `await` and `return` are supported. The result is JSON. There is a timeout and an output limit (about 20 KB, like `use_figma`). Copy the result analysis from figma-console-mcp `code.js` (MIT).
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

- React + assistant-ui with an `ExternalStoreRuntime`. pi-durable `watch()` views feed it.
- Screens:
  - Thread list for the current file: new, fork, rename, delete.
  - Chat: streamed text, tool calls (collapsible), subagent transcripts under their call, attachments.
  - Settings: providers and models, model allowlist for subagents, agents (Markdown editor), skills, web search, export and import.
- Every user message gets a short context block: file name, page, selection (IDs, names, types).
- Harness setup for each file: `IndexedDbStorage.open("figpal:file:<fileId>")` inside a Web Lock, then `harness.resume()`. Call `navigator.storage.persist()`.
- If a second plugin window opens the same file, it opens the storage with `readOnly: true` and shows a notice.

### Models and authentication

- A credential store in clientStorage, by provider.
- **Claude:** you paste the token from `claude setup-token`. No refresh is needed.
- **ChatGPT:** device code login in the UI (`auth.openai.com` allows CORS). Token refresh also uses `auth.openai.com`. Inference first tries a direct call. If CORS blocks it, the provider base URL changes to the Caddy route `/api/chatgpt/backend-api`.
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
2. Caddy: add this block to `/etc/caddy/Caddyfile`, next to `system.maxschulmeister.dev`. Do not add it to `dokploy-apps.caddy`, because `caddy-dokploy-sync` writes that file. Run `caddy validate`, then reload Caddy.

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
| `clientStorage` | Plugin ID, device | Model credentials, Tavily and Figma tokens, settings, thread index `{ fileId → [{ threadId, title, updatedAt }] }` |
| IndexedDB `figpal:file:<fileId>` | Hosted origin | pi-durable session for the file: conversations, tasks, transcripts, attachments |
| IndexedDB `figpal:global` | Hosted origin | Skills, agent definitions |
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

Write the results in `docs/spike.md`. Change this plan where a check fails.

### Phase 1: MVP

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
- Light and dark theme with Figma theme colors.
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
| Browser drops the `user-agent` header for Claude subscription calls | Claude calls can fail | Spike 0.3. Fallback: a Caddy route to `api.anthropic.com` that sets the header. |
| ChatGPT inference blocked by CORS | No direct ChatGPT | Caddy route. Cloudflare in front of `chatgpt.com` can challenge VPS IPs. |
| VPS is down or Tailscale is off | The plugin cannot load its UI | Caddy runs as a system service. The plugin shows "Connect Tailscale". Later: a service worker caches the UI. |
| Figma Desktop does not use the Tailscale DNS | The UI does not load | Spike 0.13. Fallback: a Tailscale-only Caddy site on the `ts.maxschulmeister.dev` names, or the Tailscale IP with its own certificate. |
| IndexedDB is cleared with the Figma cache | Threads are lost | `navigator.storage.persist()`, export, optional sync to the VPS later. |
| Figma skills have no license | Cannot be shipped with FigPal | Install them per user from skills.sh only. |
| Long `figma_execute` calls block Figma | Figma does not respond | Timeout, yielding helpers, rules section. |

## Decision log

2026-10-29:

- Plugin ID `figpal`. Development plugin only. Figma Desktop only.
- Hosted UI (option C) instead of a bundled UI with a storage page (option B): less code, and both need the VPS at start.
- UI on `figpal.maxschulmeister.dev`: static files through the host Caddy, Tailscale only. No Dokploy app and no server process.
- Proxy routes in Caddy only when a spike shows the need.
- Private GitHub repo `maxschulmeister/figpal` as the remote (backup, not for deployment).

## Open questions

None at the moment.
