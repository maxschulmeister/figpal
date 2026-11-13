# FigPal

FigPal is an AI agent inside Figma Desktop. Tell it what you want, and it makes the change in your file.

You can also use FigPal from Claude Code, Codex, Cursor and other agents. They can read and change the Figma file that
you have open. You do not need a Figma API token.

FigPal uses few tokens. It gives an agent only 2 tools: one runs Figma Plugin API code, and one takes a screenshot. Most
Figma MCP servers have one tool for each action, and most agents send all tool definitions with each request.

| MCP server | Tools | Tool definitions |
| --- | ---: | --- |
| **FigPal** 0.1.0 | 2 | about 300 tokens |
| Talk to Figma (`cursor-talk-to-figma-mcp` 0.3.5) | 40 | about 5,800 tokens |
| `figma-console-mcp` 1.46.0 | 130 | about 48,000 tokens |

<sub>Measured on 2026-11-06: the size of each server's `tools/list` response, at 4 characters for each token.</sub>

## Install

You need macOS, [Figma Desktop](https://www.figma.com/downloads/) and [Node.js](https://nodejs.org) 22 or later. Linux
works too (see below). Windows is not supported yet.

1. Open a terminal and run:

   ```sh
   npx figpal@latest install
   ```

   The install starts FigPal in the background, also after each login, and adds FigPal to Claude Code. It also copies
   the path of the plugin manifest to your clipboard.

2. In Figma Desktop, select **Plugins → Development → Import plugin from manifest…**. Press **Cmd+Shift+G**, paste the
   path, and press **Return**.

To update FigPal, run the install command again. To remove FigPal, run `npx figpal uninstall`.

<details>
<summary>Linux</summary>

Figma has no Linux app. You can try [Figma for Linux](https://github.com/Figma-Linux/figma-linux), a community app.
FigPal is not tested in it yet.

- The install needs systemd.
- To import the manifest, press **Ctrl+L** instead of **Cmd+Shift+G**.
- To share folders with FigPal, install `zenity` or `kdialog`.
- To copy the manifest path, install `wl-clipboard` or `xclip`.

</details>

## Plugin

Select **Plugins → Development → FigPal**, and connect a model:

- **Claude:** paste a token from `claude setup-token`, or an Anthropic API key.
- **ChatGPT:** sign in with your ChatGPT account.
- **Other providers:** paste an API key from OpenAI, Google, OpenRouter, Mistral, xAI, DeepSeek and more.

> **Note:**
> Anthropic and OpenAI do not officially support the use of a Claude or ChatGPT plan in FigPal. Read the terms of your
> plan, or use an API key.

Then ask FigPal, for example:

- "Make a pricing card with auto layout."
- "Check this page for contrast problems."
- "Export the color variables as Tailwind tokens."
- "Fade in the cards one after the other, and export a GIF."

To point FigPal at layers, select them in Figma while you type. In **Settings**, you can add your own rules and skills,
pick models, and back up your chats.

### Local files

FigPal can read and write files on your computer, for example to use your design tokens or to export code. Select
**Settings → Access → Shared folders → Add folders**, and select the folders. FigPal can use only these folders and
their subfolders.

## MCP

Use FigPal from your own agent:

1. In FigPal, turn on **Settings → Access → MCP**.
2. Add FigPal to your agent. The install already adds it to Claude Code. For other agents, select your agent under
   **MCP**, and FigPal shows the command. For example:

   ```sh
   codex mcp add figpal -- figpal mcp
   ```

3. Ask your agent, for example: "Build the selected Figma frame in React."

### MCP over Tailscale

An agent on another computer, for example in a VM, can use FigPal through [Tailscale](https://tailscale.com).

On the computer with Figma, make FigPal's ports available to your tailnet:

```sh
for p in $(seq 9300 9309); do tailscale serve --bg --tcp=$p tcp://127.0.0.1:$p; done
```

On the other computer, give the Tailscale address of the Figma computer to `figpal mcp`:

```sh
claude mcp add figpal -- npx -y figpal mcp --host 100.x.y.z
```

> **Warning:**
> There is no password. Each device in your tailnet that can reach these ports can run code in your open Figma file. To
> limit access, use a Tailscale access rule. To stop, run `tailscale serve --tcp=<port> off` for each port.

## Privacy and safety

FigPal runs on your computer. There is no FigPal server. Your keys and chats stay in Figma Desktop. Your requests go
directly from your computer to the model provider that you select.

The agent runs code in your Figma file and can write in your shared folders. Text in a file, on a web page or in a
skill can try to give the agent instructions. Look at what the agent does.

## License

[AGPL-3.0](LICENSE). FigPal contains code from other projects: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
To build FigPal yourself, see [CONTRIBUTING.md](CONTRIBUTING.md).
