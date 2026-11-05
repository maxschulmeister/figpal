# figpal

An AI agent in Figma Desktop, for macOS. See [github.com/maxschulmeister/figpal](https://github.com/maxschulmeister/figpal).

```sh
npx figpal@latest install    # install, or update
npx figpal uninstall         # remove
```

The install copies FigPal to `~/Library/Application Support/FigPal` and starts it at login. Then, in Figma Desktop,
select **Plugins → Development → Import plugin from manifest…** and select
`~/Library/Application Support/FigPal/plugin/manifest.json`.

Agents use FigPal's MCP server with `figpal mcp`, for example `claude mcp add figpal -- figpal mcp`.

License: AGPL-3.0. The package contains `THIRD_PARTY_NOTICES.md` and `licenses.md`.
