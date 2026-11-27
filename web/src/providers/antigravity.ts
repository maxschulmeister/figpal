// Google Antigravity, through its ACP server in the FigPal command (local/antigravity/). The command signs in with
// Google and keeps the login: FigPal keeps only a marker. The model requests use pi-ai's "pi-messages" client, and the
// command answers them with Antigravity, which uses FigPal's tools.

import type { CredentialStore, Model, OAuthCredential, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { ANTIGRAVITY_ROUTE } from "@figpal/shared/routes";

export const ANTIGRAVITY_ID = "antigravity-acp";

/** The events of a server-sent event stream: one JSON object in each. */
async function* events(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.ok || !response.body) throw new Error(`The FigPal command did not answer (${response.status}): ${await response.text()}`);
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let text = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return;
		const blocks = (text + value).split("\n\n");
		text = blocks.pop()!;
		for (const block of blocks) if (block.startsWith("data: ")) yield JSON.parse(block.slice("data: ".length));
	}
}

/** The command installs Antigravity if needed, then gives the Google page: the UI opens it. */
async function login(base: string, { notify, signal }: ProviderAuthInteraction): Promise<OAuthCredential> {
	for await (const event of events(await fetch(`${base}/login`, { method: "POST", signal }))) {
		if (event.type === "progress" && typeof event.message === "string") notify({ type: "progress", message: event.message });
		else if (event.type === "auth_url" && typeof event.url === "string") notify({ type: "auth_url", url: event.url });
		else if (event.type === "error") throw new Error(String(event.message));
		else if (event.type === "done" && typeof event.marker === "string")
			return { type: "oauth", access: event.marker, refresh: event.marker, expires: Number.MAX_SAFE_INTEGER };
	}
	throw new Error("The sign-in to Antigravity stopped. Try again.");
}

export function antigravityProvider(origin: string): Provider {
	const base = `${origin}${ANTIGRAVITY_ROUTE}`;
	const streams = piMessagesApi();
	let models: Model<"pi-messages">[] = [];
	// The command lists the models with its own API name; FigPal sends their requests to the route.
	const toModel = (model: Model<string>): Model<"pi-messages"> => ({ ...model, api: "pi-messages", provider: ANTIGRAVITY_ID, baseUrl: base });
	return {
		id: ANTIGRAVITY_ID,
		name: "Google Antigravity",
		auth: {
			oauth: {
				name: "Google Antigravity",
				loginLabel: "Sign in with Google",
				isSubscription: true,
				login: (interaction) => login(base, interaction),
				// The command keeps the Google token fresh.
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => models,
		async refreshModels(context) {
			const stored = context.stored?.models.filter((model): model is Model<string> => model.provider === ANTIGRAVITY_ID);
			if (stored?.length && !(await context.publish({ update: () => (models = stored.map(toModel)) }))) return;
			if (!context.allowNetwork || context.credential?.type !== "oauth") return;
			const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${context.credential.access}` }, signal: context.signal });
			if (!response.ok) throw new Error(`The FigPal command could not list the Antigravity models (${response.status}): ${await response.text()}`);
			const listed = ((await response.json()) as Model<string>[]).map(toModel);
			await context.publish({ persist: { models: listed, checkedAt: Date.now() }, update: () => (models = listed) });
		},
		stream: streams.stream,
		streamSimple: streams.streamSimple,
	};
}

/** The command forgets the Google login (and stops Antigravity), and FigPal the marker. */
export async function signOutOfAntigravity(origin: string, credentials: Pick<CredentialStore, "delete">): Promise<void> {
	const response = await fetch(`${origin}${ANTIGRAVITY_ROUTE}/logout`, { method: "POST" });
	if (!response.ok) throw new Error(`The FigPal command could not sign out of Antigravity (${response.status}).`);
	await credentials.delete(ANTIGRAVITY_ID);
}
