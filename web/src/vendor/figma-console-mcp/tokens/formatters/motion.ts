// @ts-nocheck: copied code; FigPal's TypeScript settings are stricter. See README.md.
// FigPal: not in figma-console-mcp. The CSS text of a motion value; the formatters wrote these as JSON.

/** `400ms` for a duration `{ value, unit }`, `cubic-bezier(0, 0, 0.58, 1)` for an easing. Else undefined. */
export function cssMotion(value: unknown, type: string): string | undefined {
  if (type === "duration" && value && typeof value === "object" && "value" in value && "unit" in value) {
    return `${value.value}${value.unit}`;
  }
  if (type === "cubicBezier" && Array.isArray(value) && value.length === 4) {
    return `cubic-bezier(${value.join(", ")})`;
  }
  return undefined;
}
