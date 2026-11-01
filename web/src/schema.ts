// Helpers for the schemas of the tool parameters.

import { Type } from "@earendil-works/pi-ai";

/** A schema for one of the names. Type.Unsafe keeps the names in the TypeScript type. */
export const literals = <T extends string>(names: readonly T[], options?: { description?: string }) =>
	Type.Unsafe<T>(Type.Union(names.map((name) => Type.Literal(name)), options));
