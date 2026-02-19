import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { AgentWebSocketServer } from "../src/server/websocket.js";
import { createLogger } from "../src/utils/logger.js";
import type { Runner, RunOptions, RunHandlers } from "../src/process/base-cli-provider.js";

const log = createLogger({ level: "warn", pretty: false });

// Controllable mock runner — run() captures handlers so tests can trigger them
function makeMockRunner(): Runner & {
  lastHandlers: RunHandlers | null;
  lastOptions: RunOptions | null;
  killCount: number;
} {
  const runner = {
    lastHandlers: null as RunHandlers | null,
    lastOptions: null as RunOptions | null,
    killCount: 0,
    run(options: RunOptions, handlers: RunHandlers) {
      this.lastOptions = options;
      this.lastHandlers = handlers;
    },
    kill() { this.killCount++; },
    dispose() { this.kill(); },
  };
  return runner;
}

function sendMsg(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg));
}

function waitForMessage(ws: WebSocket): Promise<object> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("waitForMessage timed out")), 3000);
    ws.once("message", (data) => {
      clearTimeout(t);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function startServer(port: number, options: Partial<ConstructorParameters<typeof AgentWebSocketServer>[0]> = {}, runner?: ReturnType<typeof makeMockRunner>): Promise<{ server: AgentWebSocketServer; runner: ReturnType<typeof makeMockRunner> }> {
  const r = runner ?? makeMockRunner();
  const server = new AgentWebSocketServer({
    port,
    host: "127.0.0.1",
    logger: log,
    claudeRunnerFactory: () => r,
    codexRunnerFactory: () => r,
    ...options,
  });
  await server.start();
  return { server, runner: r };
}

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  // Wait for the "connected" handshake — this resolves after open + first message
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timed out")), 3000);
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
    ws.once("message", () => { clearTimeout(t); resolve(); });
  });
  return ws;
}

function stopServer(server: AgentWebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    server.stop();
    // Give the OS a tick to release the port
    setTimeout(resolve, 50);
  });
}

describe("multiplexing", () => {
  const PORT = 19990;
  let server: AgentWebSocketServer;
  let runner: ReturnType<typeof makeMockRunner>;

  beforeEach(async () => {
    const result = await startServer(PORT);
    server = result.server;
    runner = result.runner;
  });

  afterEach(async () => {
    await stopServer(server);
  });

  it("accepts two concurrent requests with different requestIds", async () => {
    const ws = await connect(PORT);

    sendMsg(ws, { type: "prompt", prompt: "first", requestId: "req-1" });
    sendMsg(ws, { type: "prompt", prompt: "second", requestId: "req-2" });

    // Both requests should be accepted — no error received
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
  });

  it("returns error for duplicate requestId", async () => {
    const ws = await connect(PORT);

    sendMsg(ws, { type: "prompt", prompt: "first", requestId: "req-dup" });
    await new Promise((r) => setTimeout(r, 20));
    sendMsg(ws, { type: "prompt", prompt: "second", requestId: "req-dup" });

    const msg = await waitForMessage(ws);
    expect(msg).toMatchObject({
      type: "error",
      requestId: "req-dup",
      message: expect.stringContaining("req-dup"),
    });
    ws.close();
  });

  it("cancel targets the specific requestId and kills runner", async () => {
    const ws = await connect(PORT);

    sendMsg(ws, { type: "prompt", prompt: "hello", requestId: "req-cancel" });
    await new Promise((r) => setTimeout(r, 20));

    sendMsg(ws, { type: "cancel", requestId: "req-cancel" });
    const msg = await waitForMessage(ws);

    expect(msg).toMatchObject({ type: "error", message: "Request cancelled", requestId: "req-cancel" });
    expect(runner.killCount).toBe(1);
    ws.close();
  });

  it("cancel with unknown requestId returns error without killing anything", async () => {
    const ws = await connect(PORT);

    sendMsg(ws, { type: "cancel", requestId: "no-such-id" });
    const msg = await waitForMessage(ws);

    expect(msg).toMatchObject({ type: "error", requestId: "no-such-id" });
    expect(runner.killCount).toBe(0);
    ws.close();
  });

  it("onComplete removes request — same requestId can be reused", async () => {
    const ws = await connect(PORT);

    sendMsg(ws, { type: "prompt", prompt: "hello", requestId: "req-done" });
    await new Promise((r) => setTimeout(r, 20));

    // Simulate runner completing
    runner.lastHandlers!.onComplete("req-done");
    const msg = await waitForMessage(ws);
    expect(msg).toMatchObject({ type: "complete", requestId: "req-done" });

    // Same requestId should be accepted again
    sendMsg(ws, { type: "prompt", prompt: "again", requestId: "req-done" });
    await new Promise((r) => setTimeout(r, 20));
    // No error = success
    ws.close();
  });

  it("rejects cancel missing requestId", async () => {
    const ws = await connect(PORT);
    sendMsg(ws, { type: "cancel" }); // missing requestId — invalid per protocol
    const msg = await waitForMessage(ws);
    expect(msg).toMatchObject({ type: "error" });
    ws.close();
  });

  it("chunks are routed to the correct requestId", async () => {
    const ws = await connect(PORT);

    sendMsg(ws, { type: "prompt", prompt: "hello", requestId: "req-chunk" });
    await new Promise((r) => setTimeout(r, 20));

    runner.lastHandlers!.onChunk("world", "req-chunk");
    const msg = await waitForMessage(ws);
    expect(msg).toMatchObject({ type: "chunk", content: "world", requestId: "req-chunk" });
    ws.close();
  });
});

describe("API key auth", () => {
  const PORT = 19991;
  let server: AgentWebSocketServer;

  beforeEach(async () => {
    const result = await startServer(PORT, { apiKey: "secret-key" });
    server = result.server;
  });

  afterEach(async () => {
    await stopServer(server);
  });

  it("rejects connection without API key", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const code = await new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
    expect(code).toBe(4001);
  });

  it("rejects connection with wrong API key", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    const code = await new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
    expect(code).toBe(4001);
  });

  it("accepts connection with correct API key", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Authorization: "Bearer secret-key" },
    });
    // Register message listener before open to avoid race with "connected" message
    const msg = await new Promise<object>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out")), 3000);
      ws.once("error", (e) => { clearTimeout(t); reject(e); });
      ws.once("message", (data) => { clearTimeout(t); resolve(JSON.parse(data.toString())); });
    });
    expect(msg).toMatchObject({ type: "connected" });
    ws.close();
  });
});
