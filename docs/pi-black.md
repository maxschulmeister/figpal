# Pi Black for pi-durable

FigPal applies Pi Black compatibility to Anthropic OAuth requests in the browser. Paste the token from `claude setup-token` in FigPal: at the first start, or in **More → Claude token…**. No Pi CLI extension install is needed.

## Source and scope

- Source: [paoloanzn/pi-black, commit `036a8a7981d369f16f316a11310396e50c8a9c6a`](https://github.com/paoloanzn/pi-black/tree/036a8a7981d369f16f316a11310396e50c8a9c6a).
- Protocol: Claude Code `2.1.280`.
- Host packages: pi-ai and pi-durable `1.4.0`, pinned in `web/package.json`.
- Browser port: `web/src/providers/pi-black.ts`. Its MIT notice is kept in the source and in `web/public/pi-black.LICENSE`. Vite copies that file to `web/dist/pi-black.LICENSE` for deployment.

The upstream package is a Node-based Pi extension, not a pi-durable browser extension. FigPal copies its request code without its CLI registration or local identity discovery. No new dependency or server process is needed. The provider context type is updated from `Context` to `TranscriptContext` for pi-ai 1.4.0.

`createAgentModels()` (`web/src/agent.ts`) wraps only `anthropicProvider()`: first Pi Black, then `throughRoute()` (the route, see below). Requests with a token that contains `sk-ant-oat` get:

- Billing and Agent SDK system blocks before the FigPal rules.
- A prompt fingerprint and a seeded XXH64 checksum of the final request body.
- Claude Code headers, a request UUID, and pi-durable's conversation session ID.

The wrapper keeps the existing payload hook, including native search. The checksum runs after that hook and SDK serialization. API-key requests pass through without changes. Other providers are not wrapped. pi-ai still handles streaming, tools, errors, retries, and usage. Credentials are in clientStorage (`web/src/credentials.ts`).

The browser does not read `~/.claude.json`. It does not add optional account identity metadata. The setup-token flow does not add OAuth login or refresh.

## FigPal changes to the port

- When the checksum step in the fetch wrapper fails, the wrapper returns a `400 invalid_request_error` response with the Pi Black message. The upstream code throws there. In the browser, the Anthropic SDK turns that error into "Connection error.", and pi-ai and pi-durable retry it, although a retry cannot help.
- Kept as upstream: the request copy (`structuredClone`) and the BigInt XXH64 checksum on each model request (a few milliseconds per MB of transcript). Change them only if Phase 1 shows slow UI.
- In a browser, the Anthropic SDK sends `X-Stainless-Runtime: browser:chrome`, `X-Stainless-OS: Unknown` and `X-Stainless-Arch: unknown`. Upstream (Node) sends Node values. `fetchAsServer` (`web/src/providers/anthropic-route.ts`) replaces them with the values of the SDK in Node on this Mac (`node`, `v26.1.0`, `MacOS`, `arm64`). These are fixed values: update them with Pi Black or Node updates.

## Checks

Run `pnpm test`, `pnpm typecheck`, and `pnpm build`. Then run `cmp web/public/pi-black.LICENSE web/dist/pi-black.LICENSE` to check the distributed license.

`web/src/providers/pi-black.test.ts` uses the real pi-ai provider with a fake HTTP transport. It checks OAuth fields, an upstream checksum fixture, unchanged API-key requests, native search, payload hook composition, repeated transforms, streaming, usage, and session headers from a real pi-durable Harness. It needs no credentials and makes no inference requests.

On 2026-10-30, an unauthenticated OPTIONS request to `api.anthropic.com/v1/messages` from `https://figpal.maxschulmeister.dev` returned 200 and allowed both new headers: `x-client-request-id` and `x-claude-code-session-id`. This is a preflight check, not a live subscription test.

Live checks in Figma Desktop (2026-10-30): a message with a `claude setup-token` token (spike 0.3) and native search (spike 0.8) pass, local and remote.

Chromium replaces the page-set `user-agent` header (checked in Chrome 156). Anthropic also refuses browser requests for subscription accounts ("CORS requests are not allowed for this Organization"). So the page sends Claude requests through `/api/anthropic` (dev server and Caddy) (`web/src/providers/anthropic-route.ts`). The route removes the browser headers and sets the user-agent from `x-figpal-user-agent`.

The existing Vite warning for pi-ai's `node:fs` import is unchanged. The browser port adds no Node imports.

## Updates and terms

This is an unofficial, version-specific compatibility layer. It does not update automatically. When Pi Black, pi-ai, or the Claude Code protocol changes, compare the pinned source, run the checks, and repeat the live test. Users must check the applicable subscription terms. API keys remain an alternative.
