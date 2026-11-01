# Version diff from figma-console-mcp

Copied from [figma-console-mcp](https://github.com/southleft/figma-console-mcp) `src/core/diff` at commit `5ef4df3` (MIT, see `../LICENSE`). The tool `figma_diff_versions` in `web/src/extensions/figma.ts` uses them. Like upstream's `computeDiff` in `src/core/version-tools.ts`, it reads the file at depth 1 and the nodes at depth 2 for each version. Unlike upstream, it reads all nodes in one call for each version, so a diff uses at most 4 calls: Figma's rate limits for these calls are strict.

Copied: `diff-engine.ts` and `changelog-formatter.ts`, and their upstream tests `tests/diff/*.test.ts`.

Not copied: `version-cache.ts` (a cache of version snapshots for a long-running server), `property-compare.ts` (not used by these files), and `version-tools.ts` (MCP tools, the Desktop Bridge buffer of description changes, and author lookups).

Changes:

- Each file starts with `// @ts-nocheck`: FigPal's TypeScript settings are stricter (`noUncheckedIndexedAccess`). The upstream tests check the behavior.
- The tests: vitest imports and paths.
- `changelog-formatter.ts` and its test: the hint without scoped nodes names `node_ids`, the parameter of `figma_diff_versions`, not `component_ids`.

Fixes (FigPal tests in `fixes.test.ts`; each fix has a `FigPal` comment):

- `diff-engine.ts`: bindings compare each variable reference of an array (`fills[1]`) and of a nested object (`size.x`, `rectangleCornerRadii.*`, `individualStrokeWeights.*`, `componentProperties.*`). Before, only the first reference of an array counted, and nested objects not at all.
- `diff-engine.ts` and `changelog-formatter.ts`: children with the same ID and a new name, such as a renamed variant, are `children_renamed`. Before, a renamed variant gave "No changes".
