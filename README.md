# bridge-ws

WebSocket bridge for CLI AI agents — stream Claude and Codex responses over a persistent connection.

## Install

```bash
npm install -g bridge-ws
```

Or run without installing:

```bash
npx bridge-ws
```

## Quick start

**1. Start the server:**

```bash
bridge-ws
```

```
╔═══════════════════════════════════════╗
║          bridge-ws v2.0.0            ║
║     CLI AI Agent Bridge              ║
╚═══════════════════════════════════════╝

Found Claude CLI: 1.x.x
bridge-ws running on ws://localhost:9999
Health check: http://localhost:9999/healthz
Press Ctrl+C to stop
```

**2. Connect and send a prompt:**

```js
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:9999");

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === "connected") {
    ws.send(JSON.stringify({
      type: "prompt",
      prompt: "Say hello in one sentence.",
      requestId: "req-1",
    }));
  }

  if (msg.type === "chunk") process.stdout.write(msg.content);
  if (msg.type === "complete") ws.close();
  if (msg.type === "error") { console.error(msg.message); ws.close(); }
});
```

## Requirements

- Node.js ≥ 20
- [Claude Code](https://claude.ai/code) CLI (`npm install -g @anthropic-ai/claude-code`)
- [Codex](https://github.com/openai/codex) CLI (optional, for `provider: "codex"`)

## Features

- **Request multiplexing** — send multiple prompts on a single connection; responses are tagged by `requestId`
- **Streaming** — response chunks arrive as they are produced, not after completion
- **Cancellation** — cancel any in-flight request by `requestId`
- **Two providers** — Claude (`claude`) and Codex (`codex`) on the same server
- **Optional auth** — Bearer token authentication via `BRIDGE_WS_API_KEY`
- **Health check** — `GET /healthz` on the same port
- **Library-ready** — import `AgentWebSocketServer` directly and inject custom runners

## CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` | `9999` | Listen port |
| `-H, --host <host>` | `localhost` | Bind address |
| `-c, --claude-path <path>` | `claude` | Path to Claude CLI |
| `--codex-path <path>` | `codex` | Path to Codex CLI |
| `-t, --timeout <seconds>` | `300` | Per-request CLI timeout |
| `--log-level <level>` | `info` | `debug`, `info`, `warn`, `error` |
| `--origins <origins>` | _(any)_ | Comma-separated allowed origins |
| `--max-turns <n>` | _(unlimited)_ | Max Claude agentic turns |
| `--tools <tools>` | _(all)_ | Comma-separated Claude tools to enable |

**Environment variables:**

| Variable | Description |
|----------|-------------|
| `BRIDGE_WS_API_KEY` | Required Bearer token for connecting clients |

## Protocol

### Client → Server

```jsonc
// Send a prompt
{ "type": "prompt", "prompt": "...", "requestId": "req-1", "provider": "claude" }

// Cancel a request
{ "type": "cancel", "requestId": "req-1" }
```

### Server → Client

```jsonc
// On connect
{ "type": "connected", "version": "2.0", "agent": "bridge-ws" }

// Response fragments
{ "type": "chunk", "content": "...", "requestId": "req-1" }

// On completion
{ "type": "complete", "requestId": "req-1" }

// On error or cancellation
{ "type": "error", "message": "...", "requestId": "req-1" }
```

Full protocol details: [docs/reference.md](docs/reference.md)

## Concurrent requests

```js
// Both requests run concurrently on the same connection
ws.send(JSON.stringify({ type: "prompt", prompt: "First task", requestId: "a" }));
ws.send(JSON.stringify({ type: "prompt", prompt: "Second task", requestId: "b" }));

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "chunk") {
    console.log(`[${msg.requestId}] ${msg.content}`);
  }
});
```

## Authentication

```bash
BRIDGE_WS_API_KEY=my-secret bridge-ws
```

```js
const ws = new WebSocket("ws://localhost:9999", {
  headers: { Authorization: "Bearer my-secret" },
});
```

## Library usage

```ts
import { AgentWebSocketServer } from "bridge-ws";
import pino from "pino";

const server = new AgentWebSocketServer({
  port: 9999,
  host: "127.0.0.1",
  logger: pino(),
  apiKey: process.env.BRIDGE_WS_API_KEY,
  maxTurns: 5,
});

await server.start();
```

## Documentation

- [Tutorial](docs/tutorial.md) — step-by-step first run
- [How-to guides](docs/howto.md) — auth, tools, cancellation, reverse proxy, library usage
- [Reference](docs/reference.md) — all CLI flags, message types, HTTP endpoints
- [Explanation](docs/explanation.md) — design decisions and architecture

## License

MIT
