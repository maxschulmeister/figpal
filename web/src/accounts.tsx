// The accounts: the Claude token and the ChatGPT login (on the first screen and in the settings), and the Figma token.

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { Button, Input, Paragraph, Text } from "figma-kit";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type AccountsProps = {
	/** Provider IDs with a saved credential. */
	connected: ReadonlySet<string>;
	models: Models;
	credentials: CredentialStore;
	openExternal(url: string): void;
	/** A credential was saved or removed. */
	onChange(): void;
};

export function Accounts(props: AccountsProps) {
	return (
		<div className="flex flex-col gap-5">
			<TokenAccount {...props} kind={CLAUDE} />
			<ChatGptAccount {...props} />
		</div>
	);
}

function Account({ name, status, children }: { name: string; status?: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between">
				<Text weight="strong">{name}</Text>
				{status && <Text className="text-secondary">{status}</Text>}
			</div>
			{children}
		</section>
	);
}

/** A token that the user pastes. `title` is the heading, if it is not the name. */
type TokenKind = { id: string; name: string; title?: string; prefix: string; placeholder: string; help: ReactNode };

const CLAUDE: TokenKind = {
	id: "anthropic",
	name: "Claude",
	prefix: "sk-ant-",
	placeholder: "sk-ant-oat01-…",
	help: (
		<>
			In Terminal, run <code>claude setup-token</code>. Then paste the token here.
		</>
	),
};

/** For figma_rest. Not a model provider: pi-ai does not read it. */
export const FIGMA: TokenKind = {
	id: "figma",
	name: "Figma",
	title: "Personal access token",
	prefix: "figd_",
	placeholder: "figd_…",
	help: "FigPal uses it for comments, versions and libraries. In Figma, open Settings → Security and generate a token. Read-only scopes are enough for most tasks.",
};

export function TokenAccount({
	kind,
	connected,
	credentials,
	onChange,
}: Pick<AccountsProps, "connected" | "credentials" | "onChange"> & { kind: TokenKind }) {
	const [editing, setEditing] = useState(false);
	const [error, setError] = useState<string>();
	const isConnected = connected.has(kind.id);

	const save = async (token: string) => {
		await credentials.modify(kind.id, async () => ({ type: "api_key", key: token }));
		setEditing(false);
		onChange();
	};
	const remove = () => credentials.delete(kind.id).then(onChange, (reason) => setError(errorText(reason)));

	if (isConnected && !editing)
		return (
			<Account name={kind.title ?? kind.name} status="Connected">
				<div className="flex gap-2">
					<Button onClick={() => setEditing(true)}>Change token</Button>
					<Button onClick={remove}>Remove</Button>
				</div>
				{error && <Text className="text-danger">{error}</Text>}
			</Account>
		);
	return (
		<Account name={kind.title ?? kind.name}>
			<TokenForm kind={kind} onSave={save} onCancel={isConnected ? () => setEditing(false) : undefined} />
		</Account>
	);
}

function TokenForm({ kind, onSave, onCancel }: { kind: TokenKind; onSave(token: string): Promise<void>; onCancel?(): void }) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string>();

	const submit = (event: FormEvent) => {
		event.preventDefault();
		// A token copied from Terminal can contain line breaks. Tokens never contain white space.
		const token = value.replace(/\s+/g, "");
		if (!token.startsWith(kind.prefix)) {
			setError(`This is not a ${kind.name} token. It starts with ${kind.prefix}.`);
			return;
		}
		onSave(token).catch((reason) => setError(errorText(reason)));
	};

	return (
		<form className="flex flex-col gap-2" onSubmit={submit}>
			<Paragraph>{kind.help}</Paragraph>
			<Input
				type="password"
				aria-label={`${kind.name} token`}
				placeholder={kind.placeholder}
				value={value}
				onChange={(event) => {
					setValue(event.target.value);
					setError(undefined);
				}}
			/>
			{error && <Text className="text-danger">{error}</Text>}
			<div className="flex justify-end gap-2">
				{onCancel && (
					<Button type="button" onClick={onCancel}>
						Cancel
					</Button>
				)}
				<Button type="submit" variant="primary" disabled={!value.trim()}>
					Save
				</Button>
			</div>
		</form>
	);
}

type Login = { code?: string; url?: string; controller: AbortController };

function ChatGptAccount({ connected, models, credentials, openExternal, onChange }: AccountsProps) {
	const [login, setLogin] = useState<Login>();
	const [error, setError] = useState<string>();
	// Closing the settings stops the login. Without this, it polls OpenAI for up to 15 minutes.
	const controller = login?.controller;
	useEffect(() => () => controller?.abort(), [controller]);

	const signIn = () => {
		const current: Login = { controller: new AbortController() };
		setLogin(current);
		setError(undefined);
		models
			.login("openai-codex", "oauth", {
				signal: current.controller.signal,
				prompt: () => Promise.reject(new Error("Not supported")),
				notify: (event) => {
					if (event.type !== "device_code") return;
					setLogin({ ...current, code: event.userCode, url: event.verificationUri });
					openExternal(event.verificationUri);
				},
			})
			.then(onChange, (reason) => {
				if (!current.controller.signal.aborted) setError(errorText(reason));
			})
			.finally(() => setLogin(undefined));
	};
	const signOut = () => credentials.delete("openai-codex").then(onChange, (reason) => setError(errorText(reason)));

	if (connected.has("openai-codex"))
		return (
			<Account name="ChatGPT" status="Signed in">
				<div className="flex gap-2">
					<Button onClick={signOut}>Sign out</Button>
				</div>
				{error && <Text className="text-danger">{error}</Text>}
			</Account>
		);
	return (
		<Account name="ChatGPT">
			{login ? (
				<>
					<Paragraph>
						{login.code ? (
							<>
								On the page that opened, enter the code <strong className="select-all">{login.code}</strong>.
							</>
						) : (
							"Starting the login…"
						)}
					</Paragraph>
					<div className="flex gap-2">
						{login.url && <Button onClick={() => openExternal(login.url!)}>Open the page again</Button>}
						<Button onClick={() => login.controller.abort()}>Cancel</Button>
					</div>
				</>
			) : (
				<>
					<Paragraph>Use your ChatGPT plan.</Paragraph>
					<div className="flex gap-2">
						<Button onClick={signIn}>Sign in with ChatGPT</Button>
					</div>
				</>
			)}
			{error && <Text className="text-danger">{error}</Text>}
		</Account>
	);
}
