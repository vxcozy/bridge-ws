import { AgentWebSocketServer, type AgentWebSocketServerOptions } from "./server/websocket.js";
import { createLogger, type Logger } from "./utils/logger.js";
import type { RunnerFactory } from "./process/base-cli-provider.js";

export interface AgentWSOptions {
  port?: number;
  host?: string;
  claudePath?: string;
  codexPath?: string;
  timeoutMs?: number;
  logLevel?: string;
  allowedOrigins?: string[];
  claudeRunnerFactory?: RunnerFactory;
  codexRunnerFactory?: RunnerFactory;
  ollamaRunnerFactory?: RunnerFactory;
  ollamaUrl?: string;
  agentName?: string;
  sessionDir?: string;
  apiKey?: string;
  maxTurns?: number;
  tools?: string;
}

export class AgentWS {
  private server: AgentWebSocketServer;
  private readonly log: Logger;

  constructor(options: AgentWSOptions = {}) {
    this.log = createLogger({ level: options.logLevel ?? "info" });

    const serverOptions: AgentWebSocketServerOptions = {
      port: options.port ?? 9999,
      host: options.host ?? "localhost",
      logger: this.log,
      claudePath: options.claudePath,
      codexPath: options.codexPath,
      timeoutMs: options.timeoutMs,
      allowedOrigins: options.allowedOrigins,
      claudeRunnerFactory: options.claudeRunnerFactory,
      codexRunnerFactory: options.codexRunnerFactory,
      ollamaRunnerFactory: options.ollamaRunnerFactory,
      ollamaUrl: options.ollamaUrl,
      agentName: options.agentName,
      sessionDir: options.sessionDir,
      apiKey: options.apiKey,
      maxTurns: options.maxTurns,
      tools: options.tools,
    };

    this.server = new AgentWebSocketServer(serverOptions);
  }

  async start(): Promise<void> {
    await this.server.start();
  }

  stop(): void {
    this.server.stop();
  }
}
