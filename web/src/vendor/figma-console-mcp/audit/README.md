# Design-system audit (copied)

Copied from [figma-console-mcp](https://github.com/southleft/figma-console-mcp) at commit `5ef4df3` (MIT, see `../LICENSE`):

- `src/apps/design-system-dashboard/scoring/*.ts`: the scoring engine, its 6 categories, and the fix hints (`remediation.ts`).
- `tests/scoring/*.test.ts`: its tests. FigPal changed the vitest imports and the paths, and one test for a change below (`ui-rendering.test.ts`: component locations are not capped).

Each file starts with `// @ts-nocheck`, because FigPal's TypeScript settings are stricter.

FigPal's `web/src/audit.ts` gives the engine the local variables, components and styles that `code.js` reads (no REST calls), and writes the report text. The text is adapted from upstream's `figma_audit_design_system_report` in `src/apps/design-system-dashboard/server.ts`, without the MCP server, the cache, the `full` format, the data-source notes and the tool names in the fixes.

Changes (each has a `FigPal` comment; tests in `fixes.test.ts` where the behavior changes):

- `remediation.ts`: the fix texts say "the agent", not "this MCP". The `tools` lists stay, but FigPal does not show them: it has no such tools and fixes with `figma_execute`.
- `accessibility.ts`: the contrast check without text or background names stops at the 50 pairs that it keeps. Before, it made every dark × light pair first: 4,000 such colors used about 180 MB.
- `accessibility.ts`: the contrast check runs twice on the same color pairs: "Color contrast (WCAG 2)" (4.5:1, upstream) and "Color contrast (APCA)" (`a11y-color-contrast-apca`, Lc 60 with `apca-w3`, the method of the WCAG 3 drafts; the minimum for content text, body text needs Lc 75). Failing examples keep the APCA sign, and both values are rounded toward zero, so that a failing value does not show as the threshold. Both count in the accessibility score (user decision: no setting). `remediation.ts` has a fix text for the APCA finding.
- `component-metadata.ts`: the locations of a finding list all its components, not the first 5, so that the chat can select them. The examples stay at 5.
