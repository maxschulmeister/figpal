// Helpers for the schemas of the tool parameters.

import { Type } from "@earendil-works/pi-ai";

/** IDs in Figma links have dashes: "1-2" is the node "1:2". Real node IDs have no dashes. */
export const nodeIdOf = (id: string) => id.replaceAll("-", ":");

/** A schema for one of the names. Type.Unsafe keeps the names in the TypeScript type. */
export const literals = <T extends string>(names: readonly T[], options?: { description?: string }) =>
	Type.Unsafe<T>(Type.Union(names.map((name) => Type.Literal(name)), options));
