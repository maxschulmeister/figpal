# Pi Black for pi-durable

FigPal applies Pi Black compatibility to Anthropic OAuth requests in the browser. Use the existing Claude token field and **Save token** button. No Pi CLI extension install is needed.

## Source and scope

- Source: [paoloanzn/pi-black, commit `036a8a7981d369f16f316a11310396e50c8a9c6a`](https://github.com/paoloanzn/pi-black/tree/036a8a7981d369f16f316a11310396e50c8a9c6a).
- Protocol: Claude Code `2.1.280`.
- Host packages: pi-ai and pi-durable `1.4.0`, pinned in `web/package.json`.
- Browser port: `web/src/providers/pi-black.ts`. Its MIT notice is kept in the source and in `web/public/pi-black.LICENSE`. Vite copies that file to `web/dist/pi-black.LICENSE` for deployment.

The upstream package is a Node-based Pi extension, not a pi-durable browser extension. FigPal copies its request code without its CLI registration or local identity discovery. No new dependency or server process is needed. The provider context type is updated from `Context` to `TranscriptContext` for pi-ai 1.4.0.

`createSpikeModels()` wraps only `anthropicProvider()`. Requests with a token that contains `sk-ant-oat` get:

- Billing and Agent SDK system blocks before the FigPal rules.
- A prompt fingerprint and a seeded XXH64 checksum of the final request body.
- Claude Code headers, a request UUID, and pi-durable's conversation session ID.

The wrapper keeps the existing payload hook, including native search. The checksum runs after that hook and SDK serialization. API-key requests pass through without changes. Other providers are not wrapped. pi-ai still handles streaming, tools, errors, retries, and usage. Credentials stay in the existing store.

The browser does not read `~/.claude.json`. It does not add optional account identity metadata. The setup-token flow does not add OAuth login or refresh.

## Checks

Run `pnpm test`, `pnpm typecheck`, and `pnpm build`. Then run `cmp web/public/pi-black.LICENSE web/dist/pi-black.LICENSE` to check the distributed license.

`web/src/providers/pi-black.test.ts` uses the real pi-ai provider with a fake HTTP transport. It checks OAuth fields, an upstream checksum fixture, unchanged API-key requests, native search, payload hook composition, repeated transforms, streaming, usage, and session headers from a real pi-durable Harness. It needs no credentials and makes no inference requests.

On 2026-10-30, an unauthenticated OPTIONS request to `api.anthropic.com/v1/messages` from `https://figpal.maxschulmeister.dev` returned 200 and allowed both new headers: `x-client-request-id` and `x-claude-code-session-id`. This is a preflight check, not a live subscription test.

Still required in Figma Desktop:

1. Save a valid token from `claude setup-token` and send a message (spike 0.3).
2. Enable native search and send a search request (spike 0.8).
3. Check the request in Figma Desktop. Chromium can replace the page-set `user-agent` header; fake-transport tests cannot detect that. If inference fails because of this, test the fixed-host Caddy route described in `PLAN.md`.

The existing Vite warning for pi-ai's `node:fs` import is unchanged. The browser port adds no Node imports.

## Updates and terms

This is an unofficial, version-specific compatibility layer. It does not update automatically. When Pi Black, pi-ai, or the Claude Code protocol changes, compare the pinned source, run the checks, and repeat the live test. Users must check the applicable subscription terms. API keys remain an alternative.
