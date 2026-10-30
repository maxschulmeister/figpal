import "fake-indexeddb/auto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	InMemoryCredentialStore,
	type Message,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import type { Attachment, FileInfo } from "@figpal/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentModels, startAgent, userInput } from "./agent";
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
});


const FILE: FileInfo = {
	fileId: "file-1",
	fileName: "Test file",
	page: { id: "0:1", name: "Page 1", type: "PAGE" },
	selection: [{ id: "1:2", name: "Card", type: "FRAME" }],
};

const SCRIPT = { model: { provider: "faux", modelId: "script" } };

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

async function run(models: ReturnType<typeof createModels>, bridge: Pick<Bridge, "request">, text = "Check the card") {
	const harness = await startAgent(new MemoryStorage(), { models, bridge });
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

	it("gives the model the file, page and selection with the message, and shows only the typed text", async () => {
		const { models, requests } = scriptedModels("figma_screenshot", {});
		const { bridge } = fakeBridge(() => ({ result: { nodeId: "1:2", width: 1, height: 1 } }));
		const { view } = await run(models, bridge, "Check the card");

		expect(requests[0]!.at(-1)).toMatchObject({
			role: "user",
			content: "<figma>\nFile: Test file\nPage: Page 1 (PAGE, 0:1)\nSelection: Card (FRAME, 1:2)\n</figma>\n\nCheck the card",
		});
		expect(toThread(view).messages[0]).toEqual({ id: expect.any(String), role: "user", content: [{ type: "text", text: "Check the card" }] });
	});

	it("stops waiting for code.js when the run is stopped", async () => {
		const { models } = scriptedModels("figma_execute", { code: "await new Promise(() => {})" });
		// code.js cannot stop the code, so the request never ends.
		const bridge = { request: () => new Promise(() => {}) } as unknown as Pick<Bridge, "request">;
		const harness = await startAgent(new MemoryStorage(), { models, bridge });
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
