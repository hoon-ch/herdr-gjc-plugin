import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import registerStartup, {
	herdrGjc,
	herdrRequest,
	type HerdrHookApi,
	type HerdrHookHandler,
	visibleLooksWorking,
} from "../hooks/startup";
import registerBlocked from "../hooks/blocked";
import registerIdle from "../hooks/idle";
import registerShutdown from "../hooks/shutdown";
import registerUnblock from "../hooks/unblock";
import registerWorking from "../hooks/working";

type Request = {
	method: string;
	params: Record<string, unknown>;
};
type ResponseHandler = (request: Request & { id: string }, socket: Socket) => boolean;

function sendResponse(
	socket: Socket,
	id: string,
	body: { result?: Record<string, unknown>; error?: Record<string, unknown> },
): boolean {
	socket.end(`${JSON.stringify({ id, ...body })}\n`);
	return true;
}

function registeredHandler(register: (api: HerdrHookApi) => void): HerdrHookHandler {
	let handler: HerdrHookHandler | undefined;
	register({
		on(_event, registered) {
			handler = registered;
		},
	});
	if (!handler) throw new Error("hook did not register a handler");
	return handler;
}

const originalEnv = {
	HERDR_ENV: process.env.HERDR_ENV,
	HERDR_PANE_ID: process.env.HERDR_PANE_ID,
	HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
	HERDR_GJC_HEARTBEAT_MS: process.env.HERDR_GJC_HEARTBEAT_MS,
};

let server: Server | undefined;
let socketDirectory: string | undefined;

function resetReporter(): void {
	const g = globalThis as unknown as { __herdrGjc?: ReturnType<typeof herdrGjc> };
	g.__herdrGjc?.stop();
	delete g.__herdrGjc;
}

async function startServer(readDelayMs = 0, responseHandler?: ResponseHandler): Promise<Request[]> {
	const requests: Request[] = [];
	socketDirectory = await mkdtemp(join(tmpdir(), "herdr-gjc-test-"));
	const socketPath = join(socketDirectory, "herdr.sock");
	server = createServer(socket => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline)) as Request & { id: string };
			requests.push(request);
			if (responseHandler?.(request, socket)) return;
			let result: Record<string, unknown> = {};
			if (request.method === "pane.read") {
				result = { read: { text: "◆ hud idle\n> Type your message..." } };
			} else if (request.method === "pane.get") {
				result = {
					pane: {
						pane_id: request.params.pane_id,
						terminal_id: "test-terminal",
					},
				};
			} else if (request.method === "pane.list") {
				result = {
					panes: [
						{
							pane_id: "test-pane",
							terminal_id: "test-terminal",
						},
					],
				};
			}
			const response = { id: request.id, result };
			setTimeout(() => socket.end(`${JSON.stringify(response)}\n`), request.method === "pane.read" ? readDelayMs : 0);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server?.once("error", reject);
		server?.listen(socketPath, resolve);
	});
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "test-pane";
	process.env.HERDR_SOCKET_PATH = socketPath;
	process.env.HERDR_GJC_HEARTBEAT_MS = "60000";
	return requests;
}

async function wait(ms: number): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(async () => {
	resetReporter();
	if (server) await new Promise<void>(resolve => server?.close(() => resolve()));
	if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
	server = undefined;
	socketDirectory = undefined;
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("herdrRequest", () => {
	test("rejects a response whose request ID does not match", async () => {
		await startServer(0, (_request, socket) => {
			socket.end(`${JSON.stringify({ id: "wrong-id", result: {} })}\n`);
			return true;
		});

		await expect(herdrRequest("pane.report_agent", {})).rejects.toThrow("mismatched response");
	});

	test("accepts a matching response split across socket chunks", async () => {
		await startServer(0, (request, socket) => {
			const response = `${JSON.stringify({ id: request.id, result: {} })}\n`;
			const midpoint = Math.floor(response.length / 2);
			socket.write(response.slice(0, midpoint));
			setTimeout(() => socket.end(response.slice(midpoint)), 5);
			return true;
		});

		await expect(herdrRequest("pane.report_agent", {})).resolves.toEqual(expect.objectContaining({ result: {} }));
	});
});
describe("visibleLooksWorking", () => {
	test("recognizes an active spinner near the prompt", () => {
		expect(visibleLooksWorking("⠸ Awaiting revised roadmap plan ⟦esc⟧\n◆ hud\n⬢ model\n╭─╮\n│ > prompt │\n╰─╯\n")).toBe(true);
	});

	test("ignores idle prompts, stale token rates, and old activity", () => {
		expect(visibleLooksWorking("◆ hud idle\n╭─╮\n│ > prompt │\n╰─╯\n")).toBe(false);
		expect(
			visibleLooksWorking(
				"⬢ GPT-5.6-Sol · ◒ med · 13.1% / 📁 …/a-eyes-cloud / ⤴ 40.0/s / $0.63 (sub)\n╭─╮\n│ > Type your message... │\n╰─╯\n",
			),
		).toBe(false);
		expect(visibleLooksWorking("⠸ Old activity\n1\n2\n3\n4\n5\n6\nidle prompt\n")).toBe(false);
	});
});

describe("session scope", () => {
	test("ignores every lifecycle event emitted by in-process subagents", async () => {
		const requests = await startServer();
		const context = { sessionMetadata: { kind: "sub" as const } };
		for (const register of [
			registerStartup,
			registerWorking,
			registerIdle,
			registerBlocked,
			registerUnblock,
			registerShutdown,
		]) {
			await registeredHandler(register)({ type: "test" }, context);
		}
		await wait(20);

		expect(requests).toHaveLength(0);
	});

	test("only top-level shutdown releases the shared pane reporter", async () => {
		const requests = await startServer();
		const mainContext = { sessionMetadata: { kind: "main" as const } };
		const subContext = { sessionMetadata: { kind: "sub" as const } };
		const working = registeredHandler(registerWorking);
		const shutdown = registeredHandler(registerShutdown);

		await working({ type: "agent_start" }, mainContext);
		await wait(20);
		await shutdown({ type: "session_shutdown" }, subContext);
		await wait(20);

		expect(herdrGjc().released).toBe(false);
		expect(requests.some(request => request.method === "pane.release_agent")).toBe(false);

		await shutdown({ type: "session_shutdown" }, mainContext);
		await shutdown({ type: "session_shutdown" }, mainContext);

		expect(requests.filter(request => request.method === "pane.release_agent")).toHaveLength(1);
	});

});
describe("report ordering", () => {
	test("does not let a delayed idle inspection override a newer working state", async () => {
		const requests = await startServer(60);
		const reporter = herdrGjc();
		reporter.report("idle", undefined, { burst: false });
		await wait(10);
		reporter.report("working", undefined, { burst: false });
		await wait(100);

		const reports = requests.filter(request => request.method === "pane.report_agent");
		expect(reports.length).toBeGreaterThanOrEqual(1);
		expect(reports.every(request => request.params.state === "working")).toBe(true);
	});
	test("discards an older idle inspection after a newer idle revision", async () => {
		let readCount = 0;
		const requests = await startServer(0, (request, socket) => {
			if (request.method !== "pane.read") return false;
			readCount += 1;
			const text = readCount === 2 ? "⠸ Active work\n> prompt" : "> idle prompt";
			const delay = readCount === 1 ? 80 : 20;
			setTimeout(
				() => socket.end(`${JSON.stringify({ id: request.id, result: { read: { text } } })}\n`),
				delay,
			);
			return true;
		});
		const reporter = herdrGjc();
		reporter.report("idle", undefined, { burst: false });
		await wait(5);
		reporter.report("idle", undefined, { burst: false });
		await wait(120);

		const reports = requests.filter(request => request.method === "pane.report_agent");
		expect(reports).toHaveLength(1);
		expect(reports[0]?.params.state).toBe("working");
	});

	test("does not resurrect the agent after release during pane inspection", async () => {
		const requests = await startServer(60);
		const reporter = herdrGjc();
		reporter.report("idle", undefined, { burst: false });
		await wait(10);
		await reporter.release();
		await wait(100);

		expect(requests.some(request => request.method === "pane.release_agent")).toBe(true);
		expect(requests.some(request => request.method === "pane.report_agent")).toBe(false);
	});
});

describe("space binding", () => {
	test("follows the terminal when its pane moves between spaces", async () => {
		let moved = false;
		const requests = await startServer(0, (request, socket) => {
			if (request.method === "pane.get") {
				return sendResponse(
					socket,
					request.id,
					moved
						? { error: { code: "pane_not_found", message: "pane moved" } }
						: {
								result: {
									pane: {
										pane_id: "test-pane",
										terminal_id: "terminal-123",
									},
								},
							},
				);
			}
			if (request.method === "pane.list") {
				return sendResponse(socket, request.id, {
					result: {
						panes: [
							{
								pane_id: "moved-pane",
								terminal_id: "terminal-123",
							},
						],
					},
				});
			}
			return false;
		});
		const reporter = herdrGjc();

		reporter.report("working", undefined, { burst: false });
		await wait(20);
		moved = true;
		reporter.report("blocked", "waiting", { burst: false });
		await wait(20);

		const reports = requests.filter(request => request.method === "pane.report_agent");
		expect(reports[0]?.params.pane_id).toBe("test-pane");
		expect(reports.at(-1)?.params.pane_id).toBe("moved-pane");
	});

	test("never reports to a stale pane when the terminal cannot be resolved", async () => {
		let detached = false;
		const requests = await startServer(0, (request, socket) => {
			if (request.method === "pane.get") {
				return sendResponse(
					socket,
					request.id,
					detached
						? { error: { code: "pane_not_found", message: "pane detached" } }
						: {
								result: {
									pane: {
										pane_id: "test-pane",
										terminal_id: "terminal-123",
									},
								},
							},
				);
			}
			if (request.method === "pane.list") {
				return sendResponse(socket, request.id, {
					result: {
						panes: [
							{
								pane_id: "reused-pane",
								terminal_id: "different-terminal",
							},
						],
					},
				});
			}
			return false;
		});
		const reporter = herdrGjc();

		reporter.report("working", undefined, { burst: false });
		await wait(20);
		detached = true;
		reporter.report("blocked", "waiting", { burst: false });
		await wait(20);

		const reports = requests.filter(request => request.method === "pane.report_agent");
		expect(reports).toHaveLength(1);
		expect(reports[0]?.params).toEqual(
			expect.objectContaining({
				pane_id: "test-pane",
				state: "working",
			}),
		);
	});
});
