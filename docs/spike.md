# Phase 0 spike

Status: in progress. The VPS setup is done (2026-10-29). Most checks in Figma Desktop are open.

## How to run

### Local (dev server)

1. `pnpm install`, then `pnpm dev`. This starts Vite on `http://localhost:5173` and builds `plugin/dist/code.js`.
2. In Figma Desktop: **Plugins → Development → Import plugin from manifest…** and select `plugin/manifest.json`.
3. Open a test file (not a work file). Run **FigPal → FigPal (dev server)**.
4. Click the checks on the page. In dev mode, the page also writes the results to `docs/spike-results.local.json`.

The **faux/script** model needs no token: `run: <code>` calls `figma_execute` with the code. Other text gets an echo.

### Hosted

1. VPS setup (done): the CoreDNS line in `deploy/coredns-hosts.txt`, the Caddy block in `deploy/Caddyfile.figpal`, the folder `/srv/figpal`. Backups: `/etc/caddy/Caddyfile.bak-figpal-20261029-230459`, `/etc/coredns/Corefile.bak-figpal-20261029-230549`.
2. `pnpm deploy:web`.
3. Run **FigPal → FigPal** and do the checks. Use **Copy as Markdown** to get the results (the dev route does not exist on the VPS).

Before and after the VPS change, a read-only check compared all Caddy sites (status codes), the Stalwart ports (25, 465, 993, 4190: greetings and certificate) and CoreDNS answers. The only differences were the new `figpal` site and DNS name. The adapted Caddy JSON was the same as before, except the new route and new internal group names. The `layer4` (Stalwart) and TLS configuration did not change.

## Results

"Chrome" is Chrome 156 headless with a fake Figma parent page on `https://www.figma.com` (Playwright). "Local run" is a run in Figma Desktop 126.10.13 (Electron 43.8.3, Chromium 150) with the dev server (2026-10-29).

| # | Check | Result | Notes |
|---|---|---|---|
| 0.0 | Messages between code.js and the UI | **Pass** | First local run: the UI did not get the replies, because it required `event.source === window.parent`. Second local run: the replies come from another window (`fromParent: false`). The page is three levels deep in `https://www.figma.com` frames. The UI now checks only the origin. |
| 0.1 | IndexedDB in the hosted iframe | Open | Local run: the visit count goes up between plugin runs. Needs a restart of Figma Desktop, on the hosted origin. |
| 0.2 | `networkAccess` with a hosted iframe | **Changed** | Local run: `example.com` (not in the list) was not blocked, no CSP violation. `networkAccess` does not apply to a navigated iframe. It applies to `code.js` (for example `createImageAsync`) and to the first document. |
| 0.3 | Claude setup-token | Fail, open | Local run: `401 invalid x-api-key`. pi-ai sent the key as an API key, because it did not contain `sk-ant-oat` (pi-ai's test for a setup-token). The page now removes white space from the token and shows its first 13 characters and length. Needs a new run. |
| 0.4 | ChatGPT | Partly | Local run: device code login, Codex direct, Codex through the Vite route and **Sign in with ChatGPT** work. The `api.openai.com` call failed only for the model: "The 'gpt-4' model is not supported when using Codex with a ChatGPT account". The quick test now uses `gpt-5.6-luna`. Codex direct works only on `localhost`: `chatgpt.com` allows CORS for `http://localhost:5173`, not for `https://figpal.maxschulmeister.dev`. The VPS route reaches `chatgpt.com` (unauthenticated: 401 JSON, no Cloudflare challenge). See [ChatGPT](#chatgpt). |
| 0.5 | pi-durable browser bundle | **Pass** | Vite 8 build: main chunk 455 kB (125 kB gzip). Lazy: Anthropic SDK 210 kB (55 kB gzip), OpenAI SDK 278 kB (70 kB gzip), Codex 23 kB. Total `dist` 1.0 MB. No QuickJS or Photon (not imported). Chrome: Harness, `IndexedDbStorage` and the Web Lock work. |
| 0.6 | Execute | **Pass** | Local run: sample card, output limit, syntax error, `?.` and `??`, timeout, the block during the late run and its end. The sandbox error texts look like QuickJS ("unexpected token in expression"). The AsyncFunction constructor is **not** blocked. A synchronous endless loop cannot time out. |
| 0.7 | Resume | Partly | Chrome with the faux model: a reload during `figma_execute` gives the `interrupted` result, and the run continues. Needs the test in Figma (close the plugin). |
| 0.8 | Provider-native search | Open | Needs a token. |
| 0.9 | `createImageAsync` | Open | Test URLs: `www.google.com` (no CORS header), `upload.wikimedia.org` (CORS `*`), `placehold.co` (not in `allowedDomains`). |
| 0.10 | `figma.fileKey` | **Pass** | Local run: `figma.fileKey` is available. FigPal uses it as the file ID. |
| 0.11 | Hidden UI | Open | The Figma docs say that a hidden UI keeps running. |
| 0.12 | `frame-ancestors` | Open | Caddy sends the header only for `/?csp=1` (button "0.12"), so a failure does not hide 0.13. |
| 0.13 | Tailscale DNS in Figma Desktop | Partly | VPS: tailnet → 200, public IP → 404, Let's Encrypt certificate obtained. This Mac resolves the name to `100.110.230.14`. Local run: Figma Desktop loaded `http://localhost:5173`, so Local Network Access does not block the iframe (see below). Needs a hosted run. |
| 0.14 | Tailscale off | Open | The plugin shows a local page after 10 s with a "Try again" button. |
| 0.15 | skills.sh | **Pass** | Search and download have no CORS header: the Caddy route is necessary. The route works (Vite proxy in the local run, and Caddy on the VPS). Download format: `{ files: [{ path, contents }], hash }`. GitHub fallback works (Trees API and raw files, CORS `*`). |
| 0.16 | Theme colors in the hosted iframe | Fails, workaround open | Local runs: no `--figma-color-*` variables in the navigated page, and the first document has no theme class when its script starts. The Figma docs say: do not use `themeColors` if the UI navigates. Workaround: the first document waits for the class (at most 500 ms) and gives it to the page in the URL hash. Tested in Chrome. Needs a new run. |

## Findings

### Local Network Access

Chrome blocks a page on a public origin (`www.figma.com`) when it opens a local address in an iframe: `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` for `http://localhost:5173` in the Chrome test. The Tailscale IP `100.110.230.14` is in `100.64.0.0/10`, which is also a local address for this feature. A cross-origin iframe gets the permission only with `allow="local-network-access"` on the iframe, and Figma controls the plugin iframe.

Figma Desktop 126 runs Electron 43 (Chromium 150). The local run loaded `http://localhost:5173` in the plugin iframe, so Figma Desktop does not block it. The hosted run must confirm this for `100.110.230.14`.

If Figma Desktop blocks the Tailscale address:

- Serve the static files on the public IP, without the Tailscale limit. The files contain no secrets. Keep only the routes that are safe as public routes (skills.sh). Remove the `chatgpt.com` route.
- Or a bundled UI with a separate storage page (option B in the decision log).

### ChatGPT

pi-ai 1.4.0 calls the Codex provider "legacy". Its OpenAI provider has **Sign in with ChatGPT**: the ChatGPT subscription with `api.openai.com`, which allows CORS. The login is an OAuth PKCE flow that goes to `http://127.0.0.1:1455/auth/callback`. In a browser, the user copies the URL of that page (it does not load) into FigPal. The spike tests both:

- A: Codex device code, inference directly and through `/api/chatgpt/*`.
- B: Sign in with ChatGPT, inference directly on `api.openai.com`.

Result (local run): A and B log in. B accepts only newer models (for example `gpt-5.6-luna`, not `gpt-4`). If the B call works with such a model, FigPal needs no `chatgpt.com` route.

### Credentials and model code

`figma_execute` code runs in the same sandbox as `code.js`. It can call `figma.clientStorage.getAsync("figpal.…")` and read the credentials. Decision (2026-10-29): the credentials stay in clientStorage.

### pi-ai in the browser

- The Codex provider has only OAuth auth, and its OAuth module needs Node. pi-ai then ignores an explicit `apiKey` ("Provider is not configured"). The spike gives the provider an API key auth that takes the access token.
- The Anthropic and OpenAI providers accept an explicit `apiKey`.
- Claude OAuth requests now use the browser port of [Pi Black](pi-black.md). The adapter passes fake-transport tests with pi-ai and pi-durable 1.4.0. An OPTIONS preflight allows its new headers. Live subscription inference (0.3) and native search (0.8) are still open.

### pi-durable

- `IndexedDbStorage.open(name)` has no `readOnly` option (1.4.0). The plan's read-only second window needs another solution (for example, a notice and no agent).
- Tools are given to the model through `system` messages (`toolsAdded`). The token budget check can measure them there.
- pi-durable does not pass request options to pi-ai. The spike wraps `Models.streamSimple` in a `Proxy` to add the API key, the Codex transport (`sse`) and `onPayload`.

## Changes to the plan

- Facts: the AsyncFunction constructor is not blocked. Anthropic CORS needs the browser header. skills.sh has no CORS header, so the `/api/skills/*` route is necessary.
- `networkAccess` does not restrict the hosted UI (0.2).
- Theme: the hosted UI gets the theme from the URL hash (0.16).
- Phase 2: no `readOnly` option in `IndexedDbStorage`.
- 0.4: test Sign in with ChatGPT first. If it works, remove the `chatgpt.com` route.
