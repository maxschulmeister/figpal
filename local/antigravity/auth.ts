import { randomUUID } from "node:crypto";

/**
 * The credential that FigPal's UI keeps for Antigravity: a marker, not a secret. The server keeps the Google login
 * itself (launch.ts), so the browser never sees a Google token.
 */
const MARKER = "figpal-antigravity:managed-by-antigravity";

export function newGoogleLoginMarker(): string {
	return `${MARKER}:${randomUUID()}`;
}

export function isGoogleLoginMarker(value: string): boolean {
	return value.startsWith(`${MARKER}:`);
}
