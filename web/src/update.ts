// Updates of the FigPal command: the UI compares the running version with the latest version on npm. Update asks the
// command to start the update (local/install.ts).

import { UPDATE_ROUTE } from "@figpal/shared/routes";

/** npm allows browser requests here (CORS). */
const LATEST_URL = "https://registry.npmjs.org/figpal/latest";
/** The version whose notice the user closed. */
export const CLOSED_KEY = "figpal.update-closed";

/** While the install stops the command, a request can get no answer. */
const TIMEOUT_MS = 5000;

const version = (url: string) =>
	fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) })
		.then((response) => response.json())
		.then((value: { version?: unknown } | null) => (typeof value?.version === "string" ? value.version : undefined))
		// Offline, or no FigPal command: Vite's dev server has no /health.
		.catch(() => undefined);

/** The version of the FigPal command that serves the UI. */
export const runningVersion = () => version("/health");
export const latestVersion = () => version(LATEST_URL);

/** Asks the FigPal command to start the update. `started: false`: the user must run the command (Linux). */
export async function startUpdate(): Promise<{ started: boolean }> {
	const response = await fetch(UPDATE_ROUTE, { method: "POST" });
	if (!response.ok) throw new Error(await response.text());
	const { started } = (await response.json()) as { started?: unknown };
	return { started: started === true };
}

/** The numbers of a release version "1.2.3", or undefined (for example "dev", or a pre-release). */
const parts = (version: string) => (/^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : undefined);

/** The latest version when it is newer than the running one, and the user did not close its notice. */
export function updateVersion(running: string, latest: string, closed?: string): string | undefined {
	const [have, next] = [parts(running), parts(latest)];
	if (!have || !next || latest === closed) return undefined;
	const difference = next.map((part, index) => part - have[index]!).find((part) => part !== 0) ?? 0;
	return difference > 0 ? latest : undefined;
}
