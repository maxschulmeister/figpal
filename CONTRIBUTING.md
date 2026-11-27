# Contributing

## Build

You need macOS or Linux, Node.js 22 or later, and pnpm.

```sh
pnpm install
pnpm build            # the plugin (plugin/dist) and the UI (web/dist)
pnpm package          # the npm package figpal in local/dist
pnpm local:install    # installs that package on this computer, as npx figpal install does
pnpm local:uninstall
```

The repo has these parts:

- `plugin/`: the plugin's main thread (`code.js`) and its manifest.
- `web/`: the UI in the plugin window, with the agent.
- `local/`: the npm package `figpal`. It serves the UI on `http://localhost:9310`, forwards the model requests, and is
  the MCP server for outside agents (`figpal mcp`).
- `shared/`: the messages between these parts.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm e2e
```

`pnpm e2e` opens FigPal in Chrome, in a fake Figma page with a fake model, and runs the checks in `e2e/tests` in the
light and the dark theme (about 4 minutes).

- `pnpm e2e chips lint`: only these checks. `--light` or `--dark`: one theme.
- `pnpm e2e --ui http://localhost:9310`: the installed UI.
- Chrome must be installed; `CHROME=/path/to/chrome` sets another path. Screenshots go to `$TMPDIR/figpal-e2e`.

## Try, merge, release

Each change has its own branch and PR. `main` has only changes that you tried.

1. **Try:** add the label `next` to the PRs to try (`gh pr edit <number> --add-label next`), then run `pnpm next`. It
   makes the branch `next` from `main` and these PRs, and pushes it. The release workflow publishes a preview, for
   example `0.1.9-next.12`, with the npm tag `next`. On the Mac with Figma: `npx figpal@next install`, then run FigPal
   again in Figma. After a change to a PR, run `pnpm next` again.
2. **Merge:** merge the PRs that work into `main`, and remove their label.
3. **Release:** set the version in `local/package.json` in a commit "Release x.y.z: …" on `main`, then push the tag
   `vx.y.z`. The release workflow runs the checks and publishes `figpal` to npm with the tag `latest`.

A preview shows the update notice when a release of its version or a newer one is on npm. To go back from a preview
without a release: `npx figpal@latest install`. A preview can change the saved data of the threads: an older version
may not read them.
