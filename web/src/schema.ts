// Helpers for the schemas of the tool parameters.

import { StringEnum } from "@earendil-works/pi-ai";

/** IDs in Figma links have dashes: "1-2" is the node "1:2". Real node IDs have no dashes. */
export const nodeIdOf = (id: string) => id.replaceAll("-", ":");

/** A schema for one of the names: a JSON Schema enum, a third of the size of a union of literals for the model. */
export const literals = <T extends string>(names: readonly T[], options?: { description?: string }) => StringEnum(names, options);
