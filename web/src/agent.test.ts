import "fake-indexeddb/auto";
import { defaultDirectiveFormatter } from "@assistant-ui/react";
import { zstdDecompressSync } from "node:zlib";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type CredentialStore,
	InMemoryCredentialStore,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import type { Attachment, FileInfo } from "@figpal/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentModels, startAgent, userInput } from "./agent";
import { type FileDetails, fileById } from "./files";
import { chipItem } from "./node-chips";
import type { Bridge } from "./bridge";
import { currentThread } from "./threads";
import { toThread } from "./transcript";

function anthropicAnswer(): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function captureFetch() {
	const requests: { url: string; headers: Headers; body: { system: { text: string }[] } }[] = [];
	vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
		requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		return anthropicAnswer();
	}));
	return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("createAgentModels", () => {
	it("sends Claude requests with the saved token through the route of the page, as a server request", async () => {
		const requests = captureFetch();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-oat01-test" }));
		const models = createAgentModels(credentials, "https://figpal.example");
		const model = models.getModel("anthropic", "claude-sonnet-5-5")!;
		const result = await models.streamSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: 1 }] }).result();

		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		const { url, headers, body } = requests[0]!;
		expect(url).toMatch(/^https:\/\/figpal\.example\/api\/anthropic\/v1\/messages\b/);
		expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-test");
		// The route sets the user-agent from this header. Pi Black adds the billing block.
		expect(headers.get("x-figpal-user-agent")).toMatch(/^claude-cli\/2\.1\.280 /);
		expect(headers.get("x-stainless-runtime")).toBe("node");
		expect(body.system[0]!.text).toMatch(/^x-anthropic-billing-header: /);
	});

	it("offers each provider's own web search: Claude and ChatGPT", async () => {
		const bodies: { route: string; tools?: unknown[] }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input, init) => {
				const body = init?.body;
				// pi-ai compresses ChatGPT requests with zstd.
				const text = typeof body === "string" ? body : zstdDecompressSync(body as Uint8Array).toString();
				bodies.push({ route: new URL(String(input)).pathname.split("/")[2]!, ...JSON.parse(text) });
				return new Response("unavailable", { status: 503 });
			}),
		);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-oat01-test" }));
		const part = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
		const access = `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })}.sig`;
		await credentials.modify("openai-codex", async () => ({ type: "oauth", access, refresh: "r", expires: Date.now() + 3_600_000 }));
		const models = createAgentModels(credentials, "https://figpal.example");
		const messages = [{ role: "user" as const, content: "Hi", timestamp: 1 }];
		const agentRequest = { messages, tools: [{ name: "figma_execute", description: "Runs code.", parameters: Type.Object({}) }] };
		// Only the requests count: the answers are errors.
		const options = { maxRetries: 0 };
		const claude = models.getModel("anthropic", "claude-sonnet-5-5")!;
		await models.streamSimple(claude, agentRequest, options).result();
		await models.streamSimple(models.getModel("openai-codex", "gpt-6.1-sol")!, agentRequest, options).result();
		// A request without tools is a compaction summary: it must not search.
		await models.streamSimple(claude, { messages }, options).result();

		expect(bodies[0]).toMatchObject({ route: "anthropic" });
		expect(bodies[0]!.tools).toContainEqual({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
		expect(bodies[1]).toMatchObject({ route: "chatgpt" });
		expect(bodies[1]!.tools).toContainEqual({ type: "web_search" });
		expect(bodies[2]?.tools).toBeUndefined();
		// ChatGPT has the function tools in "input", so the check must not depend on the provider's request format.
		await models.streamSimple(models.getModel("openai-codex", "gpt-6.1-sol")!, { messages }, options).result();
		expect(bodies[3]?.tools).toBeUndefined();
	});
});


const FILE: FileInfo = {
	fileId: "KEY1",
	fileKey: "KEY1",
	fileName: "Test file",
	page: { id: "0:1", name: "Page 1", type: "PAGE" },
	selection: [{ id: "1:2", name: "Card", type: "FRAME" }],
	selectionCount: 1,
};

const SCRIPT = { model: { provider: "faux", modelId: "script" } };

/** The details of the first tool call, as the chat gets them. */
function toolArtifact(view: Parameters<typeof toThread>[0]) {
	for (const message of toThread(view).messages)
		for (const part of message.content as unknown as { type: string; artifact?: unknown }[])
			if (part.type === "tool-call") return part.artifact as FileDetails | undefined;
}

/** A scripted model: it calls the tool, then answers with the text of the tool result. */
function scriptedModels(toolName: string, args: Parameters<typeof fauxToolCall>[1]) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "script", input: ["text", "image"] }] });
	const requests: Message[][] = [];
	const step: FauxResponseFactory = (request) => {
		requests.push(request.messages);
		const last = request.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText("Done."));
		return fauxAssistantMessage(fauxToolCall(toolName, args), { stopReason: "toolUse" });
	};
	faux.setResponses([step, step]);
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, requests };
}

/** A fake code.js that answers one request type. */
function fakeBridge(reply: (params: unknown) => { result: unknown; attachments?: Attachment[] }) {
	const calls: { type: string; params: unknown }[] = [];
	const bridge = {
		async request(type: string, params: unknown) {
			calls.push({ type, params });
			return { attachments: [], ...reply(params) };
		},
	} as unknown as Pick<Bridge, "request">;
	return { bridge, calls };
}

/** The credential store with a Figma token. */
const FIGMA_TOKEN = {
	read: async (id: string) => (id === "figma" ? { type: "api_key" as const, key: "figd_test" } : undefined),
};

async function run(
	models: ReturnType<typeof createModels>,
	bridge: Pick<Bridge, "request">,
	text = "Check the card",
	credentials: Pick<CredentialStore, "read"> = FIGMA_TOKEN,
	fileKey: string | null = FILE.fileKey,
) {
	const harness = await startAgent(new MemoryStorage(), { models, bridge, credentials, fileKey, subagentModels: () => [] });
	const root = await currentThread(harness, SCRIPT);
	const submission = await root.submit(userInput(text, FILE), context);
	const settled = await submission.wait(context);
	const view = (await root.viewState(context)).value;
	await harness.close(context);
	return { settled, view };
}

describe("figma tools", () => {
	it("figma_screenshot gives the model the PNG of the node", async () => {
		const { models, requests } = scriptedModels("figma_screenshot", { node_id: "1:2" });
		const png = new Uint8Array([137, 80, 78, 71]);
		const { bridge, calls } = fakeBridge(() => ({
			result: { nodeId: "1:2", width: 200, height: 100 },
			attachments: [{ name: "Card.png", mime: "image/png", bytes: png }],
		}));
		const { settled } = await run(models, bridge);

		expect(settled.status).toBe("done");
		expect(calls).toEqual([{ type: "screenshot", params: { nodeId: "1:2" } }]);
		const result = requests[1]!.at(-1)!;
		expect(result).toMatchObject({
			role: "toolResult",
			isError: false,
			content: [
				{ type: "text", text: "Screenshot of 1:2 (200 × 100 px)." },
				{ type: "image", mimeType: "image/png", data: "iVBORw==" },
			],
		});
	});

	it("figma_execute runs the code in code.js and gives the model the value and the images", async () => {
		const { models, requests } = scriptedModels("figma_execute", { code: "return node.name", timeout_ms: 5000 });
		const { bridge, calls } = fakeBridge(() => ({
			result: { value: '"Card"' },
			attachments: [{ name: "a.png", mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }],
		}));
		await run(models, bridge);

		expect(calls).toEqual([{ type: "execute", params: { code: "return node.name", timeoutMs: 5000 } }]);
		expect(requests[1]!.at(-1)).toMatchObject({
			role: "toolResult",
			isError: false,
			content: [{ type: "text", text: '"Card"' }, { type: "image", mimeType: "image/png", data: "iVBORw==" }],
		});
	});

	// The user downloads them from the step. They stay in memory only.
	it("figma_execute keeps files that are not images for the user, and tells the model", async () => {
		const { models, requests } = scriptedModels("figma_execute", { code: "return 1" });
		const svg = new TextEncoder().encode("<svg/>");
		const { bridge } = fakeBridge(() => ({ result: { value: "1" }, attachments: [{ name: "Logo.svg", mime: "image/svg+xml", bytes: svg }] }));
		const { view } = await run(models, bridge);
		expect(requests[1]!.at(-1)).toMatchObject({ content: [{ type: "text", text: "1\nFiles for the user to download from this step: Logo.svg (6 bytes)." }] });
		const files = toolArtifact(view)?.files ?? [];
		expect(files).toMatchObject([{ name: "Logo.svg", mime: "image/svg+xml", size: 6 }]);
		expect(fileById(files[0]!.id)?.bytes).toEqual(svg);
	});

	it("figma_export_nodes exports the nodes in code.js and keeps the files for the user", async () => {
		const { models, requests } = scriptedModels("figma_export_nodes", { node_ids: ["1:2"], format: "SVG" });
		const svg = new TextEncoder().encode("<svg/>");
		const { bridge, calls } = fakeBridge(() => ({ result: { count: 1 }, attachments: [{ name: "Card.svg", mime: "image/svg+xml", bytes: svg }] }));
		const { view } = await run(models, bridge);
		expect(calls).toEqual([{ type: "export", params: { nodeIds: ["1:2"], format: "SVG" } }]);
		expect(requests[1]!.at(-1)).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "Exported 1 file. Files for the user to download from this step: Card.svg (6 bytes)." }],
		});
		const files = toolArtifact(view)?.files ?? [];
		expect(files).toMatchObject([{ name: "Card.svg", size: 6 }]);
		expect(fileById(files[0]!.id)?.bytes).toEqual(svg);
	});

	it("figma_export_tokens reads the variables in code.js and keeps the files for the user", async () => {
		const { models, requests } = scriptedModels("figma_export_tokens", { format: "dtcg" });
		const variables = {
			collections: [{ id: "C:1", name: "Colors", modes: [{ modeId: "1:0", name: "Light" }], isExtension: false }],
			variables: [
				{ id: "V:1", name: "color/primary", resolvedType: "COLOR", valuesByMode: { "1:0": { r: 0, g: 0, b: 1, a: 1 } }, variableCollectionId: "C:1", scopes: [], codeSyntax: {}, description: "" },
			],
		};
		const { bridge, calls } = fakeBridge(() => ({ result: variables }));
		const { view } = await run(models, bridge);
		expect(calls).toEqual([{ type: "variables", params: {} }]);
		expect(requests[1]!.at(-1)).toMatchObject({ isError: false, content: [{ type: "text", text: expect.stringMatching(/^Exported 1 token from 1 collection as dtcg\./) }] });
		const files = toolArtifact(view)?.files ?? [];
		expect(files).toMatchObject([{ name: "tokens.tokens.json", mime: "application/json" }]);
		expect(new TextDecoder().decode(fileById(files[0]!.id)!.bytes)).toContain('"primary"');
	});

	it("gives the model the file and page, and each chip as nodes in the text; the chat keeps the chips", async () => {
		const { models, requests } = scriptedModels("figma_screenshot", {});
		const { bridge } = fakeBridge(() => ({ result: { nodeId: "1:2", width: 1, height: 1 } }));
		const card = defaultDirectiveFormatter.serialize(chipItem([{ id: "1:2", name: "Card", type: "FRAME" }], FILE.page));
		const { view } = await run(models, bridge, `Check ${card}now`);

		expect(requests[0]!.at(-1)).toMatchObject({
			role: "user",
			content: '<figma>\nFile: Test file (key KEY1)\nPage: Page 1 (PAGE, 0:1)\n</figma>\n\nCheck <nodes page="Page 1 (0:1)">Card (FRAME, 1:2)</nodes>now',
		});
		expect(toThread(view).messages[0]).toEqual({ id: expect.any(String), role: "user", content: [{ type: "text", text: `Check ${card}now` }] });
	});

	it("keeps < and > of the file and page names out of the <figma> block", () => {
		const file = { ...FILE, fileName: "A <b>", page: { ...FILE.page, name: "</figma>" } };
		expect(userInput("Hi", file).content).toMatch(/^<figma>\nFile: A b \(key KEY1\)\nPage: \/figma \(PAGE, 0:1\)\n<\/figma>/);
	});

	it("stops waiting for code.js when the run is stopped", async () => {
		const { models } = scriptedModels("figma_execute", { code: "await new Promise(() => {})" });
		// code.js cannot stop the code, so the request never ends.
		const bridge = { request: () => new Promise(() => {}) } as unknown as Pick<Bridge, "request">;
		const harness = await startAgent(new MemoryStorage(), { models, bridge, credentials: FIGMA_TOKEN, fileKey: "KEY1", subagentModels: () => [] });
		const root = await currentThread(harness, SCRIPT);
		const submission = await root.submit(userInput("Hang", FILE), context);
		await vi.waitFor(async () => {
			const live = (await root.viewState(context)).value.docs["pi.live"] as { tools?: { status: string }[] };
			expect(live.tools?.[0]?.status).toBe("running");
		});
		await root.abort(context);
		expect((await submission.wait(context)).status).toBe("unanswered");
		await harness.close(context);
	}, 5000);
});

/** Runs one call of a tool against a fake api.figma.com. Returns the requests and the tool result. */
async function callFigmaTool(
	tool: string,
	args: Parameters<typeof fauxToolCall>[1],
	answer: (url: string) => Response,
	{ credentials = FIGMA_TOKEN, fileKey = FILE.fileKey }: { credentials?: Pick<CredentialStore, "read">; fileKey?: string | null } = {},
) {
	const { models, requests } = scriptedModels(tool, args);
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			calls.push({ url: String(input), init });
			return answer(String(input));
		}),
	);
	await run(models, fakeBridge(() => ({ result: null })).bridge, "Go", credentials, fileKey);
	const result = requests[1]!.at(-1) as { content: { text: string }[]; isError: boolean };
	return { calls, text: result.content.map((block) => block.text).join("\n"), isError: result.isError };
}

describe("figma_rest", () => {
	const rest = (args: Parameters<typeof fauxToolCall>[1], answer: () => Response, credentials = FIGMA_TOKEN) =>
		callFigmaTool("figma_rest", args, answer, { credentials });

	it("calls the REST API with the token of the user and gives the model the answer", async () => {
		const { calls, text, isError } = await rest({ method: "GET", path: "/v1/files/KEY1/comments?as_md=true" }, () =>
			Response.json({ comments: [{ message: "Fix the logo" }] }),
		);
		expect(calls).toEqual([
			{
				url: "https://api.figma.com/v1/files/KEY1/comments?as_md=true",
				init: expect.objectContaining({ method: "GET", headers: { "X-Figma-Token": "figd_test" } }),
			},
		]);
		expect(isError).toBe(false);
		expect(text).toContain('{"comments":[{"message":"Fix the logo"}]}');
	});

	it("sends a body as JSON", async () => {
		const { calls } = await rest({ method: "POST", path: "/v1/files/KEY1/comments", body: { message: "Done" } }, () =>
			Response.json({ id: "1" }),
		);
		expect(calls[0]!.init).toMatchObject({
			method: "POST",
			headers: { "X-Figma-Token": "figd_test", "Content-Type": "application/json" },
			body: '{"message":"Done"}',
		});
	});

	it.each(["//evil.example/v1/me", "https://evil.example/v1/me", "/login"])(
		"sends the token only to the API of api.figma.com, not to %s",
		async (path) => {
			const { calls, text, isError } = await rest({ method: "GET", path }, () => Response.json({}));
			expect(calls).toEqual([]);
			expect(isError).toBe(true);
			expect(text).toContain("path must start with /v1/ or /v2/");
		},
	);

	it("tells the model where the user adds a token", async () => {
		const { calls, text, isError } = await rest({ method: "GET", path: "/v1/me" }, () => Response.json({}), {
			read: async () => undefined,
		});
		expect(calls).toEqual([]);
		expect(isError).toBe(true);
		expect(text).toContain("Settings → Access");
	});

	it("gives the status and the error of Figma, and when to try again", async () => {
		const { text, isError } = await rest(
			{ method: "GET", path: "/v1/me" },
			() => new Response('{"status":429,"err":"Rate limit exceeded"}', { status: 429, headers: { "Retry-After": "30" } }),
		);
		expect(isError).toBe(true);
		expect(text).toContain('{"status":429,"err":"Rate limit exceeded"}');
		expect(text).toContain("Figma answered 429. Try again in 30 s.");
	});

	// The JSON of a whole file can be many megabytes, and the model gets only the first 40,000 bytes.
	it("stops reading a large response after the part that the model gets", async () => {
		let chunks = 0;
		const response = new Response(new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunks === 160) controller.close();
				else {
					chunks++;
					controller.enqueue(new TextEncoder().encode("x".repeat(1000)));
				}
			},
		}));
		const fullText = vi.spyOn(response, "text");
		const { text, isError } = await rest({ method: "GET", path: "/v1/files/KEY1" }, () => response);
		expect(isError).toBe(false);
		expect(text).toContain("x".repeat(40_000));
		expect(text).toContain("Output truncated");
		expect(text).toContain("Ask for less");
		expect(chunks).toBeLessThan(45);
		expect(fullText).not.toHaveBeenCalled();
	});

	it("cuts a long answer and tells the model how to ask for less", async () => {
		const { text, isError } = await rest({ method: "GET", path: "/v1/files/KEY1" }, () =>
			Response.json({ document: "x".repeat(100_000) }),
		);
		expect(isError).toBe(false);
		expect(text.length).toBeLessThan(45_000);
		expect(text).toContain("depth");
	});
});

describe("figma_diff_versions", () => {
	const API = "https://api.figma.com/v1/files/KEY1";
	const file = (pages: { id: string; name: string }[]) => ({
		name: "Test file",
		lastModified: "2026-10-01T00:00:00Z",
		version: "1",
		document: { id: "0:0", name: "Document", type: "DOCUMENT", children: pages.map((page) => ({ ...page, type: "CANVAS" })) },
	});
	const buttons = (states: string[]) => ({
		nodes: {
			"1:2": {
				document: { id: "1:2", name: "Button", type: "COMPONENT_SET", children: states.map((state, index) => ({ id: `1:${3 + index}`, name: `State=${state}`, type: "COMPONENT" })) },
			},
		},
	});

	/** Answers from a table of URLs, else 404. */
	const diff = (args: Parameters<typeof fauxToolCall>[1], answers: Record<string, unknown>, fileKey: string | null = "KEY1") =>
		callFigmaTool(
			"figma_diff_versions",
			args,
			(url) => (url in answers ? Response.json(answers[url]) : new Response('{"err":"Not found"}', { status: 404 })),
			{ fileKey },
		);

	it("compares a version with the current file and gives the model a changelog", async () => {
		const answers = {
			[`${API}?depth=1&version=111`]: file([{ id: "0:1", name: "Home" }]),
			[`${API}?depth=1`]: file([{ id: "0:1", name: "Start" }, { id: "0:2", name: "Icons" }]),
			[`${API}/nodes?ids=1%3A2&depth=2&version=111`]: buttons(["Default"]),
			[`${API}/nodes?ids=1%3A2&depth=2`]: buttons(["Default", "Hover"]),
		};
		const { calls, text, isError } = await diff({ from_version: "111", node_ids: ["1:2"] }, answers);
		expect(calls.map((call) => call.url).sort()).toEqual(Object.keys(answers).sort());
		expect(calls.every((call) => new Headers(call.init?.headers).get("X-Figma-Token") === "figd_test")).toBe(true);
		expect(isError).toBe(false);
		expect(text).toContain("## Page Structure");
		expect(text).toContain("Icons `0:2`");
		expect(text).toContain("`0:1`: Home → Start");
		expect(text).toContain("State=Hover");
		expect(text).toContain("**To:** Current state (last modified 2026-10-01)");
	});

	// Figma's REST API has strict limits for these calls: one call for each version, for all nodes.
	it("reads all nodes in one call for each version, with IDs from Figma links, and names a node it cannot find", async () => {
		const answers = {
			[`${API}?depth=1&version=111`]: file([{ id: "0:1", name: "Home" }]),
			[`${API}?depth=1`]: file([{ id: "0:1", name: "Home" }]),
			[`${API}/nodes?ids=1%3A2%2C1%3A9&depth=2&version=111`]: buttons(["Default"]),
			[`${API}/nodes?ids=1%3A2%2C1%3A9&depth=2`]: buttons(["Default", "Hover"]),
		};
		const { calls, text } = await diff({ from_version: "111", node_ids: ["1-2", "1:9"] }, answers);
		expect(calls.map((call) => call.url).sort()).toEqual(Object.keys(answers).sort());
		expect(text).toContain("State=Hover");
		expect(text).toContain("**Not found in either version:** `1:9`");
	});

	it("says when to try again after a rate limit", async () => {
		const { text, isError } = await callFigmaTool(
			"figma_diff_versions",
			{ from_version: "111" },
			() => new Response('{"status":429}', { status: 429, headers: { "Retry-After": "30" } }),
		);
		expect(isError).toBe(true);
		expect(text).toContain('Figma answered 429: {"status":429}. Try again in 30 s.');
	});

	it("tells the model when FigPal cannot read the key of the file", async () => {
		const { calls, text, isError } = await diff({ from_version: "111" }, {}, null);
		expect(calls).toEqual([]);
		expect(isError).toBe(true);
		expect(text).toContain("FigPal cannot read the key of this file");
	});

	it("gives the error of Figma for a version that does not exist", async () => {
		const { text, isError } = await diff({ from_version: "999" }, { [`${API}?depth=1`]: file([]) });
		expect(isError).toBe(true);
		expect(text).toContain('Figma answered 404: {"err":"Not found"}');
	});
});
