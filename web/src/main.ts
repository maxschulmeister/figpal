// Phase 0 spike page. It runs in the plugin iframe (hosted or local) and records the results of the checks.

import "./style.css";
import { type Api, contentText, type Model } from "@earendil-works/pi-ai";
import type { FileInfo } from "@figpal/shared";
import { createBridge } from "./bridge";
import { type Agent, abort, describeView, openAgent, PROVIDERS, type ProviderId, requestSettings, send, setModel } from "./spike/agent";
import { type ApiLogin, codexDeviceLogin, finishApiLogin, startApiLogin } from "./spike/chatgpt";
import {
	checkExecute,
	checkFileKey,
	checkHidden,
	checkHosting,
	checkImages,
	checkIndexedDb,
	checkNetwork,
	checkSkills,
	checkTheme,
	EXECUTE_SAMPLE,
	environment,
} from "./spike/checks";
import { record, resultsView } from "./spike/results";
import { button, errorText, h, log, logView, row, section } from "./spike/ui";

const bridge = createBridge();
const inFigma = window.parent !== window;
const app = document.querySelector<HTMLDivElement>("#app")!;

const fileLine = h("p", { className: "muted" }, inFigma ? "Waiting for code.js…" : "Not in Figma. Only browser checks work.");
const envLine = h("p", { className: "muted small" });
const transcript = h("pre", { className: "transcript" });
const agentStatus = h("p", { className: "muted" }, "Agent: not open");

let file: FileInfo | undefined;
let agent: Agent | undefined;
let resumeState = "";

function renderFile(): void {
	if (!file) return;
	fileLine.textContent = `${file.fileName} · page ${file.page.name} · ${file.selection.length} selected · fileId ${file.fileId} · fileKey ${file.fileKey ?? "none"}`;
}

bridge.onEvent((event) => {
	if (event.type === "init") file = event.file;
	else if (event.type === "selection" && file) file = { ...file, selection: event.selection };
	else if (event.type === "page" && file) file = { ...file, page: event.page };
	renderFile();
});

/** Waits for the `init` event from code.js. */
function waitForInit(timeoutMs: number): Promise<FileInfo | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), timeoutMs);
		const stop = bridge.onEvent((event) => {
			if (event.type !== "init") return;
			clearTimeout(timer);
			stop();
			resolve(event.file);
		});
		bridge.ready();
	});
}

// --- Secrets in clientStorage. Without code.js, they stay in memory only. ---

async function loadSecret(name: string): Promise<string | undefined> {
	if (!file) return undefined;
	const { result } = await bridge.request("storage-get", { key: `figpal.spike.${name}` });
	return typeof result === "string" ? result : undefined;
}

async function saveSecret(name: string, value: string): Promise<void> {
	if (!file) {
		log(`code.js is not connected: ${name} is kept in memory only.`);
		return;
	}
	await bridge.request("storage-set", { key: `figpal.spike.${name}`, value });
}

// --- Models ---

const modelSelect = h("select");

function selectedModel(): { provider: ProviderId; modelId: string } {
	const [provider, ...rest] = modelSelect.value.split("/");
	return { provider: provider as ProviderId, modelId: rest.join("/") };
}

function fillModels(): void {
	if (!agent) return;
	for (const provider of PROVIDERS) {
		const group = h("optgroup", { label: provider });
		for (const model of agent.models.getModels(provider))
			group.append(h("option", { value: `${provider}/${model.id}` }, model.id));
		modelSelect.append(group);
	}
	modelSelect.value = "anthropic/claude-sonnet-5-5";
	modelSelect.onchange = () => void setModel(agent!, selectedModel().provider, selectedModel().modelId);
}

/** One short streamed request through the same model wrapper as the agent. */
/** For a quick test of a provider that is not selected. A ChatGPT login does not accept older models such as gpt-4. */
const TEST_MODELS: Record<ProviderId, string> = {
	anthropic: "claude-sonnet-5-5",
	openai: "gpt-5.6-luna",
	"openai-codex": "gpt-5.6-luna",
	faux: "script",
};

/** A key without its secret part, for diagnostics: "sk-ant-oat01-…(108 characters)". */
function maskKey(key: string | undefined): string {
	return key ? `${key.slice(0, 13)}…(${key.length} characters)` : "none";
}

async function quickTest(provider: ProviderId, modelId?: string): Promise<string> {
	if (!agent) throw new Error("Agent is not open");
	const chosen = selectedModel();
	const id = modelId ?? (chosen.provider === provider ? chosen.modelId : TEST_MODELS[provider]);
	const model = agent.models.getModel(provider, id ?? "") as Model<Api> | undefined;
	if (!model) throw new Error(`No model ${provider}/${id}`);
	const stream = agent.models.streamSimple(model, {
		messages: [{ role: "user", content: "Say hello in five words.", timestamp: Date.now() }],
	});
	let deltas = 0;
	for await (const event of stream) if (event.type === "text_delta") deltas++;
	const message = await stream.result();
	if (message.stopReason === "error") throw new Error(message.errorMessage);
	const text = contentText(message.content, "");
	return `${provider}/${model.id}: "${text}" (${deltas} text deltas)`;
}

async function searchTest(): Promise<void> {
	if (!agent) throw new Error("Agent is not open");
	const { provider, modelId } = selectedModel();
	const model = agent.models.getModel(provider, modelId) as Model<Api>;
	requestSettings.nativeSearch = true;
	try {
		const stream = agent.models.streamSimple(model, {
			messages: [
				{
					role: "user",
					content: "Use web search: what is the newest stable version of Vite? Answer in one sentence and name the source URL.",
					timestamp: Date.now(),
				},
			],
		});
		const message = await stream.result();
		const text = contentText(message.content, "");
		const types = message.content.map((block) => block.type).join(", ");
		await record(
			`0.8 ${provider}`,
			message.stopReason !== "error" && text.length > 0 ? "pass" : "fail",
			`${provider}/${modelId} stop: ${message.stopReason}; blocks: ${types}; text: ${text.slice(0, 300)}${message.errorMessage ? `; error: ${message.errorMessage}` : ""}`,
		);
	} finally {
		requestSettings.nativeSearch = false;
	}
}

// --- Sections ---

const tokenInput = h("input", { type: "password", placeholder: "sk-ant-oat01-… from claude setup-token" });
const promptInput = h("textarea", { rows: 3, placeholder: "Message" });
const RESUME_PROMPT =
	"Call figma_execute once with timeout_ms 60000 and this code: await new Promise((r) => setTimeout(r, 30000)); return 'done'; Then tell me the result.";

const agentSection = section(
	"0.3 · 0.5 · 0.7",
	"Agent (Claude setup-token, pi-durable, resume)",
	row(tokenInput, button("Save token", async () => {
		// A token copied from a terminal can contain line breaks. Tokens never contain white space.
		const token = tokenInput.value.replace(/\s+/g, "");
		await saveSecret("anthropic", token);
		requestSettings.keys.anthropic = token;
		tokenInput.value = "";
		log(`Claude token saved: ${maskKey(token)}`);
	})),
	row(modelSelect, button("Quick test", async () => {
		const { provider } = selectedModel();
		const result = await quickTest(provider).catch(async (error) => {
			if (provider === "anthropic")
				await record("0.3", "fail", `${errorText(error)} Key: ${maskKey(requestSettings.keys.anthropic)}`);
			throw error;
		});
		if (provider === "anthropic") await record("0.3", "pass", result);
		log(result);
	})),
	promptInput,
	row(
		button("Send", async () => {
			if (!agent) throw new Error("Agent is not open");
			const text = promptInput.value.trim();
			if (!text) return;
			promptInput.value = "";
			const result = await send(agent, text);
			log(`Run ${result.status}: ${result.detail}`);
		}),
		button("Resume test", () => {
			promptInput.value = RESUME_PROMPT;
			log("Send it. When the tool runs, close the plugin. Open it again: the run continues with an interrupted result.");
		}),
		button("Abort", async () => agent && abort(agent)),
	),
	agentStatus,
	transcript,
);

const loginInfo = h("p", { className: "muted" });
const pasteInput = h("input", { type: "text", placeholder: "Paste the http://127.0.0.1:1455/auth/callback?… URL" });
let apiLogin: ApiLogin | undefined;

async function deviceId(): Promise<string> {
	const stored = await loadSecret("deviceId");
	if (stored) return stored;
	const id = crypto.randomUUID();
	await saveSecret("deviceId", id);
	return id;
}

const chatgptSection = section(
	"0.4",
	"ChatGPT",
	h("p", { className: "muted" }, "A: Codex device code (chatgpt.com). B: Sign in with ChatGPT (api.openai.com, newer pi-ai flow)."),
	row(
		button("A: Device login", async () => {
			const controller = new AbortController();
			const token = await codexDeviceLogin((code, url) => {
				loginInfo.textContent = `Enter code ${code} at ${url}`;
				void bridge.request("open-external", { url });
			}, controller.signal);
			await saveSecret("openai-codex", token.access);
			requestSettings.keys["openai-codex"] = token.access;
			loginInfo.textContent = "Codex login done.";
			await record("0.4 device-login", "pass", "Device code login worked from the iframe.");
		}),
		button("A: Test direct", async () => {
			requestSettings.codexBaseUrl = undefined;
			const result = await quickTest("openai-codex").catch(async (error) => {
				await record("0.4 codex-direct", "fail", errorText(error));
				throw error;
			});
			await record("0.4 codex-direct", "pass", result);
		}),
		button("A: Test route", async () => {
			requestSettings.codexBaseUrl = `${location.origin}/api/chatgpt/backend-api`;
			const result = await quickTest("openai-codex").catch(async (error) => {
				await record("0.4 codex-route", "fail", errorText(error));
				throw error;
			});
			await record("0.4 codex-route", "pass", result);
		}),
	),
	row(
		button("B: Sign in", async () => {
			apiLogin = await startApiLogin(await deviceId());
			loginInfo.textContent = "Log in. Then copy the URL of the page that does not load and paste it here.";
			await bridge.request("open-external", { url: apiLogin.url });
		}),
		pasteInput,
		button("B: Finish", async () => {
			if (!apiLogin) throw new Error("Click B: Sign in first");
			const token = await finishApiLogin(apiLogin, pasteInput.value);
			await saveSecret("openai", token.access);
			requestSettings.keys.openai = token.access;
			pasteInput.value = "";
			loginInfo.textContent = "ChatGPT (API) login done.";
			await record("0.4 api-login", "pass", `Sign in with ChatGPT worked. Client ID ${token.clientId}.`);
		}),
		button("B: Test", async () => {
			const result = await quickTest("openai").catch(async (error) => {
				await record("0.4 api-call", "fail", errorText(error));
				throw error;
			});
			await record("0.4 api-call", "pass", result);
		}),
	),
	loginInfo,
);

const codeInput = h("textarea", { rows: 8, value: EXECUTE_SAMPLE });
const executeOutput = h("pre", { className: "small" });

const executeSection = section(
	"0.6",
	"Execute",
	codeInput,
	row(
		button("Run", async () => {
			const { result, attachments } = await bridge.request("execute", { code: codeInput.value });
			executeOutput.textContent = `${result.value}${result.truncated ? "\n(truncated)" : ""}\n${attachments.length} attachments`;
		}),
		button("Run all checks", async () => log(await checkExecute(bridge))),
	),
	executeOutput,
);

const otherSection = section(
	"0.2 · 0.8 · 0.9 · 0.11 · 0.12 · 0.15",
	"More checks",
	row(
		button("0.2 Network", () => checkNetwork()),
		button("0.8 Search (selected model)", () => searchTest()),
		button("0.9 Images", () => checkImages(bridge)),
	),
	row(
		button("0.11 Hide for 10 s", async () => log(await checkHidden(bridge))),
		button("0.15 Skills", () => checkSkills()),
		button("0.12 Reload with frame-ancestors", () => {
			location.href = "/?csp=1";
		}),
	),
);

app.append(
	h("header", {}, h("h1", {}, "FigPal spike"), fileLine, envLine),
	section("", "Results", resultsView()),
	agentSection,
	chatgptSection,
	executeSection,
	otherSection,
	section("", "Log", logView()),
);

// --- Start ---

async function start(): Promise<void> {
	// First, so that code.js stops its load timer.
	file = inFigma ? await waitForInit(5000) : undefined;
	renderFile();
	envLine.textContent = environment(bridge);
	if (inFigma)
		await record("0.0", file ? "pass" : "fail", `init from code.js: ${Boolean(file)}. ${envLine.textContent}`);
	log(await checkIndexedDb());
	await checkTheme();
	await checkFileKey(file);
	await checkHosting(file);

	for (const provider of PROVIDERS) {
		const key = await loadSecret(provider);
		if (key) requestSettings.keys[provider] = key;
	}
	const opened = await openAgent(file?.fileId ?? "browser", bridge, (view) => {
		const described = describeView(view);
		transcript.textContent = described.lines.join("\n\n") || "(empty)";
		agentStatus.textContent = `Agent: ${described.busy ? "running" : "idle"}`;
		const state = described.interrupted ? `${described.continuedAfter}` : "";
		if (state && state !== resumeState)
			void record(
				"0.7",
				described.continuedAfter ? "pass" : "todo",
				`Interrupted tool result found. Run continued after it: ${described.continuedAfter}.`,
			);
		resumeState = state;
	});
	if (opened === "locked") {
		agentStatus.textContent = "Agent: the storage of this file is open in another window.";
		return;
	}
	agent = opened;
	fillModels();
	agentStatus.textContent = "Agent: idle";
}

start().catch((error) => log(`Start failed: ${errorText(error)}`));
