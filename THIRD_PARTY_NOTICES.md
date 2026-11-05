# Third-party notices

FigPal is licensed under the GNU Affero General Public License, version 3 (see [LICENSE](LICENSE)). It contains code of
other projects:

- **Copied code**, in the repository with its license:
  - [figma-console-mcp](https://github.com/southleft/figma-console-mcp) (MIT): the checks in
    `plugin/src/vendor/figma-console-mcp`, and the token export, version diff and design-system audit in
    `web/src/vendor/figma-console-mcp`. The license is next to the code.
  - [Pi Black](https://github.com/paoloanzn/pi-black) (MIT): the request code in `web/src/providers/pi-black.ts`. The
    license is in `web/public/pi-black.LICENSE`.
- **Libraries** in the builds. The builds list each one with its license:
  - the UI: `licenses.md` in the UI build (`web/dist`, and `dist/ui` in the npm package);
  - the FigPal command and the plugin: `licenses.md` in the npm package.

APCA (`apca-w3`, with `colorparsley`) is licensed under its "Limited W3 License" and the AGPL-3.0. FigPal uses its
contrast method as published, with the current constants, and keeps the polarity of Lc.

The default skills come from Figma's [mcp-server-guide](https://github.com/figma/mcp-server-guide). FigPal does not
contain them: each user installs them from skills.sh at the first start.
