# FigPal

A Figma Desktop plugin with an AI agent. See [PLAN.md](PLAN.md) for the design and the phases.

## Run

1. `pnpm install`, then `pnpm dev`. This starts the local UI (Vite on `http://localhost:5173`) and builds `plugin/dist/code.js`.
2. In Figma Desktop: **Plugins → Development → Import plugin from manifest…**, then select `plugin/manifest.json`.
3. Open a test file (not a work file). Run **FigPal**. The window title shows the UI: "FigPal (remote)" or "FigPal (local)". To change it, use **Settings**.
4. At the first start, connect a model: paste a Claude token (in Terminal, `claude setup-token` makes one), or sign in with ChatGPT. **Settings** (top right) has both.
5. Skills: at the first start, FigPal installs Figma's skills. To add more, open **Settings → Skills**: search skills.sh, paste `npx skills add owner/repo@skill`, or upload a zip.
6. Models: below the prompt, the model and thinking level have separate menus on the left. **Edit Models** at the end of the model menu opens **Settings → Models**, where you select the models for the chat. FigPal can also give them to subagents, which run tasks at the same time. With no selection, it uses all models.
7. Web: FigPal searches the web with the model's own search tool and names its sources. It can find images on the web and put them on the canvas.
8. Figma API: for comments, versions and libraries, paste a Figma personal access token in **Settings → Access**. Read-only scopes are enough for most tasks.
9. Selections: select layers while you type. Each selection goes into the message as a chip at the cursor, so one message can give feedback on several layers. A new selection replaces the chip before the cursor until you type; click a chip to replace it.
10. Exports: ask FigPal to export the variables as design tokens (DTCG, CSS, Tailwind, SCSS and others), or to export layers as SVG or PDF. The step shows each file with a **Download** button. FigPal keeps the files only until it closes; after that, **Download** makes an export again from the current file.
11. Versions: with a Figma token, ask what changed since a version, for example "What changed in the Button component since last week?". FigPal compares the pages, and for the layers you name their children, component properties and variable bindings.
12. Design-system audit: ask FigPal to audit the design system. The step shows a score from 0 to 100 for naming, tokens, components, accessibility, consistency and coverage, and FigPal explains the findings and can fix them.
13. Layer checks: ask FigPal to check a page or a frame, for example "Check this page". The step shows a pill for each problem, such as "Color without variable · 12"; click it to select those layers. Contrast is checked with WCAG 2 and with APCA (the method of the WCAG 3 drafts).
14. Motion: ask FigPal to animate a frame, for example "Fade in the cards one after the other". FigPal checks its work with frames of the animation (the step "Check animation"). Ask for an MP4, WebM or GIF to download the animation.
15. The panel: drag the grip in the bottom-right corner to resize FigPal (or focus it and use the arrow keys); FigPal keeps the size. Under the message box, on the right, FigPal shows how much of the model's context window the chat uses, for example "45k / 1M".
16. Run in the background: the – button in the header hides FigPal while the agent works. A Figma notice with a Show button brings it back, and says when FigPal is done.

The remote UI is on `https://figpal.maxschulmeister.dev` (Tailscale only). `pnpm deploy:web` builds and uploads it.

## Checks

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

Browser checks: `pnpm e2e` opens FigPal in Chrome, in a fake Figma page with a fake model, and runs the checks in `e2e/tests` in the light and the dark theme (about 3 minutes). It starts Vite on a free port and stops it at the end.

- `pnpm e2e chips lint`: only these checks. `--light` or `--dark`: one theme.
- `pnpm e2e --ui https://figpal.maxschulmeister.dev`: the deployed UI.
- Chrome must be installed; `CHROME=/path/to/chrome` sets another path. Screenshots go to `$TMPDIR/figpal-e2e`.
