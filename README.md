# FigPal

FigPal is an AI agent in Figma Desktop. You tell it what you want, and it does the work in your file.

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

Agents such as Claude Code or Codex can use FigPal too: turn on **Settings → Access → MCP**.

## Privacy

FigPal runs on your Mac. There is no FigPal server. Your keys and chats stay in Figma Desktop, and your requests go from
your Mac to the model provider that you select.

The agent runs code in your file. Text in a file, on a web page or in a skill can try to control it. Look at what it
does.

## License

[AGPL-3.0](LICENSE). FigPal contains code of other projects: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
To build FigPal yourself, see [CONTRIBUTING.md](CONTRIBUTING.md).
