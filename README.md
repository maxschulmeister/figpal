# FigPal

An AI agent in Figma Desktop. FigPal reads and changes the open file through Figma's Plugin API, with the model that
you choose: Claude, ChatGPT, or an API key of another provider.

FigPal is not in the Figma Community. You install it from npm, and import it in Figma Desktop as a development plugin.

## Install

You need macOS, Figma Desktop, and [Node.js](https://nodejs.org) 22 or later.

1. In Terminal, run:

   ```sh
   npx figpal@latest install
   ```

   This copies FigPal to `~/Library/Application Support/FigPal` and starts it now and at each login. It also adds the
   command `figpal`, and gives Claude Code FigPal's MCP server (if Claude Code is installed).
2. In Figma Desktop, select **Plugins → Development → Import plugin from manifest…**. Then select
   `~/Library/Application Support/FigPal/plugin/manifest.json`. The install puts this path on the clipboard: in the file
   dialog, press Cmd+Shift+G and paste it. You do this only once.
3. Open a file and run **FigPal** (**Plugins → Development → FigPal**). Connect a model.

To update FigPal, run `npx figpal@latest install` again. To remove it, run `npx figpal uninstall`, then remove the plugin
in Figma Desktop (**Plugins → Development → Manage plugins in development**).

If FigPal does not run, the plugin window shows the install command. It opens FigPal when FigPal runs again.

## Models

- **Claude:** paste a token from `claude setup-token`, or an Anthropic API key.
- **ChatGPT:** select **Sign in with ChatGPT**.
- **Other providers:** **Settings → Models → Add a provider**. FigPal offers the providers of
  [pi-ai](https://github.com/earendil-works/pi) that use an API key: for example OpenAI, Google, OpenRouter, Mistral, xAI,
  DeepSeek, Azure OpenAI, Google Vertex AI (API key) and Cloudflare. Amazon Bedrock is not available.

The Claude token and **Sign in with ChatGPT** use your subscription in a way that Anthropic and OpenAI do not officially
support for FigPal. Check their terms before you use them. An API key is the alternative.

FigPal can search the web with Claude, ChatGPT and OpenAI. Other models cannot search.

## What FigPal does

- **Chats:** each Figma file has its own chats. A chat continues after you close and open FigPal again. A small model
  names each chat. The chat list shows the chats that are done at the top, and the groups **Working**, **Settled** and
  **Archived** at the bottom.
- **Selections:** select layers while you type. Each selection goes into the message as a chip at the cursor, so one
  message can give feedback on several layers. When FigPal names layers in an answer, click them to select them.
- **Skills:** at the first start, FigPal installs Figma's skills. **Settings → Skills** searches skills.sh, installs a
  skill from `npx skills add owner/repo@skill`, or uploads a zip.
- **Subagents:** FigPal can give tasks to subagents, which work at the same time. **Settings → Models** selects the
  models for the model menu and for subagents.
- **Web:** FigPal searches the web and names its sources (see [Models](#models)). It can put images from the web on the
  canvas.
- **Rules:** **Settings → Rules** has rules that FigPal follows in every chat. **For all files** is only for you.
  **For this file** is saved in the Figma file, so everyone who runs FigPal on it gets them.
- **Figma API:** for comments, versions and libraries, paste a Figma personal access token in **Settings → Access**.
  Read-only scopes are enough for most tasks.
- **Exports:** design tokens (DTCG, CSS, Tailwind, SCSS and others), and layers as SVG, PDF, PNG or JPG. Motion
  animations as MP4, WebM or GIF.
- **Checks:** a design-system audit with a score from 0 to 100, and layer checks for colors, text, spacing and contrast
  (WCAG 2 and APCA). Click a finding to select its layers.
- **Versions:** with a Figma token, ask what changed since a version.
- **Background:** the eye button hides FigPal while it works. A Figma notice brings it back, and says when FigPal is done.
- **Messages while FigPal works:** Enter adds the message to the running work, Cmd+Enter sends it after the answer.
- **Attachments:** add images and text files with the + button, by paste or by drop.
- **Backup:** **Settings → Access → Backup** exports your chats and skills to a file, and imports such a file. The file
  has no keys.

## Agents (MCP)

Agents on your Mac can run code in the open file through FigPal. Turn on **Settings → Access → MCP**. The install adds
FigPal to Claude Code. For another agent, select it in **Settings → Access → MCP** and copy its command, for example
`codex mcp add figpal -- figpal mcp`. FigPal must be open in Figma. With several files, the agent names the file.

**Settings → Access → Shared folders** gives FigPal's agent folders of your Mac to read and write.

## Privacy and security

- FigPal has no server. The FigPal command on your Mac serves the plugin's UI on `http://localhost:9310`. Model requests
  go from your Mac to the provider, through the FigPal command.
- Your keys, chats and skills stay in Figma Desktop's storage on your Mac.
- The agent runs code in your Figma file. A file, a web page or a skill can contain instructions for the agent (prompt
  injection). The steps in the chat show each piece of code that runs.
- **Rules for this file** come from everyone who can edit the file, and go to the agent.
- With a Figma token, the agent can read your other files through the Figma API. Use read-only scopes.
- Install only skills that you trust, and share only folders that the agent may change.

## Development

```sh
pnpm install
pnpm build            # the plugin (plugin/dist) and the UI (web/dist)
pnpm package          # the npm package in local/dist
pnpm local:install    # installs that package on this Mac, as npx figpal install does
```

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

Browser checks: `pnpm e2e` opens FigPal in Chrome, in a fake Figma page with a fake model, and runs the checks in
`e2e/tests` in the light and the dark theme (about 4 minutes). It starts Vite on a free port and stops it at the end.

- `pnpm e2e chips lint`: only these checks. `--light` or `--dark`: one theme.
- `pnpm e2e --ui http://localhost:9310`: the installed UI.
- Chrome must be installed; `CHROME=/path/to/chrome` sets another path. Screenshots go to `$TMPDIR/figpal-e2e`.

[PLAN.md](PLAN.md) has the design and the decisions. [NOTES.md](NOTES.md) has the open ideas.

## License

[AGPL-3.0](LICENSE). FigPal contains code of other projects: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
