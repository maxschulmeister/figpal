# Token converter and formatters from figma-console-mcp

Copied from [figma-console-mcp](https://github.com/southleft/figma-console-mcp) `src/core/tokens` at commit `5ef4df3` (MIT, see `../LICENSE`). FigPal's token export (`web/src/tokens.ts`) uses them.

Copied: `types.ts`, `alias-resolver.ts`, `dialect.ts`, `figma-converter.ts`, and `formatters/` without `less.ts` and `stubs.ts`. `formatters.test.ts` is the upstream `tests/tokens-formatters.test.ts`.

Not copied: the parsers and the import (FigPal does not import tokens), `config.ts` (zod, `node:fs`), `schemas.ts` (zod), `transforms/` (no copied file uses it), and the Less formatter (an upstream stub that throws).

Changes:

- Each file starts with `// @ts-nocheck`. FigPal's TypeScript settings are stricter (`noUncheckedIndexedAccess`). The upstream code type-checks with its own settings, and changes to about 60 lines would make a later update hard. The formatter tests check the behavior.
- `formatters/index.ts`: the type `OutputTarget` is defined there, with the fields of `OutputTargetSchema` in `config.ts`. The `less` format throws.
- `formatters.test.ts`: vitest imports and paths.

Fixes (FigPal tests in `web/src/tokens.test.ts`; each fix has a `FigPal` comment):

- `formatters/css-vars.ts`: the first mode of each collection goes into `:root`, also when Figma names it "Mode 1". Before, only "Default", "Light" and "Value" did, so most single-mode collections went under `[data-theme="mode-1"]`, and aliases to them were undefined.
- `formatters/tailwind-v4.ts`: the same for `@theme`: each set has its own primary mode, not one for the whole file.
- `formatters/motion.ts` (new): durations become `400ms` and easings `cubic-bezier(…)` in `css-vars`, `scss`, `tailwind-v4` and `tailwind-v3`. Before, they were JSON, such as `{"value":400,"unit":"ms"}`.
- `formatters/tailwind-v3.ts`: durations go to `transitionDuration` (`transitionDelay` with "delay" in the name) and easings to `transitionTimingFunction`. Other tokens without a Tailwind key are skipped with a warning. Before, they went to `extend.extend`, which Tailwind ignores.

Not used by FigPal, kept so that an update stays a simple diff: `validateAliases` and `parseDtcgReference` (`alias-resolver.ts`), `canonicalizeTokenValueForComparison` (`dialect.ts`), and the import and diff types in `types.ts`. The DTCG output keeps upstream's round-trip metadata (`lastSyncedAt` and others), so two exports of the same tokens differ in these fields.
