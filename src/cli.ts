import { Command } from "commander";
import { AgentWS } from "./agent.js";
import { checkCli } from "./utils/claude-check.js";

declare const PKG_VERSION: string;
const VERSION = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "0.0.0-dev";

const program = new Command();

program
  .name("bridge-ws")
  .description("WebSocket bridge for CLI AI agents (Claude, Codex, Ollama)")
  .version(VERSION)
  .option("-p, --port <port>", "WebSocket server port", "9999")
  .option("-H, --host <host>", "WebSocket server host", "localhost")
  .option("-c, --claude-path <path>", "Path to Claude CLI", "claude")
  .option("--codex-path <path>", "Path to Codex CLI", "codex")
  .option("--ollama-url <url>", "Ollama base URL", "http://localhost:11434")
  .option("-t, --timeout <seconds>", "Process timeout in seconds", "300")
  .option("--log-level <level>", "Log level (debug, info, warn, error)", "info")
  .option("--origins <origins>", "Comma-separated allowed origins")
  .option("--max-turns <n>", "Max agentic turns for Claude (default: unlimited)")
  .option("--tools <tools>", "Comma-separated Claude tools to enable (default: all tools)")
  .action(async (opts: {
    port: string;
    host: string;
    claudePath: string;
    codexPath: string;
    ollamaUrl: string;
    timeout: string;
    logLevel: string;
    origins?: string;
    maxTurns?: string;
    tools?: string;
  }) => {
    console.log(`
╔═══════════════════════════════════════╗
║          bridge-ws v${VERSION.padEnd(20)}║
║     CLI AI Agent Bridge              ║
╚═══════════════════════════════════════╝
`);

    const check = checkCli(opts.claudePath);
    if (!check.available) {
      console.error(`Claude CLI not found at: ${opts.claudePath}`);
      console.error("Make sure Claude Code is installed and in your PATH.");
      console.error("Install: npm install -g @anthropic-ai/claude-code");
      console.error(`Or specify path: bridge-ws --claude-path /path/to/claude`);
      process.exit(1);
    }
    console.log(`Found Claude CLI: ${check.version}`);

    const codexCheck = checkCli(opts.codexPath);
    if (codexCheck.available) {
      console.log(`Found Codex CLI: ${codexCheck.version}`);
    } else {
      console.log("Codex CLI not found (codex provider will be unavailable)");
    }

    console.log(`Ollama provider available at: ${opts.ollamaUrl} (start Ollama separately if needed)`);

    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${opts.port} (must be 1–65535)`);
      process.exit(1);
    }

    const timeoutSeconds = parseInt(opts.timeout, 10);
    if (isNaN(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
      console.error(`Invalid timeout: ${opts.timeout} (must be 1–3600 seconds)`);
      process.exit(1);
    }

    let maxTurns: number | undefined;
    if (opts.maxTurns !== undefined) {
      maxTurns = parseInt(opts.maxTurns, 10);
      if (isNaN(maxTurns) || maxTurns < 1) {
        console.error(`Invalid --max-turns: ${opts.maxTurns} (must be a positive integer)`);
        process.exit(1);
      }
    }

    const allowedOrigins = opts.origins?.split(",").map((o) => o.trim()).filter(Boolean);
    if (allowedOrigins) {
      for (const origin of allowedOrigins) {
        try {
          new URL(origin);
        } catch {
          console.error(`Invalid origin: "${origin}" (must be a valid URL, e.g. https://example.com)`);
          process.exit(1);
        }
      }
    }

    const apiKey = process.env["BRIDGE_WS_API_KEY"] || undefined;
    if (apiKey) {
      console.log("API key authentication enabled");
    }

    const agent = new AgentWS({
      port,
      host: opts.host,
      claudePath: opts.claudePath,
      codexPath: opts.codexPath,
      ollamaUrl: opts.ollamaUrl,
      timeoutMs: timeoutSeconds * 1000,
      logLevel: opts.logLevel,
      allowedOrigins,
      apiKey,
      maxTurns,
      tools: opts.tools,
    });

    try {
      await agent.start();
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.error(`Port ${port} is already in use.`);
        console.error("Another instance of bridge-ws might be running.");
      }
      process.exit(1);
    }

    console.log(`bridge-ws running on ws://${opts.host}:${port}`);
    console.log(`Health check: http://${opts.host}:${port}/healthz`);
    console.log("Press Ctrl+C to stop\n");

    const shutdown = () => {
      agent.stop();
      console.log("\nbridge-ws stopped");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse();
