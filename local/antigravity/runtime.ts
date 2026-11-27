// The Antigravity ACP server as a pi-ai model. Antigravity is an agent with its own loop: FigPal's tools reach it on a
// local MCP server (bridge.ts). When Antigravity calls one, this ends the pi-ai stream with "toolUse", FigPal's agent
// (pi-durable, in the browser) runs the tool, and the next stream gives the result to the waiting MCP call: the
// Antigravity turn continues. In the mode "default", Antigravity asks for permission before each tool: FigPal allows its
// own tools and refuses Antigravity's tools (shell, file edits), because FigPal can change only the Figma file and the
// shared folders.

import type {
	ContentBlock,
	InitializeResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import {
	type Context,
	collapseSystemMessages,
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
	type SimpleStreamOptions,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

import { isGoogleLoginMarker, newGoogleLoginMarker } from "./auth.ts";
import { MCP_SERVER, PiMcpBridge, type PiToolInvocation, piToolFingerprint } from "./bridge.ts";
import { AntigravityAcpConnection, type AntigravityConnectionOptions } from "./connection.ts";
import { buildPromptParts, currentSystemInstructions, type PromptParts } from "./context.ts";
import { abortError, AntigravityAcpError } from "./errors.ts";
import { mapSessionUpdate } from "./events.ts";
import { acpEnvironment, type AntigravityLaunch, clearGoogleLogin, hasSavedGoogleLogin, removeConversation, workspaceFolder } from "./launch.ts";
import { type AntigravityModel, FALLBACK_MODELS, projectModels, resolveAcpModelId } from "./models.ts";
import { OAuthCapture } from "./oauth.ts";
import { PiEventWriter } from "./pi-events.ts";
import { quotaExhaustion } from "./quota.ts";
import { type AcpNewSessionResponse, type SessionState, sessionModels, sessionModes } from "./session-state.ts";
import { ensureRuntime } from "./setup.ts";
import { usageFromPrompt } from "./usage.ts";

/** In this mode, Antigravity asks before its own tools run, and FigPal refuses them. */
const DEFAULT_MODE = "default";
const TOOL_BATCH_MS = 100;
const MAX_BINDINGS = 4;
const BINDING_IDLE_MS = 5 * 60_000;
const MODELS_CACHE_MS = 60 * 60_000;

interface PendingPiTool {
	invocation: PiToolInvocation;
	/** Resolve the MCP request and release its bounded work-watchdog hold. */
	resolve: (result: CallToolResult) => void;
}

interface Binding {
	key: string;
	credentialId: string;
	connection: AntigravityAcpConnection;
	initialize: InitializeResponse;
	session: AcpNewSessionResponse;
	instructionsFingerprint: string | undefined;
	needsReconstruction: boolean;
	modelId: string;
	messageCount: number;
	historyFingerprint: string;
	expectedAssistantFingerprint: string | undefined;
	pendingContextCount: number;
	pendingContextFingerprint: string;
	writer: PiEventWriter | undefined;
	pendingTools: Map<string, PendingPiTool>;
	/** The tool calls that Antigravity marked as MCP calls: calls of FigPal's tools. */
	mcpCalls: Set<string>;
	/** Latest `usage_update.used` and the inference count of the running ACP prompt. */
	contextUsed: number | undefined;
	inferences: number;
	toolBatchTimer: ReturnType<typeof setTimeout> | undefined;
	bridge: PiMcpBridge | undefined;
	toolFingerprint: string;
	turnCompletion: Promise<void> | undefined;
	abortRequested: boolean;
	lastUsedAt: number;
	lastUsedSeq: number;
}

/** What the login tells FigPal's UI: the steps, and the Google page to open. */
export type LoginEvent = { type: "progress"; message: string } | { type: "auth_url"; url: string };

export interface AntigravityRuntimeOptions {
	/** The folder of the ACP server, its login and its workspace (launch.ts). */
	root: string;
}

export class AntigravityRuntime {
	private readonly bindings = new Map<string, Promise<Binding>>();
	private readonly resolvedBindings = new Set<Binding>();
	private readonly bindingPromises = new WeakMap<Binding, Promise<Binding>>();
	private disposed = false;
	private closePromise: Promise<void> | undefined;
	private logoutInFlight: Promise<void> | undefined;
	private bindingEpoch = 0;
	private readonly busyKeys = new Map<string, number>();
	private readonly activeConnections = new Set<AntigravityAcpConnection>();
	private readonly queues = new Map<string, Promise<void>>();
	private evictionQueue: Promise<void> = Promise.resolve();
	private idleCleanupTimer: ReturnType<typeof setInterval> | undefined;
	private usageSeq = 0;
	private catalog: { at: number; models: Promise<AntigravityModel[]> } | undefined;
	/** The last list of models that the server gave. */
	private listed: AntigravityModel[] = [];
	private readonly root: string;

	constructor(options: AntigravityRuntimeOptions) {
		this.root = options.root;
	}

	/** True when the server saved a Google login. */
	signedIn(): boolean {
		return hasSavedGoogleLogin(this.root);
	}

	stream(model: AntigravityModel, context: Context, options: SimpleStreamOptions): PiEventWriter {
		const writer = new PiEventWriter(model);
		// ACP has no mid-conversation system-message API. Replay FigPal's prompt/tool
		// deltas into a checkpoint; its fingerprint invalidates stale warm sessions.
		try {
			const transcript = collapseSystemMessages(normalizeContext(context));
			const resolvedContext: Context = {
				messages: transcript.messages,
				systemPrompt: getCurrentSystemPrompt(transcript.messages),
				tools: getCurrentTools(transcript.messages),
			};
			currentSystemInstructions(resolvedContext);
			if (options.signal?.aborted) throw abortError();
			writer.start();
			void this.runQueued(model, resolvedContext, options, writer)
				.then(() => {
					if (!writer.finished) {
						writer.fail(
							new AntigravityAcpError("protocol", "Antigravity ACP stream ended without completing the response"),
							options.signal?.aborted === true,
						);
					}
				})
				.catch((error: unknown) => {
					writer.fail(error, options.signal?.aborted === true || isAbort(error));
				});
		} catch (error) {
			writer.fail(error, options.signal?.aborted === true || isAbort(error));
		}
		return writer;
	}

	/** The models of the signed-in account, from a short session. Kept for an hour. */
	models(): Promise<AntigravityModel[]> {
		if (!this.catalog || Date.now() - this.catalog.at > MODELS_CACHE_MS) {
			// One shared request: no caller's abort stops it. The timeouts of the connection end it.
			const models = this.discoverModels().then((found) => (this.listed = projectModels(found)));
			this.catalog = { at: Date.now(), models };
			models.catch(() => {
				if (this.catalog?.models === models) this.catalog = undefined;
			});
		}
		return this.catalog.models;
	}

	/** The model of `id`: from the last list, else from the bundled list, else from a new list. A new ID becomes a model without levels. */
	async model(id: string): Promise<AntigravityModel> {
		const known = (list: readonly AntigravityModel[]) => list.find((model) => model.id === id);
		const found = known(this.listed) ?? known(FALLBACK_MODELS) ?? known(await this.models().catch(() => []));
		return found ?? projectModels([{ modelId: id, name: id }])[0]!;
	}

	private async discoverModels() {
		this.assertActive();
		const epoch = this.bindingEpoch;
		const launch = await this.launch();
		this.assertEpoch(epoch);
		const cwd = workspaceFolder(this.root);
		const connection = this.createConnection({ cwd, ...launch });
		try {
			await connection.initialize();
			this.assertEpoch(epoch);
			const session = await connection.newSession(cwd);
			this.assertEpoch(epoch);
			return sessionModels(session)?.availableModels ?? [];
		} finally {
			await connection.close();
		}
	}

	/**
	 * Signs in with Google: installs the server if needed, gives the Google page to `notify`, and waits until the
	 * server saved the login. Gives the marker that FigPal's UI keeps.
	 */
	async loginGoogle(notify: (event: LoginEvent) => void, signal?: AbortSignal): Promise<string> {
		this.assertActive();
		signal?.throwIfAborted();
		const epoch = this.bindingEpoch;
		const capture = new OAuthCapture(acpEnvironment(this.root));
		let connection: AntigravityAcpConnection | undefined;
		try {
			const launch = await ensureRuntime(this.root, (message) => notify({ type: "progress", message }));
			this.assertEpoch(epoch);
			signal?.throwIfAborted();
			// A new login must not silently reuse the old account.
			await this.logout();
			signal?.throwIfAborted();
			const loginEpoch = this.bindingEpoch;
			const cwd = workspaceFolder(this.root);
			connection = this.createConnection({ cwd, env: capture.env, ...launch });
			const initialize = await connection.initialize(signal);
			this.assertEpoch(loginEpoch);
			const method = initialize.authMethods?.find((candidate) =>
				/log\s*in\s+with\s+google|google\s+account|oauth-personal/iu.test(`${candidate.id} ${candidate.name}`),
			);
			if (!method) throw new AntigravityAcpError("auth", "Antigravity ACP did not advertise Google login");
			notify({ type: "progress", message: "Opening the Google sign-in…" });
			const authentication = connection.authenticate({ methodId: method.id }, signal, 10 * 60_000);
			void authentication.catch(() => undefined);
			// Without the URL (for example a server that opens the browser itself), the sign-in can still end.
			const url = await Promise.race([capture.waitForUrl(signal).catch(() => undefined), authentication.then(() => undefined)]);
			if (url) notify({ type: "auth_url", url });
			await authentication;
			this.assertEpoch(loginEpoch);
			await connection.newSession(cwd, signal);
			this.assertEpoch(loginEpoch);
			if (!this.signedIn()) throw new AntigravityAcpError("auth", "Antigravity did not save the Google login");
			this.catalog = undefined;
			return newGoogleLoginMarker();
		} finally {
			capture.dispose();
			await connection?.close();
		}
	}

	logout(): Promise<void> {
		this.logoutInFlight ??= this.resetAuthentication().finally(() => {
			this.logoutInFlight = undefined;
		});
		return this.logoutInFlight;
	}

	private async resetAuthentication(): Promise<void> {
		this.catalog = undefined;
		await this.closeBindings();
		clearGoogleLogin(this.root);
	}

	close(): Promise<void> {
		this.disposed = true;
		this.closePromise ??= this.closeBindings();
		return this.closePromise;
	}

	private async launch(): Promise<AntigravityLaunch> {
		if (!this.signedIn()) throw new AntigravityAcpError("auth", "Sign in to Antigravity in FigPal's settings.");
		return ensureRuntime(this.root);
	}

	private async closeBindings(): Promise<void> {
		this.bindingEpoch += 1;
		const pending = [...this.bindings.values()];
		this.bindings.clear();
		for (const binding of this.resolvedBindings) cancelPiTools(binding, "Antigravity shut down before FigPal returned the tool result");
		this.resolvedBindings.clear();
		this.syncIdleCleanupTimer(true);
		// Includes authentication/discovery and sessions still initializing, not just warm bindings.
		await Promise.allSettled([...this.activeConnections].map((connection) => connection.close()));
		await Promise.allSettled(
			pending.map(async (binding) => {
				const value = await binding;
				await Promise.allSettled([value.connection.close(), value.bridge?.close() ?? Promise.resolve()]);
			}),
		);
	}

	private async runQueued(model: AntigravityModel, context: Context, options: SimpleStreamOptions, writer: PiEventWriter): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		// One-off requests (e.g. compaction summaries) never keep a session.
		const persistent = Boolean(options.sessionId) && options.cacheRetention !== "none";
		const key = persistent ? `sid:${options.sessionId}` : (this.findContinuationKey(context) ?? `ephemeral:${crypto.randomUUID()}`);
		this.retainBusyKey(key);
		try {
			const tools = context.tools ?? [];
			const toolFingerprint = piToolFingerprint(tools);
			const acpModelId = resolveAcpModelId(model, options.reasoning);
			let binding = await this.getBinding(key, acpModelId, options.apiKey, writer, tools, options.signal);
			this.assertEpoch(epoch);
			// Check before continuation early returns as well as before fresh prompts.
			if (!this.inDefaultMode(binding) || binding.toolFingerprint !== toolFingerprint) {
				await this.invalidateBinding(binding);
				this.assertEpoch(epoch);
				binding = await this.getBinding(key, acpModelId, options.apiKey, writer, tools, options.signal);
			} else if (isConnectionDead(binding.connection)) {
				await this.dropBinding(key, binding);
				this.assertEpoch(epoch);
				binding = await this.getBinding(key, acpModelId, options.apiKey, writer, tools, options.signal);
			}

			// Tool results resume the still-running ACP prompt rather than starting a second Antigravity turn.
			if (!binding.turnCompletion && binding.pendingTools.size > 0) {
				cancelPiTools(binding, "Antigravity turn ended before FigPal returned the tool result");
			}
			if (binding.pendingTools.size > 0) {
				const results = [...binding.pendingTools.values()].map((pending) => ({
					pending,
					message: findToolResult(context, pending.invocation.id, pending.invocation.name),
				}));
				if (results.some((result) => result.message === undefined)) {
					cancelPiTools(binding, "FigPal continued without returning every requested tool result");
					await this.dropBinding(key, binding);
					this.assertEpoch(epoch);
					binding = await this.getBinding(key, acpModelId, options.apiKey, writer, tools, options.signal);
				} else {
					binding.writer = writer;
					this.touchBinding(binding);
					this.noteContinuationInstructions(binding, context);
					binding.pendingContextCount = context.messages.length;
					binding.pendingContextFingerprint = messagesFingerprint(context.messages);
					this.commitProgress(binding);
					for (const { pending, message } of results) {
						binding.pendingTools.delete(pending.invocation.id);
						pending.resolve(toMcpToolResult(message as ToolResultMessage));
					}
					await this.awaitContinuation(binding, options.signal);
					if (!writer.finished) {
						writer.fail(
							new AntigravityAcpError("protocol", "Antigravity ACP tool continuation ended without completing the response"),
							options.signal?.aborted === true,
						);
					}
					return;
				}
			}

			const previous = this.queues.get(key) ?? Promise.resolve();
			let release!: () => void;
			const queue = new Promise<void>((resolve) => {
				release = resolve;
			});
			this.queues.set(key, queue);
			await previous;

			let completeTurn: (() => void) | undefined;
			let onTurnAbort: (() => void) | undefined;
			try {
				this.assertEpoch(epoch);
				// A queued caller may hold an obsolete binding after shutdown.
				binding = await this.getBinding(key, acpModelId, options.apiKey, writer, tools, options.signal);
				if (
					binding.needsReconstruction ||
					!this.inDefaultMode(binding) ||
					binding.toolFingerprint !== toolFingerprint ||
					context.messages.length < binding.messageCount ||
					messagesFingerprint(context.messages.slice(0, binding.messageCount)) !== binding.historyFingerprint
				) {
					await this.dropBinding(key, binding);
					this.assertEpoch(epoch);
					binding = await this.getBinding(key, acpModelId, options.apiKey, writer, tools, options.signal);
				}
				binding.writer = writer;
				if (binding.modelId !== acpModelId) {
					try {
						await binding.connection.setModel(binding.session.sessionId, acpModelId, options.signal);
						binding.modelId = acpModelId;
					} catch (error) {
						// A split selection can change the base before effort fails: the warm session is not trustworthy.
						await this.invalidateBinding(binding);
						throw error;
					}
				}

				const fresh = binding.messageCount === 0;
				let unseenStart = binding.messageCount;
				const expected = context.messages[unseenStart];
				if (!fresh && expected?.role === "assistant" && binding.expectedAssistantFingerprint === messageFingerprint(expected)) {
					unseenStart += 1;
				}
				const parts = adaptPromptToCapabilities(buildPromptParts(context, fresh, unseenStart), binding.initialize);
				this.assertEpoch(epoch);
				if (isConnectionDead(binding.connection)) {
					await this.dropBinding(key, binding);
					throw new AntigravityAcpError("process_exit", "Antigravity ACP connection closed before prompting");
				}
				binding.instructionsFingerprint = instructionFingerprint(context);
				binding.needsReconstruction = false;
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = messagesFingerprint(context.messages);
				binding.contextUsed = undefined;
				binding.inferences = 0;
				binding.turnCompletion = new Promise<void>((resolve) => {
					completeTurn = resolve;
				});
				this.touchBinding(binding);
				if (options.signal) {
					const promptBinding = binding;
					onTurnAbort = () => abortTurn(promptBinding);
					options.signal.addEventListener("abort", onTurnAbort, { once: true });
					if (options.signal.aborted) onTurnAbort();
				}
				const response = await binding.connection.prompt({ sessionId: binding.session.sessionId, prompt: parts.prompt }, options.signal);
				if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
				const activeWriter = binding.writer ?? writer;
				if (binding.abortRequested) throw abortError();
				const usage = usageFromPrompt(response, model);
				// agy reports exhaustion as an ordinary reply; fail it before the turn is kept.
				const quota =
					usage.totalTokens === 0 || response.stopReason === "refusal"
						? quotaExhaustion(activeWriter.message.content.map((block) => (block.type === "text" ? block.text : "")).join(""))
						: undefined;
				if (quota) {
					throw new AntigravityAcpError("quota", `Antigravity quota exceeded for ${binding.modelId}.${quota.resetAt ? ` Resets at ${quota.resetAt}.` : ""}`);
				}
				if (binding.contextUsed !== undefined) {
					// pi-ai checks input + cacheRead for silent overflow, not totalTokens. For multiple inferences, only the
					// latest context size is known, not its cache split. Legacy agy can count cache reads twice in `used`;
					// ACP 1.5.0 does not. Correct only a single inference whose prompt total proves that discrepancy.
					const contextUsed =
						binding.inferences === 1 && binding.contextUsed === usage.totalTokens + usage.cacheRead ? usage.totalTokens : binding.contextUsed;
					activeWriter.message.usage = {
						...usage,
						input: binding.inferences > 1 ? binding.contextUsed : usage.input,
						cacheRead: binding.inferences > 1 ? 0 : usage.cacheRead,
						totalTokens: contextUsed,
					};
				} else activeWriter.message.usage = usage;
				activeWriter.message.rawStopReason = response.stopReason;
				binding.messageCount = binding.pendingContextCount || parts.messageCount;
				binding.historyFingerprint = binding.pendingContextFingerprint;
				binding.expectedAssistantFingerprint = messageFingerprint(activeWriter.message);
				switch (response.stopReason) {
					case "cancelled":
						throw abortError();
					case "max_tokens":
					case "max_turn_requests":
						activeWriter.done("length");
						break;
					default:
						activeWriter.done("stop");
				}
			} catch (error) {
				if (binding.pendingTools.size > 0 && (binding.writer ?? writer).finished) {
					this.commitProgress(binding, (binding.writer ?? writer).message);
				}
				if (isAbort(error) || binding.abortRequested) abortTurn(binding);
				// Evict closing connections before failing the stream can wake a retry.
				if (isConnectionDead(binding.connection)) await this.dropBinding(key, binding);
				binding.writer?.fail(error, isAbort(error));
				throw error;
			} finally {
				if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
				// ACP can time out before FigPal's tool finishes; replay late results in a new prompt, not a dead continuation.
				cancelPiTools(binding, "Antigravity prompt ended before FigPal returned the tool result");
				completeTurn?.();
				binding.turnCompletion = undefined;
				binding.abortRequested = false;
				binding.writer = undefined;
				this.touchBinding(binding);
				release();
				if (this.queues.get(key) === queue) this.queues.delete(key);
				if (!persistent) await this.dropBinding(key, binding);
				else if (this.bindings.size > MAX_BINDINGS) void this.evictForCapacity();
			}
		} finally {
			this.releaseBusyKey(key);
		}
	}

	private async awaitContinuation(binding: Binding, signal?: AbortSignal): Promise<void> {
		const completion = binding.turnCompletion;
		if (!completion) throw new AntigravityAcpError("protocol", "Antigravity prompt ended before FigPal could continue");
		if (!signal) {
			await completion;
			return;
		}
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			if (binding.turnCompletion !== completion || binding.abortRequested) return;
			abortTurn(binding);
			void binding.connection.cancel(binding.session.sessionId).catch(() => undefined);
			killTimer = setTimeout(() => {
				if (binding.turnCompletion === completion) void binding.connection.close();
			}, 1_500);
			killTimer.unref?.();
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		try {
			await completion;
		} finally {
			signal.removeEventListener("abort", abort);
			if (killTimer) clearTimeout(killTimer);
		}
	}

	private findContinuationKey(context: Context): string | undefined {
		for (const binding of this.resolvedBindings) {
			if (!binding.turnCompletion || binding.pendingTools.size === 0) continue;
			if ([...binding.pendingTools.values()].every((pending) => findToolResult(context, pending.invocation.id, pending.invocation.name))) {
				return binding.key;
			}
		}
		return undefined;
	}

	private async getBinding(
		key: string,
		acpModelId: string,
		apiKey: string | undefined,
		writer: PiEventWriter,
		tools: Context["tools"],
		signal?: AbortSignal,
	): Promise<Binding> {
		// A warm session belongs to one login: the marker of a new login gets new sessions.
		const credentialId = apiKey ?? "";
		for (;;) {
			this.assertActive();
			const existing = this.bindings.get(key);
			if (!existing) break;
			const resolved = await existing;
			if (resolved.credentialId !== credentialId) {
				await this.invalidateBinding(resolved);
				continue;
			}
			if (!isConnectionDead(resolved.connection)) {
				this.touchBinding(resolved);
				return resolved;
			}
			await this.dropBinding(key, resolved);
		}
		let created!: Promise<Binding>;
		created = (async () => {
			await this.evictForCapacity();
			this.assertActive();
			return this.createBinding(key, acpModelId, apiKey, credentialId, writer, tools ?? [], created, signal);
		})().catch((error) => {
			if (this.bindings.get(key) === created) this.bindings.delete(key);
			throw error;
		});
		this.bindings.set(key, created);
		return created;
	}

	private async createBinding(
		key: string,
		acpModelId: string,
		apiKey: string | undefined,
		credentialId: string,
		writer: PiEventWriter,
		tools: NonNullable<Context["tools"]>,
		entryPromise: Promise<Binding>,
		signal?: AbortSignal,
	): Promise<Binding> {
		if (!apiKey || !isGoogleLoginMarker(apiKey)) throw new AntigravityAcpError("auth", "Sign in to Antigravity in FigPal's settings.");
		const epoch = this.bindingEpoch;
		const launch = await this.launch();
		this.assertEpoch(epoch);
		const cwd = workspaceFolder(this.root);
		let binding: Binding | undefined;
		let bridge: PiMcpBridge | undefined;
		const connection = this.createConnection({
			cwd,
			...launch,
			handlers: {
				onUpdate: (notification) => this.consumeUpdate(binding, notification),
				onPermission: (request) => this.decidePermission(binding, request),
			},
		});
		try {
			const initialize = await connection.initialize(signal);
			this.assertEpoch(epoch);
			let mcpServer: Awaited<ReturnType<PiMcpBridge["start"]>>;
			if (tools.length > 0) {
				if (initialize.agentCapabilities?.mcpCapabilities?.http !== true)
					throw new AntigravityAcpError("protocol", "This Antigravity ACP server cannot use FigPal's tools: it has no MCP over HTTP");
				bridge = new PiMcpBridge({ tools, onCall: (invocation) => this.requestPiTool(binding, invocation) });
				mcpServer = await bridge.start();
			}
			const session = await connection.newSession(cwd, signal, mcpServer ? [mcpServer] : []);
			this.assertEpoch(epoch);
			const modes = sessionModes(session);
			if (!modes?.availableModes.some((mode) => mode.id === DEFAULT_MODE))
				throw new AntigravityAcpError("protocol", "Antigravity cannot ask before its own tools run: its session has no 'default' mode");
			if (modes.currentModeId !== DEFAULT_MODE) await connection.setMode(session.sessionId, DEFAULT_MODE, signal);
			if (!inDefaultMode(connection.getSessionState(session.sessionId))) {
				throw new AntigravityAcpError("protocol", "Antigravity did not confirm the 'default' permission mode");
			}
			if (sessionModels(session)?.currentModelId !== acpModelId) await connection.setModel(session.sessionId, acpModelId, signal);
			this.assertEpoch(epoch);
			const createdBinding: Binding = {
				key,
				credentialId,
				connection,
				initialize,
				session,
				instructionsFingerprint: undefined,
				needsReconstruction: false,
				modelId: acpModelId,
				messageCount: 0,
				historyFingerprint: messagesFingerprint([]),
				expectedAssistantFingerprint: undefined,
				pendingContextCount: 0,
				pendingContextFingerprint: messagesFingerprint([]),
				writer,
				pendingTools: new Map(),
				mcpCalls: new Set(),
				contextUsed: undefined,
				inferences: 0,
				toolBatchTimer: undefined,
				bridge,
				toolFingerprint: piToolFingerprint(tools),
				turnCompletion: undefined,
				abortRequested: false,
				lastUsedAt: Date.now(),
				lastUsedSeq: ++this.usageSeq,
			};
			binding = createdBinding;
			this.bindingPromises.set(createdBinding, entryPromise);
			this.resolvedBindings.add(createdBinding);
			this.syncIdleCleanupTimer();
			void connection.process.exited
				.then(() => {
					cancelPiTools(createdBinding, "Antigravity process exited before FigPal returned the tool result");
					this.resolvedBindings.delete(createdBinding);
					this.syncIdleCleanupTimer();
					void bridge?.close().catch(() => undefined);
					if (this.bindings.get(key) === entryPromise) this.bindings.delete(key);
				})
				.catch(() => undefined);
			return createdBinding;
		} catch (error) {
			await Promise.allSettled([connection.close(), bridge?.close() ?? Promise.resolve()]);
			throw error;
		}
	}

	private commitProgress(binding: Binding, assistantMessage?: Context["messages"][number]): void {
		if (binding.pendingContextCount <= 0) return;
		binding.messageCount = binding.pendingContextCount;
		binding.historyFingerprint = binding.pendingContextFingerprint;
		binding.expectedAssistantFingerprint = assistantMessage ? messageFingerprint(assistantMessage) : undefined;
	}

	private requestPiTool(binding: Binding | undefined, invocation: PiToolInvocation): Promise<CallToolResult> {
		const batchWriter = binding?.writer;
		if (!binding || !batchWriter || batchWriter.finished || binding.abortRequested) {
			return Promise.resolve({ content: [{ type: "text", text: "FigPal cannot accept this tool call in the current turn" }], isError: true });
		}
		return new Promise<CallToolResult>((resolve) => {
			let release: (() => void) | undefined;
			try {
				release = binding.connection.holdPromptWatchdog(binding.session.sessionId);
				const held = release;
				binding.pendingTools.set(invocation.id, {
					invocation,
					resolve: (result) => {
						held();
						resolve(result);
					},
				});
				// End the slice that received this call; by the time the timer fires FigPal may already
				// be streaming the continuation through a newer writer.
				batchWriter.toolCall(invocation.id, invocation.name, invocation.arguments);
				if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
				const batchTimer = setTimeout(() => {
					if (binding.toolBatchTimer === batchTimer) binding.toolBatchTimer = undefined;
					batchWriter.done("toolUse");
				}, TOOL_BATCH_MS);
				binding.toolBatchTimer = batchTimer;
				binding.toolBatchTimer.unref();
			} catch {
				binding.pendingTools.delete(invocation.id);
				release?.();
				resolve({ content: [{ type: "text", text: "FigPal could not accept the tool call" }], isError: true });
			}
		});
	}

	/**
	 * FigPal's tools may run: FigPal runs them itself. Antigravity's own tools (shell, file edits) would run outside
	 * FigPal's shared folders: FigPal refuses them.
	 */
	private async decidePermission(binding: Binding | undefined, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		const call = request.toolCall;
		const meta = call._meta as Record<string, unknown> | null | undefined;
		const input = call.rawInput as Record<string, unknown> | null | undefined;
		// A direct MCP call (agy marks it), or one through call_mcp_tool, which names the server.
		const figpal = meta?.is_mcp_tool_call === true || binding?.mcpCalls.has(call.toolCallId) === true || input?.ServerName === MCP_SERVER;
		const choose = (...kinds: string[]) => {
			const option = kinds.map((kind) => request.options.find((option) => option.kind === kind)).find(Boolean);
			return option ? { outcome: { outcome: "selected" as const, optionId: option.optionId } } : { outcome: { outcome: "cancelled" as const } };
		};
		if (figpal) return choose("allow_once", "allow_always");
		const title = call.title?.replace(/\s+/gu, " ").trim().slice(0, 200) || "a tool";
		binding?.writer?.thinking(`\n[FigPal refused Antigravity's own tool: ${title}. Use FigPal's tools.]\n`);
		// The log tells the form of a refused request, without its values.
		console.error("FigPal refused an Antigravity tool:", JSON.stringify({ title, kind: call.kind, meta: Object.keys(meta ?? {}), input: Object.keys(input ?? {}) }));
		return choose("reject_once", "reject_always");
	}

	private consumeUpdate(binding: Binding | undefined, notification: SessionNotification): void {
		if (!binding || notification.sessionId !== binding.session.sessionId) return;
		if (
			(notification.update.sessionUpdate === "config_option_update" || notification.update.sessionUpdate === "current_mode_update") &&
			!this.inDefaultMode(binding)
		) {
			binding.writer?.fail(new AntigravityAcpError("protocol", "Antigravity changed the permission mode unexpectedly; session closed"), false);
			void this.invalidateBinding(binding).catch(() => undefined);
			return;
		}
		const update = notification.update;
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			if (update.status === "completed" || update.status === "failed") binding.mcpCalls.delete(update.toolCallId);
			else if (update._meta?.is_mcp_tool_call === true) binding.mcpCalls.add(update.toolCallId);
		}
		if (!binding.writer) return;
		for (const activity of mapSessionUpdate(notification)) {
			if (activity.type === "text") binding.writer.text(activity.delta);
			else if (activity.type === "thought") binding.writer.thinking(activity.delta);
			else if (activity.type === "usage") {
				binding.contextUsed = activity.used;
				binding.inferences += 1;
				if (!binding.writer.finished) binding.writer.message.usage.totalTokens = activity.used;
			}
		}
	}

	private async dropBinding(key: string, binding: Binding): Promise<void> {
		this.resolvedBindings.delete(binding);
		this.syncIdleCleanupTimer();
		const entryPromise = this.bindingPromises.get(binding);
		const current = this.bindings.get(key);
		if (
			current &&
			(entryPromise ? entryPromise === current : (await current.catch(() => undefined)) === binding && this.bindings.get(key) === current)
		) {
			this.bindings.delete(key);
		}
		cancelPiTools(binding, "Antigravity session closed before FigPal returned the tool result");
		await Promise.allSettled([binding.connection.close(), binding.bridge?.close() ?? Promise.resolve()]);
	}

	private touchBinding(binding: Binding): void {
		binding.lastUsedAt = Date.now();
		binding.lastUsedSeq = ++this.usageSeq;
	}

	private isBindingIdle(binding: Binding): boolean {
		return (
			binding.turnCompletion === undefined &&
			binding.pendingTools.size === 0 &&
			!this.queues.has(binding.key) &&
			(this.busyKeys.get(binding.key) ?? 0) === 0
		);
	}

	private syncIdleCleanupTimer(forceStop = false): void {
		if (forceStop || this.disposed || this.resolvedBindings.size === 0) {
			if (this.idleCleanupTimer) {
				clearInterval(this.idleCleanupTimer);
				this.idleCleanupTimer = undefined;
			}
			return;
		}
		if (this.idleCleanupTimer) return;
		const intervalMs = Math.max(10, Math.min(Math.floor(BINDING_IDLE_MS / 2), 30_000));
		this.idleCleanupTimer = setInterval(() => {
			void this.evictExpiredBindings();
		}, intervalMs);
		this.idleCleanupTimer.unref();
	}

	private runEviction(task: () => Promise<void>): Promise<void> {
		const next = this.evictionQueue.then(task, task);
		this.evictionQueue = next.catch(() => undefined);
		return next;
	}

	private evictExpiredBindings(): Promise<void> {
		return this.runEviction(async () => {
			if (this.disposed) return;
			const now = Date.now();
			const expired = [...this.resolvedBindings].filter((binding) => this.isBindingIdle(binding) && now - binding.lastUsedAt >= BINDING_IDLE_MS);
			await Promise.all(expired.map((binding) => this.dropBinding(binding.key, binding)));
		});
	}

	private evictForCapacity(): Promise<void> {
		return this.runEviction(async () => {
			if (this.disposed || this.bindings.size <= MAX_BINDINGS) return;
			const excess = this.bindings.size - MAX_BINDINGS;
			const candidates = [...this.resolvedBindings]
				.filter((binding) => this.isBindingIdle(binding))
				.sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.lastUsedSeq - right.lastUsedSeq)
				.slice(0, excess);
			await Promise.all(candidates.map((binding) => this.dropBinding(binding.key, binding)));
		});
	}

	private inDefaultMode(binding: Binding): boolean {
		return inDefaultMode(binding.connection.getSessionState(binding.session.sessionId));
	}

	private noteContinuationInstructions(binding: Binding, context: Context): void {
		// ACP has no system-update RPC. Finish this immutable prompt, then rebuild.
		if (binding.instructionsFingerprint !== instructionFingerprint(context)) binding.needsReconstruction = true;
	}

	private async invalidateBinding(binding: Binding): Promise<void> {
		if (binding.turnCompletion) abortTurn(binding);
		await this.dropBinding(binding.key, binding);
	}

	private createConnection(options: AntigravityConnectionOptions): AntigravityAcpConnection {
		this.assertActive();
		if (this.logoutInFlight) throw new AntigravityAcpError("auth", "Antigravity ACP logout is in progress");
		const connection = new AntigravityAcpConnection({ ...options, env: options.env ?? acpEnvironment(this.root) });
		this.activeConnections.add(connection);
		void connection.process.exited
			.then(() => {
				this.activeConnections.delete(connection);
				// FigPal never resumes a session: its conversation files would only fill the disk.
				for (const sessionId of connection.sessionIds) removeConversation(this.root, sessionId);
			})
			.catch(() => undefined);
		return connection;
	}

	private retainBusyKey(key: string): void {
		this.busyKeys.set(key, (this.busyKeys.get(key) ?? 0) + 1);
	}

	private releaseBusyKey(key: string): void {
		const count = this.busyKeys.get(key) ?? 0;
		if (count <= 1) this.busyKeys.delete(key);
		else this.busyKeys.set(key, count - 1);
	}

	private assertEpoch(epoch: number): void {
		this.assertActive();
		if (epoch !== this.bindingEpoch) throw new AntigravityAcpError("process_exit", "Antigravity session was closed during setup");
	}

	private assertActive(): void {
		if (this.disposed) throw new AntigravityAcpError("process_exit", "Antigravity ACP runtime is closed");
	}
}

function inDefaultMode(state: SessionState): boolean {
	const modes = sessionModes(state);
	return modes?.currentModeId === DEFAULT_MODE && modes.availableModes.some((mode) => mode.id === DEFAULT_MODE);
}

function adaptPromptToCapabilities(parts: PromptParts, initialize: InitializeResponse): PromptParts {
	const capabilities = initialize.agentCapabilities?.promptCapabilities;
	const output: ContentBlock[] = [];
	for (const block of parts.prompt) {
		if (block.type === "image" && capabilities?.image !== true) {
			throw new AntigravityAcpError("invalid_input", "This Antigravity ACP runtime did not advertise image input");
		}
		if (block.type === "resource" && capabilities?.embeddedContext !== true) {
			const resource = block.resource;
			if ("text" in resource) output.push({ type: "text", text: resource.text });
			continue;
		}
		output.push(block);
	}
	return { ...parts, prompt: output };
}

function messagesFingerprint(messages: Context["messages"]): string {
	const fingerprints = messages.map(messageFingerprint);
	return createHash("sha256").update(fingerprints.join("\n")).digest("hex");
}

function messageFingerprint(message: Context["messages"][number]): string {
	let value: unknown;
	if (message.role === "user") {
		value = { role: message.role, content: message.content };
	} else if (message.role === "assistant") {
		value = { role: message.role, provider: message.provider, model: message.model, content: message.content };
	} else if (message.role === "system") {
		value = {
			role: message.role,
			content: message.content,
			sections: message.sections,
			toolsAdded: message.toolsAdded,
			toolsRemoved: message.toolsRemoved,
		};
	} else {
		value = { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, content: message.content, isError: message.isError };
	}
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** JSON with sorted keys: the same message gives the same fingerprint. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function findToolResult(context: Context, toolCallId: string, toolName: string): ToolResultMessage | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role === "toolResult" && message.toolCallId === toolCallId && message.toolName === toolName) return message;
	}
	return undefined;
}

function toMcpToolResult(message: ToolResultMessage): CallToolResult {
	return {
		content: message.content.map((block) =>
			block.type === "text" ? { type: "text" as const, text: block.text } : { type: "image" as const, data: block.data, mimeType: block.mimeType },
		),
		isError: message.isError,
	};
}

function instructionFingerprint(context: Context): string {
	return createHash("sha256").update(currentSystemInstructions(context)).digest("hex");
}

function abortTurn(binding: Binding): void {
	binding.abortRequested = true;
	cancelPiTools(binding, "FigPal turn was aborted before returning the tool result");
}

function cancelPiTools(binding: Binding, reason: string): void {
	if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
	binding.toolBatchTimer = undefined;
	for (const pending of binding.pendingTools.values()) {
		pending.resolve({ content: [{ type: "text", text: reason }], isError: true });
	}
	binding.pendingTools.clear();
}

function isConnectionDead(connection: AntigravityAcpConnection): boolean {
	return connection.closed === true || !connection.process.alive;
}

function isAbort(error: unknown): boolean {
	return error instanceof AntigravityAcpError ? error.code === "aborted" : error instanceof DOMException && error.name === "AbortError";
}
