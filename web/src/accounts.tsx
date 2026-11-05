// The accounts: the Claude token, the ChatGPT login and the other providers with API keys (on the first screen and in
// the settings), and the Figma token.

import type { AuthPrompt, CredentialStore, Provider } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { Button, ChevronDownIcon, Combobox, Input, Paragraph, Text } from "figma-kit";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

const CHATGPT_ID = "openai-codex";

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
	// The other providers of the models: pi-ai's providers with an API key (agent.ts).
	const others = props.models.getProviders().filter((provider) => provider.id !== CLAUDE.id && provider.id !== CHATGPT_ID);
	// FigPal needs one model account: without any, Claude and ChatGPT say so in red.
	const required = !props.models.getProviders().some((provider) => props.connected.has(provider.id));
	return (
		<div className="flex flex-col gap-5">
			<TokenAccount {...props} kind={CLAUDE} required={required} />
			<ChatGptAccount {...props} required={required} />
			{others
				.filter((provider) => props.connected.has(provider.id))
				.map((provider) => (
					<KeyAccount key={provider.id} provider={provider} {...props} />
				))}
			<AddProvider providers={others.filter((provider) => !props.connected.has(provider.id))} {...props} />
		</div>
	);
}

/** A provider with a saved API key. */
function KeyAccount({ provider, credentials, onChange }: Pick<AccountsProps, "credentials" | "onChange"> & { provider: Provider }) {
	const [error, setError] = useState<string>();
	return (
		<Account name={provider.name} status={status(true, ["Connected", "Not connected"])}>
			<div className="flex gap-2">
				<Button onClick={() => credentials.delete(provider.id).then(onChange, (reason) => setError(errorText(reason)))}>Remove</Button>
			</div>
			{error && <Text className="text-danger">{error}</Text>}
		</Account>
	);
}

type ProviderOption = { value: string; label: string };

/** The other providers: a search in the list, then pi-ai's setup of the chosen one. */
function AddProvider({ providers, models, onChange }: Pick<AccountsProps, "models" | "onChange"> & { providers: Provider[] }) {
	const [chosen, setChosen] = useState<Provider>();
	if (chosen)
		return (
			<KeySetup
				provider={chosen}
				models={models}
				onEnd={(saved) => {
					setChosen(undefined);
					if (saved) onChange();
				}}
			/>
		);
	const options = providers.map((provider): ProviderOption => ({ value: provider.id, label: provider.name })).sort((a, b) => a.label.localeCompare(b.label));
	return (
		<section className="flex flex-col gap-2">
			<Text weight="strong">Other providers</Text>
			<Text className="text-secondary">Use an API key of another provider. The provider bills you for what you use.</Text>
			<Combobox.Root
				items={options}
				value={null}
				onValueChange={(option: ProviderOption | null) => setChosen(providers.find((provider) => provider.id === option?.value))}
			>
				<Combobox.Trigger aria-label="Add a provider" className="self-start">
					<Combobox.Value>{() => "Add a provider"}</Combobox.Value>
					<Combobox.Icon>
						<ChevronDownIcon />
					</Combobox.Icon>
				</Combobox.Trigger>
				<Combobox.Portal>
					<Combobox.Positioner>
						<Combobox.Popup>
							<Combobox.InputGroup>
								<Combobox.SearchInput aria-label="Search providers" placeholder="Search providers" />
							</Combobox.InputGroup>
							<Combobox.Empty>No providers found.</Combobox.Empty>
							<Combobox.List>
								{(option: ProviderOption) => (
									<Combobox.Item key={option.value} value={option}>
										{option.label}
									</Combobox.Item>
								)}
							</Combobox.List>
						</Combobox.Popup>
					</Combobox.Positioner>
				</Combobox.Portal>
			</Combobox.Root>
		</section>
	);
}

type Question = { prompt: AuthPrompt; answer(value: string): void };

/**
 * pi-ai's setup of a provider (`models.login`): it asks its questions one at a time, for example the key, then an
 * account ID. pi-ai saves the key at the end. `onEnd(true)` after the save, `onEnd(false)` after Cancel.
 */
function KeySetup({ provider, models, onEnd }: { provider: Provider; models: Models; onEnd(saved: boolean): void }) {
	const [question, setQuestion] = useState<Question>();
	const [value, setValue] = useState("");
	const [error, setError] = useState<string>();
	const [controller] = useState(() => new AbortController());
	const end = useRef(onEnd);
	end.current = onEnd;

	useEffect(() => {
		const { signal } = controller;
		models
			.login(provider.id, "api_key", {
				signal,
				prompt: (prompt) =>
					new Promise((resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason));
						setValue("");
						setQuestion({ prompt, answer: resolve });
					}),
				notify: () => {},
			})
			.then(
				() => end.current(true),
				(reason) => {
					if (!signal.aborted) setError(errorText(reason));
				},
			);
		return () => controller.abort();
	}, [provider, models, controller]);

	const cancel = () => {
		controller.abort();
		onEnd(false);
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		// A key copied from a web page can have spaces at its ends.
		question?.answer(value.trim());
	};
	const prompt = question?.prompt;
	return (
		<Account name={provider.name} status={status(false, ["Connected", "Not connected"])}>
			{prompt?.type === "select" ? (
				<>
					<Paragraph>{prompt.message}</Paragraph>
					<div className="flex flex-wrap gap-2">
						{prompt.options.map((option) => (
							<Button key={option.id} onClick={() => question!.answer(option.id)}>
								{option.label}
							</Button>
						))}
						<Button onClick={cancel}>Cancel</Button>
					</div>
				</>
			) : (
				<form className="flex flex-col gap-2" onSubmit={submit}>
					{prompt && <Paragraph>{prompt.message}</Paragraph>}
					<Input
						key={prompt?.message}
						type={prompt?.type === "secret" ? "password" : "text"}
						aria-label={prompt?.message ?? provider.name}
						placeholder={prompt?.placeholder}
						value={value}
						disabled={!prompt}
						autoFocus
						onChange={(event) => setValue(event.target.value)}
					/>
					<div className="flex justify-end gap-2">
						<Button type="button" onClick={cancel}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={!value.trim()}>
							Continue
						</Button>
					</div>
				</form>
			)}
			{error && <Text className="text-danger">{error}</Text>}
		</Account>
	);
}

/** Green when on; grey when off and nothing is wrong; red when FigPal cannot work without it. */
export type Status = { text: string; tone: "on" | "off" | "problem" };
const TONE_CLASS = { on: "text-success", off: "text-secondary", problem: "text-danger" } as const;

/** The status of a part that is on or off. */
export const status = (on: boolean, texts: [on: string, off: string], required = false): Status => ({
	text: on ? texts[0] : texts[1],
	tone: on ? "on" : required ? "problem" : "off",
});

export function Account({ name, status, children }: { name: string; status?: Status; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between">
				<Text weight="strong">{name}</Text>
				{status && <Text className={TONE_CLASS[status.tone]}>{status.text}</Text>}
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
			In Terminal, run <code>claude setup-token</code>. Then paste the token here. An Anthropic API key also works.
		</>
	),
};

/** For the Figma REST tools. Not a model provider: pi-ai does not read it. */
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
	required,
}: Pick<AccountsProps, "connected" | "credentials" | "onChange"> & { kind: TokenKind; required?: boolean }) {
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
			<Account name={kind.title ?? kind.name} status={status(true, ["Connected", "Not connected"])}>
				<div className="flex gap-2">
					<Button onClick={() => setEditing(true)}>Change token</Button>
					<Button onClick={remove}>Remove</Button>
				</div>
				{error && <Text className="text-danger">{error}</Text>}
			</Account>
		);
	return (
		<Account name={kind.title ?? kind.name} status={status(false, ["Connected", "Not connected"], required)}>
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
				aria-label={kind.title ?? `${kind.name} token`}
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

function ChatGptAccount({ connected, models, credentials, openExternal, onChange, required }: AccountsProps & { required: boolean }) {
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
			.login(CHATGPT_ID, "oauth", {
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
	const signOut = () => credentials.delete(CHATGPT_ID).then(onChange, (reason) => setError(errorText(reason)));

	if (connected.has(CHATGPT_ID))
		return (
			<Account name="ChatGPT" status={status(true, ["Signed in", "Not signed in"])}>
				<div className="flex gap-2">
					<Button onClick={signOut}>Sign out</Button>
				</div>
				{error && <Text className="text-danger">{error}</Text>}
			</Account>
		);
	return (
		<Account name="ChatGPT" status={status(false, ["Signed in", "Not signed in"], required)}>
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
