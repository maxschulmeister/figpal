# Design-system audit (copied)

Copied from [figma-console-mcp](https://github.com/southleft/figma-console-mcp) at commit `5ef4df3` (MIT, see `../LICENSE`):

- `src/apps/design-system-dashboard/scoring/*.ts`: the scoring engine, its 6 categories, and the fix hints (`remediation.ts`).
- `tests/scoring/*.test.ts`: its tests. FigPal changed only the vitest imports and the paths.

Each file starts with `// @ts-nocheck`, because FigPal's TypeScript settings are stricter.

FigPal's `web/src/audit.ts` gives the engine the local variables, components and styles that `code.js` reads (no REST calls), and writes the report text. The text is adapted from upstream's `figma_audit_design_system_report` in `src/apps/design-system-dashboard/server.ts`, without the MCP server, the cache, the `full` format, the data-source notes and the tool names in the fixes.

Changes (each has a `FigPal` comment; tests in `fixes.test.ts` where the behavior changes):

- `remediation.ts`: the fix texts say "the agent", not "this MCP". The `tools` lists stay, but FigPal does not show them: it has no such tools and fixes with `figma_execute`.
- `accessibility.ts`: the contrast check without text or background names stops at the 50 pairs that it keeps. Before, it made every dark × light pair first: 4,000 such colors used about 180 MB.
