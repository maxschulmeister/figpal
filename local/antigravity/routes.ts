// The routes of Antigravity for FigPal's UI (ANTIGRAVITY_ROUTE). The model requests use pi-ai's "pi-messages" wire
// protocol: a POST of { model, context, options } to /messages, and server-sent events back. The UI's provider
// (web/src/providers/antigravity.ts) is pi-ai's client of it.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssistantMessageEvent, CacheRetention, Context, PiMessagesEvent, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { CACHE_RETENTIONS, THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { isGoogleLoginMarker } from "./auth.ts";
import { errorMessage } from "./errors.ts";
import { AntigravityRuntime, type AntigravityRuntimeOptions } from "./runtime.ts";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export type AntigravityRoutes = {
	/** `path` is the part after ANTIGRAVITY_ROUTE. The caller checked that the request comes from FigPal's UI. */
	handle(incoming: IncomingMessage, response: ServerResponse, path: string): void;
	close(): Promise<void>;
};

export function antigravityRoutes(options: AntigravityRuntimeOptions): AntigravityRoutes {
	let runtime: AntigravityRuntime | undefined;
	// The server starts only when the user uses Antigravity.
	const get = () => (runtime ??= new AntigravityRuntime(options));
	const end = (response: ServerResponse, status: number, text: string) =>
		response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);

	const route = async (incoming: IncomingMessage, response: ServerResponse, path: string) => {
		const post = incoming.method === "POST";
		if (path === "/login" && post) return login(get(), incoming, response);
		if (path === "/logout" && post) {
			await get().logout();
			return end(response, 200, "Signed out");
		}
		// The other routes need the marker of a login (auth.ts) and the server's login.
		const marker = /^Bearer (.+)$/u.exec(incoming.headers.authorization ?? "")?.[1];
		if (!marker || !isGoogleLoginMarker(marker) || !get().signedIn())
			return end(response, 401, "Sign in to Antigravity again in FigPal's settings.");
		if (path === "/models" && incoming.method === "GET") {
			const models = await get().models();
			return response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(models));
		}
		if (path === "/messages" && post) return messages(get(), marker, incoming, response);
		return end(response, 404, "Not found");
	};

	return {
		handle(incoming, response, path) {
			route(incoming, response, path).catch((error) => {
				if (response.headersSent) response.destroy();
				else end(response, 500, errorMessage(error));
			});
		},
		close: async () => {
			await runtime?.close();
		},
	};
}

/** Streams the answer of Antigravity as pi-messages events. The UI's abort closes the request: that stops the turn. */
async function messages(runtime: AntigravityRuntime, marker: string, incoming: IncomingMessage, response: ServerResponse) {
	const signal = abortOnClose(response);
	const body = parseMessagesRequest(await readJson(incoming));
	const model = await runtime.model(body.model);
	const writer = runtime.stream(model, body.context, { ...body.options, apiKey: marker, signal });
	response.writeHead(200, EVENT_STREAM);
	for await (const event of writer.stream) {
		send(response, toWire(event));
		if (event.type === "done" || event.type === "error") break;
	}
	response.end();
}

/** Streams the steps of the Google sign-in, then { type: "done", marker } or { type: "error", message }. */
async function login(runtime: AntigravityRuntime, incoming: IncomingMessage, response: ServerResponse) {
	const signal = abortOnClose(response);
	incoming.resume();
	response.writeHead(200, EVENT_STREAM);
	try {
		const marker = await runtime.loginGoogle((event) => send(response, event), signal);
		send(response, { type: "done", marker });
	} catch (error) {
		send(response, { type: "error", message: errorMessage(error) });
	}
	response.end();
}

const EVENT_STREAM = { "content-type": "text/event-stream", "cache-control": "no-store" };
const send = (response: ServerResponse, event: object) => response.write(`data: ${JSON.stringify(event)}\n\n`);

/** The UI closed the request before its end: stop the work. */
function abortOnClose(response: ServerResponse): AbortSignal {
	const controller = new AbortController();
	response.on("close", () => {
		if (!response.writableFinished) controller.abort();
	});
	return controller.signal;
}

type MessagesRequest = { model: string; context: Context; options: Pick<SimpleStreamOptions, "sessionId" | "reasoning" | "cacheRetention"> };

function parseMessagesRequest(value: unknown): MessagesRequest {
	const body = value as { model?: unknown; context?: { messages?: unknown }; options?: Record<string, unknown> } | undefined;
	if (typeof body?.model !== "string" || !/^[\w.:-]{1,128}$/u.test(body.model)) throw new Error("The request has no valid model");
	if (!Array.isArray(body.context?.messages)) throw new Error("The request has no messages");
	const { sessionId, reasoning, cacheRetention } = body.options ?? {};
	return {
		model: body.model,
		context: body.context as Context,
		options: {
			...(typeof sessionId === "string" && { sessionId }),
			...(THINKING_LEVELS.includes(reasoning as ThinkingLevel) && { reasoning: reasoning as ThinkingLevel }),
			...(CACHE_RETENTIONS.includes(cacheRetention as CacheRetention) && { cacheRetention: cacheRetention as CacheRetention }),
		},
	};
}

async function readJson(incoming: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of incoming as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("The request is too large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** An event of pi-ai's stream as pi-messages sends it: without the partial message, which the client rebuilds. */
function toWire(event: AssistantMessageEvent): PiMessagesEvent {
	switch (event.type) {
		case "done":
			// The runtime ends a stream with "stop", "length" or "toolUse" only.
			return { type: "done", reason: event.reason === "deferred" ? "stop" : event.reason, usage: event.message.usage };
		case "error":
			return { type: "error", reason: event.reason, usage: event.error.usage, ...(event.error.errorMessage !== undefined && { errorMessage: event.error.errorMessage }) };
		case "toolcall_start": {
			const block = event.partial.content[event.contentIndex];
			return { type: "toolcall_start", contentIndex: event.contentIndex, id: block?.type === "toolCall" ? block.id : "", toolName: block?.type === "toolCall" ? block.name : "" };
		}
		case "toolcall_end":
			return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: event.toolCall };
		case "start":
			return { type: "start" };
		default: {
			const { partial: _, ...rest } = event;
			return rest;
		}
	}
}
