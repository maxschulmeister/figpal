# Contributing

[PLAN.md](PLAN.md) has the design and the decisions. [NOTES.md](NOTES.md) has the open ideas.

## Build

You need macOS, Node.js 22 or later, and pnpm.

```sh
pnpm install
pnpm build            # the plugin (plugin/dist) and the UI (web/dist)
pnpm package          # the npm package figpal in local/dist
pnpm local:install    # installs that package on this Mac, as npx figpal install does
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

## Release

The version is in `local/package.json`. Push a tag `v<version>`: the release workflow runs the checks and publishes
`figpal` to npm.
