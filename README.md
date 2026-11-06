# FigPal

FigPal is an AI agent in Figma Desktop. You tell it what you want, and it does the work in your file.

- **Built-in MCP server.** Claude Code, Codex, Cursor and other agents can read and change the file that you have open,
  through FigPal. The install adds FigPal to Claude Code. You need no Figma API token.
- **Few tokens.** FigPal gives an agent 2 tools: one runs Figma Plugin API code, one takes a screenshot. Other Figma MCP
  servers have one tool for each action, and most agents send all the tool definitions with each request.

| MCP server | Tools | Tool definitions |
| --- | ---: | --- |
| **FigPal** 0.1.0 | 2 | about 300 tokens |
| Talk to Figma (`cursor-talk-to-figma-mcp` 0.3.5) | 40 | about 5,800 tokens |
| `figma-console-mcp` 1.46.0 | 130 | about 48,000 tokens |

Measured on 2026-11-06: the size of each server's `tools/list` answer, at 4 characters for each token.

## Install

You need a Mac, Figma Desktop and [Node.js](https://nodejs.org) 22 or later.

1. In Terminal, run:

   ```sh
   npx figpal@latest install
   ```

2. In Figma Desktop, select **Plugins → Development → Import plugin from manifest…**. Press **Cmd+Shift+G**, paste
   (the install copied the path), and press **Return**.
3. Select **Plugins → Development → FigPal**, and connect a model.

To update FigPal, run the same command again. To remove it, run `npx figpal uninstall`.

## Models

- **Claude:** a token from `claude setup-token`, or an Anthropic API key.
- **ChatGPT:** sign in with your ChatGPT account.
- **Other providers:** an API key from OpenAI, Google, OpenRouter, Mistral, xAI, DeepSeek and more.

Anthropic and OpenAI do not officially support the use of a Claude or ChatGPT plan in FigPal. Read the terms of your
plan, or use an API key.

## What you can ask

- "Make a pricing card with auto layout."
- "Check this page for contrast problems."
- "Export the color variables as Tailwind tokens."
- "Fade in the cards one after the other, and export a GIF."

To point at layers, select them while you type. **Settings** has your rules, skills, models and a backup of your chats.

## Use FigPal from your agent

1. In FigPal, turn on **Settings → Access → MCP**.
2. Claude Code has FigPal after the install. For other agents, select your agent under MCP, and FigPal shows the setup,
   for example `codex mcp add figpal -- figpal mcp`.
3. Ask your agent, for example: "Build the selected Figma frame in React."

## Privacy

FigPal runs on your Mac. There is no FigPal server. Your keys and chats stay in Figma Desktop, and your requests go from
your Mac to the model provider that you select.

The agent runs code in your file. Text in a file, on a web page or in a skill can try to control it. Look at what it
does.

## License

[AGPL-3.0](LICENSE). FigPal contains code of other projects: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
To build FigPal yourself, see [CONTRIBUTING.md](CONTRIBUTING.md).
