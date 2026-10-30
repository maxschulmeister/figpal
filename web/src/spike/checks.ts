// Spike checks that do not need the agent.

import { type FileInfo, THEME_HASH_KEY } from "@figpal/shared";
import type { Bridge } from "../bridge";
import { addVisit, all, record } from "./results";
import { errorText } from "./ui";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(action: () => Promise<string>): Promise<{ ok: boolean; text: string }> {
	try {
		return { ok: true, text: await action() };
	} catch (error) {
		return { ok: false, text: errorText(error) };
	}
}

const RESTART_MARK = "Restart mark set";

/** Before a restart of Figma: the next page load finds this result if IndexedDB keeps its data. */
export async function markRestart(): Promise<void> {
	await record("0.1 restart", "todo", `${RESTART_MARK}. Quit Figma, start it again, and run FigPal.`);
}

export async function checkIndexedDb(): Promise<string> {
	const visits = await addVisit();
	const persisted = await navigator.storage?.persist?.().catch(() => false);
	const mark = (await all()).find((result) => result.id === "0.1 restart");
	const detail = `${visits.length} visits since ${visits[0]?.at}. persist(): ${persisted}.`;
	if (mark?.status === "todo" && mark.detail.startsWith(RESTART_MARK))
		await record("0.1 restart", "pass", `The restart mark from ${mark.at} is still there. ${detail}`);
	return detail;
}

export async function checkNetwork(): Promise<void> {
	const violations: string[] = [];
	const onViolation = (event: SecurityPolicyViolationEvent) =>
		violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
	document.addEventListener("securitypolicyviolation", onViolation);
	const own = await attempt(async () => `${(await fetch(location.origin + "/", { cache: "no-store" })).status}`);
	const anthropic = await attempt(
		async () =>
			`${
				(
					await fetch("https://api.anthropic.com/v1/models", {
						headers: { "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
					})
				).status
			}`,
	);
	// no-cors: only a CSP block can make this fail.
	const unlisted = await attempt(async () => `${(await fetch("https://example.com/", { mode: "no-cors" })).type}`);
	await sleep(200);
	document.removeEventListener("securitypolicyviolation", onViolation);
	const pass = own.ok && anthropic.ok && !unlisted.ok;
	await record(
		"0.2",
		pass ? "pass" : "info",
		`own origin: ${own.text}; api.anthropic.com: ${anthropic.text}; example.com (not listed): ${unlisted.ok ? `not blocked (${unlisted.text})` : `blocked (${unlisted.text})`}; CSP violations: ${violations.join(", ") || "none"}`,
	);
}

const SAMPLE = `const frame = figma.createFrame();
frame.name = "FigPal spike card";
frame.layoutMode = "VERTICAL";
frame.primaryAxisSizingMode = "AUTO";
frame.counterAxisSizingMode = "AUTO";
frame.paddingTop = frame.paddingBottom = frame.paddingLeft = frame.paddingRight = 16;
frame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
const text = figma.createText();
text.characters = "Hello from figma_execute";
frame.appendChild(text);
figma.viewport.scrollAndZoomIntoView([frame]);
return frame;`;

export const EXECUTE_SAMPLE = SAMPLE;

export async function checkExecute(bridge: Bridge): Promise<string> {
	const run = (code: string, timeoutMs?: number) =>
		attempt(async () => JSON.stringify((await bridge.request("execute", { code, timeoutMs })).result));
	const sample = await run(SAMPLE);
	const limit = await run("return 'x'.repeat(50000);");
	const syntax = await run("return (;");
	const optionalChaining = await run("return figma.currentPage?.name ?? null;");
	// Last: after a timeout, canvas calls fail until the old code ends (after 3 more seconds here).
	const timeout = await run("await new Promise((r) => setTimeout(r, 4000)); return 'late';", 1000);
	const blocked = await run("return 1;");
	await sleep(3500);
	const unblocked = await run("return 2;");
	const pass =
		sample.ok &&
		limit.ok &&
		/"truncated":true/.test(limit.text) &&
		!syntax.ok &&
		/Timed out/.test(timeout.text) &&
		/still runs/.test(blocked.text) &&
		unblocked.ok;
	const detail = `sample: ${sample.text.slice(0, 120)}; limit: ${limit.text.slice(-80)}; syntax error: ${syntax.text}; ?. and ??: ${optionalChaining.text}; timeout: ${timeout.text}; call during the late run: ${blocked.text}; call after it: ${unblocked.text}`;
	await record("0.6", pass ? "pass" : "fail", detail);
	return detail;
}

const NO_CORS_IMAGE = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";
const CORS_IMAGE = "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png";
const UNLISTED_IMAGE = "https://placehold.co/600x400.png";

export async function checkImages(bridge: Bridge): Promise<void> {
	const create = (params: { url?: string; bytes?: Uint8Array }) =>
		attempt(async () => (await bridge.request("create-image", params)).result.nodeId);
	const noCors = await create({ url: NO_CORS_IMAGE });
	const cors = await create({ url: CORS_IMAGE });
	const unlisted = await create({ url: UNLISTED_IMAGE });
	const uiNoCors = await attempt(async () => `${(await fetch(NO_CORS_IMAGE)).status}`);
	const bytes = await attempt(async () => {
		const data = new Uint8Array(await (await fetch(CORS_IMAGE)).arrayBuffer());
		return (await bridge.request("create-image", { bytes: data })).result.nodeId;
	});
	await record(
		"0.9",
		noCors.ok ? "pass" : "fail",
		`createImageAsync no-CORS host: ${noCors.text}; CORS host: ${cors.text}; host not in allowedDomains: ${unlisted.text}; UI fetch of no-CORS host: ${uiNoCors.text}; UI bytes → createImage: ${bytes.text}`,
	);
}

export async function checkFileKey(file: FileInfo | undefined): Promise<void> {
	if (!file) return;
	await record(
		"0.10",
		file.fileKey ? "pass" : "fail",
		`fileKey: ${file.fileKey ?? "null"}; fileId: ${file.fileId}; editor: ${file.editorType}`,
	);
}

export async function checkHidden(bridge: Bridge): Promise<string> {
	let ticks = 0;
	const timer = setInterval(() => ticks++, 500);
	const visibility: string[] = [];
	const onVisibility = () => visibility.push(document.visibilityState);
	document.addEventListener("visibilitychange", onVisibility);
	await bridge.request("hide", { ms: 10_000 });
	await sleep(5_000);
	const fetchWhileHidden = await attempt(async () => `${(await fetch(location.origin + "/", { cache: "no-store" })).status}`);
	await sleep(6_000);
	clearInterval(timer);
	document.removeEventListener("visibilitychange", onVisibility);
	const detail = `${ticks} of 22 timer ticks in 11 s (Chromium can slow timers in a hidden frame to about 1 per second); fetch while hidden: ${fetchWhileHidden.text}; visibility changes: ${visibility.join(", ") || "none"}`;
	// The page must keep running, also slower: at least 5 ticks and a working fetch.
	await record("0.11", ticks >= 5 && fetchWhileHidden.ok ? "pass" : "fail", detail);
	return detail;
}

export async function checkHosting(file: FileInfo | undefined): Promise<void> {
	if (location.hostname !== "figpal.maxschulmeister.dev") return;
	if (file) await record("0.13", "pass", "Figma Desktop loaded the hosted page and code.js answered.");
	// Caddy sends the header only with ?csp=1 (see the "0.12" button).
	if (!new URLSearchParams(location.search).has("csp")) return;
	const response = await fetch(location.href, { cache: "no-store" });
	const csp = response.headers.get("content-security-policy");
	await record(
		"0.12",
		file && csp?.includes("frame-ancestors") ? "pass" : "fail",
		`Content-Security-Policy: ${csp ?? "none"}; loaded in Figma: ${Boolean(file)}. If the page stays blank after the click, the header blocks it.`,
	);
}

export async function checkSkills(): Promise<void> {
	const json = async (url: string) => {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`${response.status}`);
		return response.json();
	};
	const direct = await attempt(async () => `${(await json("https://skills.sh/api/search?q=figma")).skills?.length} results`);
	const route = await attempt(async () => `${(await json("/api/skills/search?q=figma")).skills?.length} results`);
	const download = await attempt(
		async () => `${(await json("/api/skills/download/figma/mcp-server-guide/figma-use")).files?.length} files`,
	);
	let skillPath = "";
	const tree = await attempt(async () => {
		const response = await fetch("https://api.github.com/repos/figma/mcp-server-guide/git/trees/HEAD?recursive=1");
		const data = (await response.json()) as { tree?: { path: string }[] };
		const skills = (data.tree ?? []).filter((item) => item.path.endsWith("SKILL.md"));
		skillPath = skills.find((item) => item.path.endsWith("figma-use/SKILL.md"))?.path ?? "";
		return `${skills.length} SKILL.md files, rate limit left: ${response.headers.get("x-ratelimit-remaining")}`;
	});
	const raw = await attempt(async () => {
		const response = await fetch(`https://raw.githubusercontent.com/figma/mcp-server-guide/HEAD/${skillPath}`);
		if (!response.ok) throw new Error(`${response.status}`);
		return `${(await response.text()).length} characters`;
	});
	await record(
		"0.15",
		!direct.ok && route.ok && download.ok && tree.ok && raw.ok ? "pass" : "info",
		`direct search: ${direct.text}; route search: ${route.text}; route download: ${download.text}; GitHub tree: ${tree.text}; raw ${skillPath}: ${raw.text}`,
	);
}

export async function checkTheme(): Promise<void> {
	const style = getComputedStyle(document.documentElement);
	const bg = style.getPropertyValue("--figma-color-bg").trim();
	// code.js adds the class of the first (null-origin) document, which has the theme variables, to the hash.
	const passed = new URLSearchParams(location.hash.slice(1)).get(THEME_HASH_KEY);
	await record(
		"0.16",
		bg || passed?.includes("figma-") ? "pass" : "fail",
		`--figma-color-bg: "${bg}"; html class: "${document.documentElement.className}"; class passed in the hash: "${passed ?? "none"}"; prefers-color-scheme dark: ${matchMedia("(prefers-color-scheme: dark)").matches}`,
	);
}

/** Facts about the frame, for the results. */
export function environment(): string {
	return [
		`origin ${location.origin}`,
		`in iframe ${window.parent !== window}`,
		`ancestorOrigins ${Array.from(location.ancestorOrigins ?? []).join(", ") || "none"}`,
		`secure ${isSecureContext}`,
		`locks ${"locks" in navigator}`,
		navigator.userAgent,
	].join(" · ");
}
