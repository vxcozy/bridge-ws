import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { AgentWebSocketServer } from "../src/server/websocket.js";
import { ClaudeProvider } from "../src/process/claude-provider.js";
import { createLogger } from "../src/utils/logger.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_CLAUDE = resolve(__dirname, "fixtures/mock-claude.mjs");
const PORT = 19995;
const log = createLogger({ level: "warn", pretty: false });

function waitForMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const messages: object[] = [];
    const t = setTimeout(() => reject(new Error(`Timed out waiting for ${count} messages, got ${messages.length}`)), timeoutMs);
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length >= count) {
        clearTimeout(t);
        resolve(messages);
      }
    });
  });
}

describe("E2E with mock Claude CLI", () => {
  let server: AgentWebSocketServer;

  beforeEach(async () => {
    server = new AgentWebSocketServer({
      port: PORT,
      host: "127.0.0.1",
      logger: log,
      claudeRunnerFactory: (logger) => new ClaudeProvider({
        claudePath: "node",
        logger,
        // Pass mock-claude.mjs as the "claude" binary via node
      }),
    });

    // Override: use node + mock-claude.mjs as the claude binary
    server = new AgentWebSocketServer({
      port: PORT,
      host: "127.0.0.1",
      logger: log,
      claudeRunnerFactory: (logger) => new ClaudeProvider({
        claudePath: MOCK_CLAUDE,
        logger,
        timeoutMs: 10000,
      }),
    });

    await server.start();
  });

  afterEach(async () => {
    server.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("completes a full request: connected → chunk → complete", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

    // Expect: connected, chunk, complete = 3 messages
    const msgPromise = waitForMessages(ws, 3);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("open timed out")), 3000);
      ws.once("error", (e) => { clearTimeout(t); reject(e); });
      ws.once("message", () => { clearTimeout(t); resolve(); }); // connected
    });

    ws.send(JSON.stringify({
      type: "prompt",
      prompt: "hello world",
      requestId: "e2e-1",
    }));

    const messages = await msgPromise;

    const connected = messages[0] as { type: string };
    const chunk = messages[1] as { type: string; content: string; requestId: string };
    const complete = messages[2] as { type: string; requestId: string };

    expect(connected.type).toBe("connected");
    expect(chunk.type).toBe("chunk");
    expect(chunk.content).toContain("echo: hello world");
    expect(chunk.requestId).toBe("e2e-1");
    expect(complete.type).toBe("complete");
    expect(complete.requestId).toBe("e2e-1");

    ws.close();
  });

  it("handles sequential requests on the same connection", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

    // Wait for connected handshake
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("open timed out")), 3000);
      ws.once("error", (e) => { clearTimeout(t); reject(e); });
      ws.once("message", () => { clearTimeout(t); resolve(); });
    });

    // Send req-a and wait for its chunk + complete
    ws.send(JSON.stringify({ type: "prompt", prompt: "first", requestId: "req-a" }));
    const firstPair = await waitForMessages(ws, 2, 5000);
    expect(firstPair.some((m: any) => m.type === "complete" && m.requestId === "req-a")).toBe(true);

    // Send req-b (after req-a completes) and wait for its chunk + complete
    ws.send(JSON.stringify({ type: "prompt", prompt: "second", requestId: "req-b" }));
    const secondPair = await waitForMessages(ws, 2, 5000);
    expect(secondPair.some((m: any) => m.type === "complete" && m.requestId === "req-b")).toBe(true);

    ws.close();
  }, 15000);

  it("healthz endpoint returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });
});
