// The browser checks: FigPal's UI in Chrome, inside a fake Figma page, with a mocked model. The fake page sends the
// code.js requests to Node, where each check answers them.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Frame, type Page } from "playwright-core";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PARENT_URL = "https://www.figma.com/figpal-e2e";
/** Screenshots for a look by hand. */
export const SCREENSHOTS = join(tmpdir(), "figpal-e2e");

export type File = { name: string; mime: string; bytes: Uint8Array };
export type Reply = { result?: unknown; attachments?: File[] };
// biome-ignore lint/suspicious/noExplicitAny: each check knows the parameters of its requests.
export type Handler = (params: any, session: Session) => Reply | Promise<Reply>;
/** The body of a request to the Anthropic API. */
// biome-ignore lint/suspicious/noExplicitAny: the checks read only some fields.
export type ModelRequest = { tools?: { name: string }[]; messages: { role: string; content: any }[] };
export type Node = { id: string; name: string; type: string };

export type Options = {
	/** The code.js requests of the check. Storage and open-external have defaults. */
	requests?: Record<string, Handler>;
	/** Gives the answer of the model, as server-sent events. Default: the text "Done.". */
	model?: (request: ModelRequest) => string | Promise<string>;
	/**
	 * Gives the name of a chat (the request of the text generation model after the first answer). These requests are
	 * not in `session.model`. Default: the text "Test chat".
	 */
	naming?: (request: ModelRequest) => string;
	/** A strip under the panel: a click there takes the focus from the panel, as a click on Figma's canvas does. */
	canvas?: boolean;
	/** Before the page loads, for example more routes. */
	setup?: (page: Page) => Promise<unknown>;
};

const sse = (events: object[]) => events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const start = {
	type: "message_start",
	message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
};
const end = (reason: string) => [
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } },
	{ type: "message_stop" },
];

/** A model answer that calls a tool. */
export const toolUse = (id: string, name: string, input: object) =>
	sse([
		start,
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
		...end("tool_use"),
	]);

/** A model answer with text. */
export const text = (value: string) =>
	sse([
		start,
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
		...end("end_turn"),
	]);

// biome-ignore lint/suspicious/noExplicitAny: a tool result block of the Anthropic API.
export type ToolResult = { content: string | any[] };
/** The tool results in a request, oldest first. */
export const toolResults = (request: ModelRequest): ToolResult[] =>
	request.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result");
export const resultText = (result: ToolResult) =>
	Array.isArray(result.content) ? result.content.map((block: { text?: string }) => block.text ?? "").join("") : result.content;

/** A fake Figma page: the panel, and the file's events. */
function parent(ui: string, dark: boolean, canvas: boolean): string {
	return `<!doctype html><body style="margin:0">
<iframe id="f" src="${ui}/#figma-theme=${dark ? "figma-dark" : "figma-light"}" style="width:420px;height:${canvas ? 600 : 680}px;border:0"></iframe>
${canvas ? '<div id="canvas" style="height:60px;background:#eee">canvas</div>' : ""}
<script>
const frame = document.getElementById("f");
const bytes = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
window.__post = (message) => frame.contentWindow.postMessage({ pluginMessage: message, pluginId: window.__pluginId }, "*");
window.addEventListener("message", async (event) => {
	if (event.source !== frame.contentWindow) return;
	const { pluginMessage: m, pluginId } = event.data || {};
	window.__pluginId = pluginId;
	if (m.kind === "ready") window.__post({ kind: "event", type: "init", file: ${JSON.stringify({
		fileId: `e2e-${Date.now()}`,
		fileKey: "KEY1",
		fileName: "E2E",
		editorType: "figma",
		page: { id: "0:1", name: "Page 1", type: "PAGE" },
		selection: [{ id: "1:2", name: "Card", type: "FRAME" }],
		selectionCount: 1,
	})} });
	if (m.kind !== "request") return;
	const reply = JSON.parse(await window.figpalRequest(m.type, JSON.stringify(m.params ?? null)));
	if (reply.error !== undefined) return window.__post({ kind: "response", id: m.id, ok: false, error: reply.error });
	const attachments = reply.attachments.map((file) => ({ ...file, bytes: bytes(file.bytes) }));
	window.__post({ kind: "response", id: m.id, ok: true, result: reply.result ?? null, attachments });
});
</script></body>`;
}

export class Session {
	readonly page: Page;
	readonly ui: string;
	/** The code.js requests, oldest first. */
	readonly requests: { type: string; params: unknown }[] = [];
	/** The requests to the model, oldest first. */
	readonly model: ModelRequest[] = [];
	/** Errors and warnings of the browser console: some are expected, for example a failed request that a check makes. */
	readonly errors: string[] = [];
	/** Uncaught errors of the page: a check fails with them. */
	readonly pageErrors: string[] = [];
	#frame: Frame | undefined;

	constructor(page: Page, ui: string) {
		this.page = page;
		this.ui = ui;
	}

	/** Waits until FigPal's UI shows, after a start or a restart. */
	async ready() {
		await this.page.frameLocator("#f").locator("#app > *").first().waitFor({ timeout: 30_000 });
		this.#frame = undefined;
	}

	/** FigPal's UI. It changes after a restart. */
	get frame(): Frame {
		this.#frame ??= this.page.frames().find((frame) => frame.url().startsWith(this.ui));
		if (!this.#frame) throw new Error("The FigPal UI did not load.");
		return this.#frame;
	}

	/** Sends a code.js event to the UI. */
	post(message: object): Promise<void> {
		return this.page.evaluate((value) => (window as unknown as { __post(m: object): void }).__post(value), message);
	}

	/** A selection in Figma: the user clicks the canvas, so the panel loses the focus. Needs `canvas`. */
	async select(nodes: Node[], { page = { id: "0:1", name: "Home", type: "PAGE" }, byAgent = false, count = nodes.length } = {}) {
		await this.page.click("#canvas");
		await this.post({ kind: "event", type: "selection", selection: nodes, selectionCount: count, page, byAgent });
		await this.page.waitForTimeout(250);
	}

	/** The text of the message box. A chip is "[name]", "[name*]" when it is the active chip. */
	composer(): Promise<string> {
		return this.frame.locator('[contenteditable="true"]').evaluate((root) => {
			const parts: string[] = [];
			const walk = (element: Element) => {
				for (const child of element.childNodes) {
					if (child.nodeType === 3) parts.push(child.textContent ?? "");
					else if ((child as Element).getAttribute?.("contenteditable") === "false")
						parts.push(`[${child.textContent}${(child as Element).hasAttribute("data-active") ? "*" : ""}]`);
					else walk(child as Element);
				}
			};
			walk(root);
			return parts.join("").replace(/\u200b|\ufeff/g, "");
		});
	}

	/** Saves a Claude token, so that the chat shows. */
	async login() {
		await this.frame.getByLabel("Claude token").fill("sk-ant-oat01-test");
		await this.frame.getByRole("button", { name: "Save" }).click();
		await this.page.waitForTimeout(800);
	}

	/** Sends a message and waits for the text of the last answer. */
	async ask(message: string, until: string) {
		await this.frame.getByRole("textbox", { name: "Ask FigPal" }).click();
		await this.page.keyboard.type(message);
		await this.page.keyboard.press("Enter");
		await this.frame.getByText(until).first().waitFor({ timeout: 30_000 });
	}

	/** The text of the UI, with " | " between the lines. */
	async body(): Promise<string> {
		// biome-ignore lint/performance/useDomNodeTextContent: the checks need the text as shown, with its lines.
		return (await this.frame.locator("body").innerText()).replace(/\n+/g, " | ");
	}

	/** Loads the UI again, as a new start of the plugin: the files in memory are gone. */
	async restart() {
		await this.page.evaluate(async () => {
			const frame = document.getElementById("f") as HTMLIFrameElement;
			const src = frame.src;
			frame.src = "about:blank";
			await new Promise((resolve) => setTimeout(resolve, 300));
			frame.src = src;
		});
		await this.ready();
		// The conversation loads after the UI.
		await this.frame.getByRole("textbox", { name: "Ask FigPal" }).waitFor({ timeout: 30_000 });
	}
}

export type Check = (name: string, ok: boolean, detail?: string) => void;

/** One check file. It opens sessions and reports each check. */
export class Context {
	readonly ui: string;
	readonly dark: boolean;
	failures = 0;
	readonly #browsers: Browser[] = [];
	readonly #sessions: Session[] = [];

	constructor(ui: string, dark: boolean) {
		this.ui = ui;
		this.dark = dark;
	}

	check: Check = (name, ok, detail = "") => {
		if (!ok) this.failures++;
		console.log(`  ${ok ? "✓" : "✗"} ${name}${detail && !ok ? `: ${detail}` : ""}`);
	};

	/** Opens FigPal in a new browser, so each session has empty storage. */
	async open(options: Options = {}): Promise<Session> {
		const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--disable-features=LocalNetworkAccessChecks"] });
		this.#browsers.push(browser);
		const page = await browser.newPage({ viewport: { width: 420, height: 680 } });
		const session = new Session(page, this.ui);
		this.#sessions.push(session);
		page.on("console", (message) => {
			if (message.type() === "error" || message.type() === "warning") session.errors.push(`${message.type()}: ${message.text().slice(0, 200)}`);
		});
		page.on("pageerror", (error) => session.pageErrors.push(error.message));
		const storage = new Map<string, unknown>();
		const handlers: Record<string, Handler> = {
			"storage-get": ({ key }) => ({ result: storage.get(key) ?? null }),
			"storage-set": ({ key, value }) => {
				storage.set(key, value);
				return {};
			},
			"storage-delete": ({ key }) => {
				storage.delete(key);
				return {};
			},
			"open-external": () => ({}),
			...options.requests,
		};
		await page.exposeFunction("figpalRequest", async (type: string, params: string) => {
			const parsed = JSON.parse(params);
			session.requests.push({ type, params: parsed });
			try {
				const handler = handlers[type];
				if (!handler) throw new Error(`The check does not answer the request "${type}".`);
				const { result, attachments = [] } = await handler(parsed, session);
				const files = attachments.map((file) => ({ ...file, bytes: Buffer.from(file.bytes).toString("base64") }));
				return JSON.stringify({ result, attachments: files });
			} catch (error) {
				return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
			}
		});
		// No calls to the internet: the checks must not depend on other servers, for example the default skills from
		// skills.sh and GitHub. The routes below, and the routes of `setup`, come first.
		await page.route("**/*", (route) => {
			const url = route.request().url();
			const own = (url.startsWith(this.ui) && !url.startsWith(`${this.ui}/api/`)) || url === PARENT_URL;
			return own ? route.continue() : route.abort("blockedbyclient");
		});
		const model = options.model ?? (() => text("Done."));
		await page.route(`${this.ui}/api/anthropic/**`, async (route) => {
			const request = JSON.parse(route.request().postData() ?? "{}") as ModelRequest;
			const system = (request as { system?: { text: string }[] }).system;
			if (system?.some((block) => block.text.startsWith("Name this chat"))) {
				const body = (options.naming ?? (() => text("Test chat")))(request);
				await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
				return;
			}
			session.model.push(request);
			await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: await model(request) });
		});
		await page.route(PARENT_URL, (route) => route.fulfill({ contentType: "text/html", body: parent(this.ui, this.dark, options.canvas ?? false) }));
		await options.setup?.(page);
		await page.goto(PARENT_URL);
		await session.ready();
		return session;
	}

	/** Saves a screenshot of the page in SCREENSHOTS. */
	async screenshot(session: Session, name: string) {
		mkdirSync(SCREENSHOTS, { recursive: true });
		await session.page.screenshot({ path: join(SCREENSHOTS, `${name}-${this.dark ? "dark" : "light"}.png`) });
	}

	/** Checks for uncaught page errors, shows the console errors after a failure, and closes the browsers. */
	async close() {
		for (const session of this.#sessions) {
			this.check("no uncaught errors in the page", session.pageErrors.length === 0, session.pageErrors.join(" | "));
			if (this.failures) for (const error of new Set(session.errors)) console.log(`  console: ${error}`);
		}
		await Promise.all(this.#browsers.map((browser) => browser.close()));
	}
}
