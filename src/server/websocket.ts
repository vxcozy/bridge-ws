import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { ClaudeProvider, type ClaudeProviderOptions } from "../process/claude-provider.js";
import { CodexProvider } from "../process/codex-provider.js";
import { OllamaProvider } from "../process/ollama-provider.js";
import {
  parseClientMessage,
  serializeMessage,
  type AgentMessage,
  type PromptMessage,
  type CancelMessage,
} from "./protocol.js";
import type { Logger } from "../utils/logger.js";
import type { Runner, RunHandlers, RunnerFactory } from "../process/base-cli-provider.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PAYLOAD = 50 * 1024 * 1024; // 50MB

/** Per-request state tracked within a connection */
interface ActiveRequest {
  runner: Runner;
}

/** Per-connection state — now a Map of concurrent requests instead of one */
interface ConnectionState {
  requests: Map<string, ActiveRequest>;
  claudeRunner: Runner | null;
  codexRunner: Runner | null;
  ollamaRunner: Runner | null;
  isAlive: boolean;
}

export interface AgentWebSocketServerOptions {
  port: number;
  host: string;
  logger: Logger;
  claudePath?: string;
  codexPath?: string;
  timeoutMs?: number;
  allowedOrigins?: string[];
  maxPayload?: number;
  claudeRunnerFactory?: RunnerFactory;
  codexRunnerFactory?: RunnerFactory;
  ollamaRunnerFactory?: RunnerFactory;
  ollamaUrl?: string;           // Ollama base URL, default: http://localhost:11434
  agentName?: string;
  sessionDir?: string;
  apiKey?: string;          // optional: if set, clients must send this as Bearer token on connect
  maxTurns?: number;        // passed through to ClaudeProvider
  tools?: string;           // passed through to ClaudeProvider
}

export class AgentWebSocketServer {
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly log: Logger;
  private readonly options: AgentWebSocketServerOptions;

  constructor(options: AgentWebSocketServerOptions) {
    this.options = options;
    this.log = options.logger;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // HTTP server handles /healthz; WS server attaches to it
      this.httpServer = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/healthz") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", connections: this.connections.size }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.wss = new WebSocketServer({
        server: this.httpServer,
        maxPayload: this.options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
      });

      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));

      this.httpServer.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          this.log.fatal({ port: this.options.port }, "Port already in use");
        } else {
          this.log.error({ err }, "Server error");
        }
        reject(err);
      });

      this.httpServer.listen(this.options.port, this.options.host, () => {
        this.log.info({ port: this.options.port, host: this.options.host }, "WebSocket server started");
        this.startHeartbeat();
        resolve();
      });
    });
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const [ws, state] of this.connections) {
      for (const { runner } of state.requests.values()) {
        runner.dispose();
      }
      state.claudeRunner?.dispose();
      state.codexRunner?.dispose();
      state.ollamaRunner?.dispose();
      ws.terminate();
    }
    this.connections.clear();

    this.wss?.close();
    this.wss = null;
    this.httpServer?.close();
    this.httpServer = null;

    this.log.info("WebSocket server stopped");
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Origin check
    if (this.options.allowedOrigins && this.options.allowedOrigins.length > 0) {
      const origin = req.headers.origin;
      // No Origin header = CLI/server-side client — always allow.
      // Origin present but not in allowlist = browser client from wrong origin — reject.
      if (origin && !this.options.allowedOrigins.includes(origin)) {
        this.log.warn({ origin }, "Rejected connection: origin not in allowlist");
        ws.close(4003, "Origin not allowed");
        return;
      }
    }

    // API key check
    if (this.options.apiKey) {
      const auth = req.headers["authorization"] ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token !== this.options.apiKey) {
        this.log.warn("Rejected connection: invalid API key");
        ws.close(4001, "Unauthorized");
        return;
      }
    }

    const clientIp = req.socket.remoteAddress;
    this.log.info({ clientIp }, "Client connected");

    const state: ConnectionState = {
      requests: new Map(),
      claudeRunner: null,
      codexRunner: null,
      ollamaRunner: null,
      isAlive: true,
    };
    this.connections.set(ws, state);

    this.sendMessage(ws, {
      type: "connected",
      version: "2.0",
      agent: this.options.agentName ?? "bridge-ws",
    });

    ws.on("pong", () => { state.isAlive = true; });

    ws.on("message", (data) => {
      this.handleMessage(ws, state, data.toString());
    });

    ws.on("close", () => {
      this.log.info({ clientIp }, "Client disconnected");
      for (const { runner } of state.requests.values()) {
        runner.dispose();
      }
      state.claudeRunner?.dispose();
      state.codexRunner?.dispose();
      state.ollamaRunner?.dispose();
      this.connections.delete(ws);
    });

    ws.on("error", (err) => {
      this.log.error({ err, clientIp }, "WebSocket error");
    });
  }

  private handleMessage(ws: WebSocket, state: ConnectionState, raw: string): void {
    const result = parseClientMessage(raw);

    if (!result.ok) {
      this.sendMessage(ws, { type: "error", message: result.error });
      return;
    }

    const { message } = result;

    switch (message.type) {
      case "prompt":
        this.handlePrompt(ws, state, message);
        break;
      case "cancel":
        this.handleCancel(ws, state, message);
        break;
    }
  }

  private handlePrompt(ws: WebSocket, state: ConnectionState, message: PromptMessage): void {
    const { requestId } = message;

    if (state.requests.has(requestId)) {
      this.sendMessage(ws, {
        type: "error",
        message: `Request ${requestId} is already in progress`,
        requestId,
      });
      return;
    }

    // Lazy-create and reuse provider instances per provider type per connection
    // (preserves Claude session state via CWD scoping across requests)
    let runner: Runner;
    if (message.provider === "codex") {
      if (!state.codexRunner) {
        state.codexRunner = this.createCodexRunner();
      }
      runner = state.codexRunner;
    } else if (message.provider === "ollama") {
      if (!state.ollamaRunner) {
        state.ollamaRunner = this.createOllamaRunner();
      }
      runner = state.ollamaRunner;
    } else {
      if (!state.claudeRunner) {
        state.claudeRunner = this.createClaudeRunner();
      }
      runner = state.claudeRunner;
    }

    state.requests.set(requestId, { runner });

    const handlers: RunHandlers = {
      onChunk: (content, reqId, thinking) => {
        try {
          this.sendMessage(ws, { type: "chunk", content, requestId: reqId, ...(thinking ? { thinking: true } : {}) });
        } catch (err) {
          this.log.warn({ err, requestId: reqId }, "Error in onChunk handler");
        }
      },
      onComplete: (reqId) => {
        try {
          state.requests.delete(reqId);
          this.sendMessage(ws, { type: "complete", requestId: reqId });
        } catch (err) {
          this.log.warn({ err, requestId: reqId }, "Error in onComplete handler");
        }
      },
      onError: (errorMessage, reqId) => {
        try {
          state.requests.delete(reqId);
          this.sendMessage(ws, { type: "error", message: errorMessage, requestId: reqId });
        } catch (err) {
          this.log.warn({ err, requestId: reqId }, "Error in onError handler");
        }
      },
    };

    runner.run(
      {
        prompt: message.prompt,
        model: message.model,
        systemPrompt: message.systemPrompt,
        projectId: message.projectId,
        requestId,
        thinkingTokens: message.thinkingTokens,
        images: message.images,
      },
      handlers,
    );
  }

  private handleCancel(ws: WebSocket, state: ConnectionState, message: CancelMessage): void {
    const { requestId } = message;
    const active = state.requests.get(requestId);

    if (!active) {
      this.sendMessage(ws, { type: "error", message: `No active request with id: ${requestId}`, requestId });
      return;
    }

    active.runner.kill();
    state.requests.delete(requestId);
    this.sendMessage(ws, { type: "error", message: "Request cancelled", requestId });
    this.log.info({ requestId }, "Request cancelled");
  }

  private sendMessage(ws: WebSocket, message: AgentMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serializeMessage(message));
    } else {
      this.log.warn({ messageType: message.type, readyState: ws.readyState }, "Dropping message, WebSocket not OPEN");
    }
  }

  private createClaudeRunner(): Runner {
    if (this.options.claudeRunnerFactory) {
      return this.options.claudeRunnerFactory(this.log);
    }
    const opts: ClaudeProviderOptions = {
      claudePath: this.options.claudePath,
      timeoutMs: this.options.timeoutMs,
      logger: this.log,
      sessionDir: this.options.sessionDir,
      maxTurns: this.options.maxTurns,
      tools: this.options.tools,
    };
    return new ClaudeProvider(opts);
  }

  private createCodexRunner(): Runner {
    if (this.options.codexRunnerFactory) {
      return this.options.codexRunnerFactory(this.log);
    }
    return new CodexProvider({
      codexPath: this.options.codexPath,
      timeoutMs: this.options.timeoutMs,
      logger: this.log,
      sessionDir: this.options.sessionDir,
    });
  }

  private createOllamaRunner(): Runner {
    if (this.options.ollamaRunnerFactory) {
      return this.options.ollamaRunnerFactory(this.log);
    }
    return new OllamaProvider({
      baseUrl: this.options.ollamaUrl,
      timeoutMs: this.options.timeoutMs,
      logger: this.log,
    });
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, state] of this.connections) {
        if (!state.isAlive) {
          this.log.debug("Terminating dead connection");
          for (const { runner } of state.requests.values()) runner.dispose();
          state.claudeRunner?.dispose();
          state.codexRunner?.dispose();
          state.ollamaRunner?.dispose();
          this.connections.delete(ws);
          ws.terminate();
          continue;
        }

        state.isAlive = false;
        try {
          ws.ping();
        } catch {
          this.log.debug("Ping failed, terminating connection");
          for (const { runner } of state.requests.values()) runner.dispose();
          state.claudeRunner?.dispose();
          state.codexRunner?.dispose();
          state.ollamaRunner?.dispose();
          this.connections.delete(ws);
          ws.terminate();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}
