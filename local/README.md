# figpal

An AI agent in Figma Desktop, for macOS and Linux. See [github.com/maxschulmeister/figpal](https://github.com/maxschulmeister/figpal).

- **Built-in MCP server:** Claude Code, Codex, Cursor and other agents can read and change your open Figma file.
- **Few tokens:** 2 tools, about 300 tokens of tool definitions. `figma-console-mcp` 1.46.0 has 130 tools, about 48,000
  tokens.

```sh
npx figpal@latest install    # install, or update
npx figpal uninstall         # remove
```

The install copies FigPal to `~/Library/Application Support/FigPal` (macOS) or `~/.local/share/figpal` (Linux), and
starts it at login. Then, in Figma Desktop, select **Plugins → Development → Import plugin from manifest…** and select
`plugin/manifest.json` in that folder. On Linux, use [Figma for Linux](https://github.com/Figma-Linux/figma-linux).

Agents use FigPal's MCP server with `figpal mcp`, for example `claude mcp add figpal -- figpal mcp`. An agent on another
computer uses `figpal mcp --host <address>`: see the README on GitHub.

License: AGPL-3.0. The package contains `THIRD_PARTY_NOTICES.md` and `licenses.md`.
