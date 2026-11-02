import { afterEach, describe, expect, it, vi } from "vitest";
import { connectLocal, type LocalState } from "./local";

/** A fake WebSocket to a helper: the test sends its messages, and keeps the messages of FigPal. */
class FakeSocket extends EventTarget {
	readonly sent: Record<string, unknown>[] = [];
	readonly url: string;
	constructor(url: string) {
		super();
		this.url = url;
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.dispatchEvent(new Event("close"));
	}
	receive(message: object) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
	}
}

let stop: (() => void) | undefined;
afterEach(() => {
	stop?.();
	vi.unstubAllGlobals();
});

const HELLO = { kind: "hello", folders: [], manage: false, home: false };
const NONE: LocalState = { folders: [], manage: false, home: false };

function start(allowAgents = false) {
	const sockets: FakeSocket[] = [];
	const states: LocalState[] = [];
	// The window: FigPal looks for helpers again when it gets the focus.
	const focus = new EventTarget();
	vi.stubGlobal("addEventListener", focus.addEventListener.bind(focus));
	vi.stubGlobal("removeEventListener", focus.removeEventListener.bind(focus));
	const bridge = {
		request: vi.fn(async () => ({ result: { value: "1" }, attachments: [{ name: "a.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }] })),
	};
	const local = connectLocal({
		bridge: bridge as never,
		file: "Cards",
		allowAgents: () => allowAgents,
		onChange: (state) => states.push(state),
		ports: [9300, 9301],
		open: (url) => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket as unknown as WebSocket;
		},
	});
	stop = local.stop;
	return { local, sockets, states, bridge, focus };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const responses = (socket: FakeSocket) => socket.sent.filter((message) => message.kind === "response");

describe("local helper connection", () => {
	it("tries each port, knows the helpers that answer, and tells them the file", async () => {
		const { sockets, states } = start();
		expect(sockets.map((socket) => socket.url)).toEqual(["ws://127.0.0.1:9300", "ws://127.0.0.1:9301"]);
		sockets[0]!.receive({ ...HELLO, folders: ["project"], manage: true });
		expect(sockets[0]!.sent).toEqual([{ kind: "window", file: "Cards" }]);
		expect(states.at(-1)).toEqual({ folders: ["project"], manage: true, home: false });
		sockets[0]!.close();
		expect(states.at(-1)).toEqual(NONE);
	});

	// The helper can start after FigPal: FigPal looks again when the user comes back to the window.
	it("looks for helpers again when the window gets the focus", () => {
		const { sockets, focus } = start();
		sockets[0]!.close();
		focus.dispatchEvent(new Event("focus"));
		expect(sockets.map((socket) => socket.url)).toEqual(["ws://127.0.0.1:9300", "ws://127.0.0.1:9301", "ws://127.0.0.1:9300"]);
	});

	it("sends a file request to the helper of its folder", async () => {
		const { local, sockets } = start();
		sockets[1]!.receive({ ...HELLO, folders: ["project"] });
		const read = local.files({ op: "read", path: "project/a.txt" });
		const request = sockets[1]!.sent.at(-1)!;
		expect(request).toMatchObject({ kind: "files", request: { op: "read", path: "project/a.txt" } });
		sockets[1]!.receive({ kind: "response", id: request.id, ok: true, result: "hello" });
		expect(await read).toBe("hello");
		expect(await local.files({ op: "list", path: "" })).toEqual(["project/"]);
		await expect(local.files({ op: "read", path: "other/a.txt" })).rejects.toThrow('No shared folder is named "other"');
	});

	it("sends a change of the folders to the helper that keeps them", async () => {
		const { local, sockets } = start();
		await expect(local.changeFolders({ op: "add" })).rejects.toThrow("pnpm local:install");
		sockets[0]!.receive(HELLO);
		sockets[1]!.receive({ ...HELLO, manage: true });
		const adding = local.changeFolders({ op: "add" });
		const request = sockets[1]!.sent.at(-1)!;
		expect(request).toMatchObject({ kind: "folders", change: { op: "add" } });
		sockets[1]!.receive({ kind: "response", id: request.id, ok: true, result: null });
		await adding;
		// The new folders come with the next hello.
		sockets[1]!.receive({ ...HELLO, manage: true, folders: ["design"] });
		await expect(local.files({ op: "list", path: "" })).resolves.toEqual(["design/"]);
	});

	// An outside agent can run code in the file: only when the user allows it.
	it("refuses the requests of an outside agent unless the user allows them", async () => {
		const { sockets, bridge } = start(false);
		sockets[0]!.receive(HELLO);
		sockets[0]!.receive({ kind: "request", id: "7", type: "execute", params: { code: "return 1" } });
		await flush();
		expect(bridge.request).not.toHaveBeenCalled();
		expect(responses(sockets[0]!)).toEqual([{ kind: "response", id: "7", ok: false, error: expect.stringContaining("Settings → Access") }]);
	});

	it("runs the allowed requests of an outside agent in code.js", async () => {
		const { sockets, bridge } = start(true);
		sockets[0]!.receive(HELLO);
		sockets[0]!.receive({ kind: "request", id: "7", type: "execute", params: { code: "return 1" } });
		await flush();
		expect(bridge.request).toHaveBeenCalledWith("execute", { code: "return 1" });
		expect(responses(sockets[0]!)).toEqual([
			{ kind: "response", id: "7", ok: true, result: { value: "1" }, attachments: [{ name: "a.png", mime: "image/png", data: "AQID" }] },
		]);
	});
});
