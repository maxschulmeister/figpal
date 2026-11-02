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
afterEach(() => stop?.());

function start(allowAgents = false) {
	const sockets: FakeSocket[] = [];
	const states: LocalState[] = [];
	const bridge = {
		request: vi.fn(async () => ({ result: { value: "1" }, attachments: [{ name: "a.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }] })),
	};
	const local = connectLocal({
		bridge: bridge as never,
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
	return { local, sockets, states, bridge };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("local helper connection", () => {
	it("tries each port, and knows the shared folders of the helpers that answer", async () => {
		const { sockets, states } = start();
		expect(sockets.map((socket) => socket.url)).toEqual(["ws://127.0.0.1:9300", "ws://127.0.0.1:9301"]);
		sockets[0]!.receive({ kind: "hello", folders: ["project"], agent: false });
		expect(states.at(-1)).toEqual({ folders: ["project"], agent: false });
		sockets[0]!.close();
		expect(states.at(-1)).toEqual({ folders: [], agent: false });
	});

	it("sends a file request to the helper of its folder", async () => {
		const { local, sockets } = start();
		sockets[1]!.receive({ kind: "hello", folders: ["project"], agent: false });
		const read = local.files({ op: "read", path: "project/a.txt" });
		const request = sockets[1]!.sent[0]!;
		expect(request).toMatchObject({ kind: "files", request: { op: "read", path: "project/a.txt" } });
		sockets[1]!.receive({ kind: "response", id: request.id, ok: true, result: "hello" });
		expect(await read).toBe("hello");
		expect(await local.files({ op: "list", path: "" })).toEqual(["project/"]);
		await expect(local.files({ op: "read", path: "other/a.txt" })).rejects.toThrow('No shared folder is named "other"');
	});

	// An outside agent can run code in the file: only when the user allows it.
	it("refuses the requests of an outside agent unless the user allows them", async () => {
		const { sockets, bridge } = start(false);
		sockets[0]!.receive({ kind: "hello", folders: [], agent: true });
		sockets[0]!.receive({ kind: "request", id: "7", type: "execute", params: { code: "return 1" } });
		await flush();
		expect(bridge.request).not.toHaveBeenCalled();
		expect(sockets[0]!.sent).toEqual([{ kind: "response", id: "7", ok: false, error: expect.stringContaining("Settings → Access") }]);
	});

	it("runs the allowed requests of an outside agent in code.js", async () => {
		const { sockets, bridge } = start(true);
		sockets[0]!.receive({ kind: "hello", folders: [], agent: true });
		sockets[0]!.receive({ kind: "request", id: "7", type: "execute", params: { code: "return 1" } });
		await flush();
		expect(bridge.request).toHaveBeenCalledWith("execute", { code: "return 1" });
		expect(sockets[0]!.sent).toEqual([
			{ kind: "response", id: "7", ok: true, result: { value: "1" }, attachments: [{ name: "a.png", mime: "image/png", data: "AQID" }] },
		]);
	});
});
