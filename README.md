# FigPal

A Figma Desktop plugin with an AI agent. See [PLAN.md](PLAN.md) for the design and the phases.

## Run

1. `pnpm install`, then `pnpm dev`. This starts the local UI (Vite on `http://localhost:5173`) and builds `plugin/dist/code.js`.
2. In Figma Desktop: **Plugins → Development → Import plugin from manifest…**, then select `plugin/manifest.json`.
3. Open a test file (not a work file). Run **FigPal**. The window title shows the UI: "FigPal (remote)" or "FigPal (local)". To change it, use **Settings**.
4. At the first start, connect a model: paste a Claude token (in Terminal, `claude setup-token` makes one), or sign in with ChatGPT. **Settings** (top right) has both.
5. Skills: at the first start, FigPal installs Figma's skills. To add more, open **Settings → Skills**: search skills.sh, paste `npx skills add owner/repo@skill`, or upload a zip.
6. Models: in **Settings → Models**, select the models for the model menu in the chat. FigPal can also give them to subagents, which run tasks at the same time. With no selection, it uses all models.

The remote UI is on `https://figpal.maxschulmeister.dev` (Tailscale only). `pnpm deploy:web` builds and uploads it.

## Checks

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
