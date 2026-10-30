import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAsServer, USER_AGENT_HEADER } from "./anthropic-route";

afterEach(() => vi.unstubAllGlobals());

function captureFetch() {
	const calls: { input: unknown; headers: Headers }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			calls.push({ input, headers: new Headers(init?.headers) });
			return new Response("{}");
		}),
	);
	return calls;
}

describe("fetchAsServer", () => {
	it("copies the user-agent to the header that the route reads", async () => {
		const calls = captureFetch();
		await fetchAsServer("http://localhost:5173/api/anthropic/v1/messages", {
			method: "POST",
			headers: { "user-agent": "claude-cli/2.1.280 (external, sdk-cli)", "x-app": "cli" },
			body: "{}",
		});
		expect(calls[0]!.input).toBe("http://localhost:5173/api/anthropic/v1/messages");
		expect(calls[0]!.headers.get(USER_AGENT_HEADER)).toBe("claude-cli/2.1.280 (external, sdk-cli)");
		expect(calls[0]!.headers.get("x-app")).toBe("cli");
	});

	it("keeps the headers of a Request input", async () => {
		const calls = captureFetch();
		await fetchAsServer(new Request("http://localhost/x", { headers: { "user-agent": "claude-cli/1" } }));
		expect(calls[0]!.headers.get(USER_AGENT_HEADER)).toBe("claude-cli/1");
	});

	it("adds nothing without a user-agent", async () => {
		const calls = captureFetch();
		await fetchAsServer("http://localhost/x", { headers: { "x-app": "cli" } });
		expect(calls[0]!.headers.has(USER_AGENT_HEADER)).toBe(false);
	});

	it("replaces the browser platform headers of the Anthropic SDK with the Node values", async () => {
		const calls = captureFetch();
		await fetchAsServer("http://localhost/x", {
			headers: {
				"x-stainless-runtime": "browser:chrome",
				"x-stainless-runtime-version": "150.0.7871.250",
				"x-stainless-os": "Unknown",
				"x-stainless-arch": "unknown",
				"x-stainless-lang": "js",
			},
		});
		const headers = calls[0]!.headers;
		expect(headers.get("x-stainless-runtime")).toBe("node");
		expect(headers.get("x-stainless-runtime-version")).toMatch(/^v\d+\./);
		expect(headers.get("x-stainless-os")).toBe("MacOS");
		expect(headers.get("x-stainless-arch")).toBe("arm64");
		expect(headers.get("x-stainless-lang")).toBe("js");
	});
});
