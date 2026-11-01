// @ts-nocheck: copied code; FigPal's TypeScript settings are stricter. See README.md.
/**
 * Formatter dispatcher. Each formatter converts our canonical internal
 * TokenDocument into a specific output format (DTCG JSON, CSS custom
 * properties, Tailwind v4 @theme, SCSS, etc.).
 */

import type { ExportFormat, TokenDocument } from "../types.js";
import type { ExportFormat as TargetFormat } from "../types.js";

/**
 * FigPal: the type of an output target, without config.ts (zod and node:fs). The same fields as `OutputTargetSchema`
 * there.
 */
export interface OutputTarget {
  format: TargetFormat;
  filename?: string;
  prefix?: string;
  splitByMode?: boolean;
  splitByCollection?: boolean;
  resolveAliases?: boolean;
  dtcgDialect?: "legacy" | "2025";
  transforms?: {
    colorFormat?: "hex" | "hex8" | "rgba" | "oklch" | "hsl";
    sizeUnit?: "px" | "rem" | "pt" | "dp";
    remBase?: number;
  };
}

import { formatDtcg } from "./dtcg.js";
import { formatTokensStudio } from "./tokens-studio.js";
import { formatCssVars } from "./css-vars.js";
import { formatTailwindV4 } from "./tailwind-v4.js";
import { formatTailwindV3 } from "./tailwind-v3.js";
import { formatScss } from "./scss.js";
import { formatTsModule } from "./ts-module.js";
import { formatJsonFlat, formatJsonNested } from "./json.js";
import { formatStyleDictionaryV3 } from "./style-dictionary-v3.js";

export interface FormatOptions {
  /** Output target options merged from per-call args and tokens.config.json. */
  target: OutputTarget;
  /** Project root path. Resolves output filenames relative to this. */
  projectRoot?: string;
}

export interface FormatResult {
  /**
   * Output files to write. Single-file formats return one entry; split formats
   * (splitByMode, splitByCollection) return one per file.
   */
  files: Array<{
    /** Relative path from the configured generated.dir or projectRoot. */
    path: string;
    /** UTF-8 content. */
    content: string;
  }>;
  /** Format-specific warnings (e.g. "composite typography expanded to primitives"). */
  warnings: string[];
}

export function format(
  doc: TokenDocument,
  options: FormatOptions,
): FormatResult {
  switch (options.target.format) {
    case "dtcg":
      return formatDtcg(doc, options);
    case "tokens-studio":
      return formatTokensStudio(doc, options);
    case "css-vars":
      return formatCssVars(doc, options);
    case "tailwind-v4":
      return formatTailwindV4(doc, options);
    case "tailwind-v3":
      return formatTailwindV3(doc, options);
    case "scss":
      return formatScss(doc, options);
    // FigPal: the Less formatter of figma-console-mcp is a stub that throws.
    case "less":
      throw new Error("[figma-console-mcp] The Less variables formatter is not implemented.");
    case "ts-module":
      return formatTsModule(doc, options);
    case "json-flat":
      return formatJsonFlat(doc, options);
    case "json-nested":
      return formatJsonNested(doc, options);
    case "style-dictionary-v3":
      return formatStyleDictionaryV3(doc, options);
    default: {
      const _exhaustive: never = options.target.format;
      throw new Error(
        `[figma-console-mcp] Unknown export format: ${_exhaustive}`,
      );
    }
  }
}

export type { ExportFormat };
