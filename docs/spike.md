# Phase 0 spike

Status: **done** (2026-10-30). All checks pass on the remote UI in Figma Desktop 126.10.13. The `simplify` review ran after the phase.

## How to run

### Local (dev server)

1. `pnpm install`, then `pnpm dev`. This starts Vite on `http://localhost:5173` and builds `plugin/dist/code.js`.
2. In Figma Desktop: **Plugins → Development → Import plugin from manifest…** and select `plugin/manifest.json`.
3. Open a test file (not a work file). Run **FigPal**. If the window title is "FigPal (remote)", click **Use the local UI** at the top of the page. The setting stays in clientStorage.
4. Click the checks on the page. In dev mode, the page also writes the results to `docs/spike-results.local.json`.

The **faux/script** model needs no token: `run: <code>` calls `figma_execute` with the code. Other text gets an echo.

### Hosted

1. VPS setup (done): the CoreDNS line in `deploy/coredns-hosts.txt`, the Caddy block in `deploy/Caddyfile.figpal`, the folder `/srv/figpal`. Backups: `/etc/caddy/Caddyfile.bak-figpal-20261029-230459`, `/etc/coredns/Corefile.bak-figpal-20261029-230549`.
2. `pnpm deploy:web`.
3. Run **FigPal**. If the window title is "FigPal (local)", click **Use the remote UI**. Then do the checks. Use **Copy as Markdown** to get the results (the dev route does not exist on the VPS).

Before and after the VPS change, a read-only check compared all Caddy sites (status codes), the Stalwart ports (25, 465, 993, 4190: greetings and certificate) and CoreDNS answers. The only differences were the new `figpal` site and DNS name. The adapted Caddy JSON was the same as before, except the new route and new internal group names. The `layer4` (Stalwart) and TLS configuration did not change.

## Results

"Chrome" is Chrome 156 headless with a fake Figma parent page on `https://www.figma.com` (Playwright). "Local run" is a run in Figma Desktop 126.10.13 (Electron 43.8.3, Chromium 150) with the dev server (2026-10-29).

| # | Check | Result | Notes |
|---|---|---|---|
| 0.0 | Messages between code.js and the UI | **Pass** | First local run: the UI did not get the replies, because it required `event.source === window.parent`. Second local run: the replies come from another window (`fromParent: false`). The page is three levels deep in `https://www.figma.com` frames. The UI now checks only the origin. |
| 0.1 | IndexedDB in the hosted iframe | **Pass** | Remote: a mark that the page saved before a restart of Figma Desktop was still there after the restart. `navigator.storage.persist()` returns `false` in the Figma iframe, so the browser can still clear the data under storage pressure. Keep export and import (Phase 7). |
| 0.2 | `networkAccess` with a hosted iframe | **Changed** | Local run: `example.com` (not in the list) was not blocked, no CSP violation. `networkAccess` does not apply to a navigated iframe. It applies to `code.js` (for example `createImageAsync`) and to the first document. |
| 0.3 | Claude setup-token | **Pass** | First runs: `401 invalid x-api-key` (the saved key was not a setup-token), then `401 CORS requests are not allowed for this Organization` with a correct `sk-ant-oat01-…` token, local and remote. Anthropic refuses browser requests for this subscription account; Pi Black does not change that. Fix: the route `/api/anthropic` (dev server and Caddy) sends the request without the browser headers and with the Claude Code user-agent (Chromium replaces the user-agent that the page sets). 2026-10-30: pass local and remote (`claude-haiku-5-5`, streamed). |
| 0.4 | ChatGPT | **Pass (path A)** | Device code login works local and remote. Codex through the route works local (Vite) and remote (Caddy, no Cloudflare challenge). Codex direct works only on `localhost`: `chatgpt.com` allows CORS for `http://localhost:5173`, not for the remote origin. **Sign in with ChatGPT** (path B) logs in local and remote, and its `api.openai.com` call works local, but fails remote with "Connection error". The preflight allows the remote origin, so the ChatGPT backend probably limits CORS to `localhost`, like `chatgpt.com`. Decision: path A (device code + `/api/chatgpt` route). |
| 0.5 | pi-durable browser bundle | **Pass** | Vite 8 build: main chunk 455 kB (125 kB gzip). Lazy: Anthropic SDK 210 kB (55 kB gzip), OpenAI SDK 278 kB (70 kB gzip), Codex 23 kB. Total `dist` 1.0 MB. No QuickJS or Photon (not imported). Chrome: Harness, `IndexedDbStorage` and the Web Lock work. |
| 0.6 | Execute | **Pass** | Local and remote runs: sample card, output limit, syntax error, `?.` and `??`, timeout, the block during the late run and its end. The sandbox error texts look like QuickJS ("unexpected token in expression"). The AsyncFunction constructor is **not** blocked. A synchronous endless loop cannot time out. |
| 0.7 | Resume | **Pass** | Chrome with the faux model, and remote in Figma Desktop: closing the plugin during `figma_execute` gives the `interrupted` result, and the run continues after the next start. |
| 0.8 | Provider-native search | **Pass** | Remote: Claude (`claude-sonnet-5-5`, `web_search_20250305`) and ChatGPT (Codex `gpt-5.6-luna` through the route, `{ type: "web_search" }`). pi-ai keeps the text and the source URLs. |
| 0.9 | `createImageAsync` | **Pass** | Remote: `createImageAsync` works with a host without CORS headers (`www.google.com`) and with a CORS host. A host that is not in `allowedDomains` fails: "does not satisfy the allowedDomains specified in the manifest.json". The UI cannot fetch a host without CORS headers. The UI bytes → `createImage` path works for CORS hosts. So images from any URL need `allowedDomains: ["*"]` (with `reasoning`) in Phase 5. |
| 0.10 | `figma.fileKey` | **Pass** | Local run: `figma.fileKey` is available. FigPal uses it as the file ID. |
| 0.11 | Hidden UI | **Pass** | Remote: while hidden, the page keeps running, but Chromium slows its timers (12 of 22 ticks of 500 ms in 11 s, about 1 per second). A fetch while hidden works. A run continues, slower. |
| 0.12 | `frame-ancestors` | **Pass** | Remote: Figma Desktop shows the page with `Content-Security-Policy: frame-ancestors https://www.figma.com`. Caddy now sends the header on every response (2026-10-30). |
| 0.13 | Tailscale DNS in Figma Desktop | **Pass** | Remote run: Figma Desktop loaded `https://figpal.maxschulmeister.dev` (Tailscale address) and `code.js` answered. VPS: public IP → 404. Local Network Access does not block the Tailscale address or `localhost`. |
| 0.14 | Tailscale off | **Pass** | Remote: with Tailscale off, the error page shows after 10 s. It has **Try again** and **Use the local UI**. |
| 0.15 | skills.sh | **Pass** | Search and download have no CORS header: the route is necessary. Local (Vite) and remote (Caddy) routes work. Download format: `{ files: [{ path, contents }], hash }`. GitHub fallback works (Trees API and raw files, CORS `*`); the repo has more than one `figma-use/SKILL.md`, so the fallback must select the right path. |
| 0.16 | Theme colors in the hosted iframe | **Pass with workaround** | No `--figma-color-*` variables in the navigated page, and the first document has no theme class when its script starts. The Figma docs say: do not use `themeColors` if the UI navigates. Workaround (works, local and remote): the first document waits for the class (at most 500 ms) and gives it to the page in the URL hash. The page must supply the token values itself (see the UI library decision in the plan). The "0.12" reload lost the URL hash once and recorded "none"; the button now keeps the hash. |

## Findings

### Local Network Access

Chrome blocks a page on a public origin (`www.figma.com`) when it opens a local address in an iframe: `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` for `http://localhost:5173` in the Chrome test. The Tailscale IP `100.110.230.14` is in `100.64.0.0/10`, which is also a local address for this feature. A cross-origin iframe gets the permission only with `allow="local-network-access"` on the iframe, and Figma controls the plugin iframe.

Figma Desktop 126 runs Electron 43 (Chromium 150). Figma Desktop loaded `http://localhost:5173` (local run) and `https://figpal.maxschulmeister.dev` on `100.110.230.14` (remote run, 0.13). So Figma Desktop does not block local addresses.

If a later Figma Desktop version blocks the Tailscale address: serve the static files on the public IP (they contain no secrets), or use a bundled UI with a separate storage page (option B in the decision log).

### ChatGPT

pi-ai 1.4.0 calls the Codex provider "legacy". Its OpenAI provider has **Sign in with ChatGPT**: the ChatGPT subscription with `api.openai.com`, which allows CORS. The login is an OAuth PKCE flow that goes to `http://127.0.0.1:1455/auth/callback`. In a browser, the user copies the URL of that page (it does not load) into FigPal. The spike tests both:

- A: Codex device code, inference directly and through `/api/chatgpt/*`.
- B: Sign in with ChatGPT, inference directly on `api.openai.com`.

Result: A works local and remote (through the route). B logs in, and its call works local (only newer models such as `gpt-5.6-luna`), but fails remote ("Connection error"). Decision: A, with the `/api/chatgpt` route.

### Credentials and model code

`figma_execute` code runs in the same sandbox as `code.js`. It can call `figma.clientStorage.getAsync("figpal.…")` and read the credentials. Decision (2026-10-29): the credentials stay in clientStorage.

### pi-ai in the browser

- The Codex provider has only OAuth auth, and its OAuth module needs Node. pi-ai then ignores an explicit `apiKey` ("Provider is not configured"). The spike gives the provider an API key auth that takes the access token.
- The Anthropic and OpenAI providers accept an explicit `apiKey`.
- Claude OAuth requests now use the browser port of [Pi Black](pi-black.md). The adapter passes fake-transport tests with pi-ai and pi-durable 1.4.0. Live subscription inference (0.3) and native search (0.8) pass through the route `/api/anthropic`.

### pi-durable

- `IndexedDbStorage.open(name)` has no `readOnly` option (1.4.0). The plan's read-only second window needs another solution (for example, a notice and no agent).
- Tools are given to the model through `system` messages (`toolsAdded`). The token budget check can measure them there.
- pi-durable does not pass request options to pi-ai. The spike wraps `Models.streamSimple` in a `Proxy` to add the API key, the Codex transport (`sse`) and `onPayload`.

## Changes to the plan

- Facts: the AsyncFunction constructor is not blocked. Anthropic refuses browser requests for subscription accounts, so Claude goes through `/api/anthropic`. skills.sh has no CORS header, so the `/api/skills/*` route is necessary.
- `networkAccess` does not restrict the hosted UI (0.2).
- Theme: the hosted UI gets the theme from the URL hash (0.16).
- Phase 2: no `readOnly` option in `IndexedDbStorage`.
- ChatGPT: device code login and the `/api/chatgpt` route (0.4). Sign in with ChatGPT fails from the remote origin.
