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
} from "../hooks/startup";
import registerBlocked from "../hooks/blocked";
import registerIdle from "../hooks/idle";
import registerShutdown from "../hooks/shutdown";
import registerUnblock from "../hooks/unblock";
import registerWorking from "../hooks/working";
import registerTurn from "../hooks/turn";

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

async function startServer(responseHandler?: ResponseHandler): Promise<Request[]> {
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
			if (request.method === "pane.get") {
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
			setTimeout(() => socket.end(`${JSON.stringify(response)}\n`), 0);
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
		await startServer((_request, socket) => {
			socket.end(`${JSON.stringify({ id: "wrong-id", result: {} })}\n`);
			return true;
		});

		await expect(herdrRequest("pane.report_agent", {})).rejects.toThrow("mismatched response");
	});

	test("accepts a matching response split across socket chunks", async () => {
		await startServer((request, socket) => {
			const response = `${JSON.stringify({ id: request.id, result: {} })}\n`;
			const midpoint = Math.floor(response.length / 2);
			socket.write(response.slice(0, midpoint));
			setTimeout(() => socket.end(response.slice(midpoint)), 5);
			return true;
		});

		await expect(herdrRequest("pane.report_agent", {})).resolves.toEqual(expect.objectContaining({ result: {} }));
	});
});
const mainContext = { sessionMetadata: { kind: "main" as const } };

describe("agent_end stop reasons", () => {
	test("reports idle when the loop completed", async () => {
		const requests = await startServer();
		const idle = registeredHandler(registerIdle);
		await idle({ type: "agent_end", stopReason: "completed" }, mainContext);
		await wait(20);

		const reports = requests.filter(request => request.method === "pane.report_agent");
		expect(reports.length).toBeGreaterThanOrEqual(1);
		expect(reports.every(request => request.params.state === "idle")).toBe(true);
	});

	test("treats a missing stop reason as completed", async () => {
		const requests = await startServer();
		const idle = registeredHandler(registerIdle);
		await idle({ type: "agent_end" }, mainContext);
		await wait(20);

		const reports = requests.filter(request => request.method === "pane.report_agent");
		expect(reports.some(request => request.params.state === "idle")).toBe(true);
	});

	test("never goes idle while suspended or under maintenance", async () => {
		const requests = await startServer();
		const working = registeredHandler(registerWorking);
		const idle = registeredHandler(registerIdle);
		await working({ type: "agent_start" }, mainContext);
		await wait(20);
		await idle({ type: "agent_end", stopReason: "paused" }, mainContext);
		await idle({ type: "agent_end", stopReason: "maintenance" }, mainContext);
		await wait(20);

		const states = requests
			.filter(request => request.method === "pane.report_agent")
			.map(request => request.params.state);
		expect(states).toContain("working");
		expect(states).not.toContain("idle");
	});

	test("re-asserts working when a continuation turn starts after idle", async () => {
		const requests = await startServer();
		const working = registeredHandler(registerWorking);
		const idle = registeredHandler(registerIdle);
		const turn = registeredHandler(registerTurn);
		await working({ type: "agent_start" }, mainContext);
		await wait(20);
		await idle({ type: "agent_end", stopReason: "completed" }, mainContext);
		await wait(20);
		// Goal/autonomous continuation resumes with a fresh turn_start but no new
		// agent_start; the pane must return to working instead of staying idle.
		await turn({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, mainContext);
		await wait(20);

		const states = requests
			.filter(request => request.method === "pane.report_agent")
			.map(request => request.params.state);
		expect(states).toContain("idle");
		expect(states.at(-1)).toBe("working");
	});
});

describe("session scope", () => {
	test("ignores every lifecycle event emitted by in-process subagents", async () => {
		const requests = await startServer();
		const context = { sessionMetadata: { kind: "sub" as const } };
		for (const register of [
			registerStartup,
			registerWorking,
			registerTurn,
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
	test("the newest reported state wins", async () => {
		const requests = await startServer();
		const reporter = herdrGjc();
		reporter.report("idle", undefined, { burst: false });
		reporter.report("working", undefined, { burst: false });
		await wait(40);

		const reports = requests.filter(request => request.method === "pane.report_agent");
		expect(reports.at(-1)?.params.state).toBe("working");
	});

	test("does not resurrect the agent after release during a slow pane lookup", async () => {
		const requests = await startServer((request, socket) => {
			if (request.method !== "pane.get") return false;
			setTimeout(
				() =>
					sendResponse(socket, request.id, {
						result: { pane: { pane_id: request.params.pane_id, terminal_id: "test-terminal" } },
					}),
				60,
			);
			return true;
		});
		const reporter = herdrGjc();
		reporter.report("idle", undefined, { burst: false });
		await wait(10);
		await reporter.release();
		await wait(120);

		expect(requests.some(request => request.method === "pane.release_agent")).toBe(true);
		expect(requests.some(request => request.method === "pane.report_agent")).toBe(false);
	});
});

describe("blocked flow", () => {
	test("stays blocked when the loop suspends on a headless ask", async () => {
		const requests = await startServer();
		const blocked = registeredHandler(registerBlocked);
		const idle = registeredHandler(registerIdle);
		await blocked({ type: "tool_call" }, mainContext);
		await wait(20);
		await idle({ type: "agent_end", stopReason: "paused" }, mainContext);
		await wait(20);

		const reports = requests.filter(request => request.method === "pane.report_agent");
		expect(reports.length).toBeGreaterThanOrEqual(1);
		expect(reports.every(request => request.params.state === "blocked")).toBe(true);
	});

	test("returns to working when the ask resolves", async () => {
		const requests = await startServer();
		const blocked = registeredHandler(registerBlocked);
		const unblock = registeredHandler(registerUnblock);
		await blocked({ type: "tool_call" }, mainContext);
		await wait(20);
		await unblock({ type: "tool_result" }, mainContext);
		await wait(20);

		const states = requests
			.filter(request => request.method === "pane.report_agent")
			.map(request => request.params.state);
		expect(states).toContain("blocked");
		expect(states.at(-1)).toBe("working");
	});
});

describe("space binding", () => {
	test("follows the terminal when its pane moves between spaces", async () => {
		let moved = false;
		const requests = await startServer((request, socket) => {
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
		const requests = await startServer((request, socket) => {
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
