# How-to Guides

> **Goal-oriented guides for common bridge-ws tasks.**
>
> These guides assume bridge-ws is already installed and you know the basics. If not, start with the [Tutorial](tutorial.md).

---

## Enable API key authentication

By default bridge-ws accepts any connection. To restrict access, set the `BRIDGE_WS_API_KEY` environment variable before starting the server:

```bash
BRIDGE_WS_API_KEY=my-secret-token bridge-ws
```

The server prints `API key authentication enabled` on start.

Clients must then send the key as a Bearer token in the WebSocket upgrade request:

```js
const ws = new WebSocket("ws://localhost:9999", {
  headers: { Authorization: "Bearer my-secret-token" },
});
```

Connections without a valid token are closed immediately with code `4001`.

---

## Restrict allowed origins

To limit which web origins can connect (useful when embedding bridge-ws in a web app):

```bash
bridge-ws --origins https://app.example.com,https://staging.example.com
```

Connections from unlisted origins are closed with code `4003`. Connections without an `Origin` header are also rejected when an allowlist is set.

---

## Limit Claude's agentic turns

By default Claude runs with unlimited turns. To cap it:

```bash
bridge-ws --max-turns 5
```

This passes `--max-turns 5` to the Claude CLI for every request on this server instance.

---

## Restrict Claude's available tools

To whitelist specific tools (or disable all tools):

```bash
# Enable only specific tools
bridge-ws --tools "Bash,Read,Write"

# Disable all tools (single-turn text only)
bridge-ws --tools ""
```

The value is passed directly to `claude --tools`. If omitted, Claude runs with its default tool set.

---

## Cancel an in-flight request

Send a `cancel` message with the `requestId` of the request you want to stop:

```js
ws.send(JSON.stringify({
  type: "cancel",
  requestId: "req-1",
}));
```

The server kills the underlying CLI process and responds with an error message:

```json
{ "type": "error", "message": "Request cancelled", "requestId": "req-1" }
```

If no request with that `requestId` is active, the server returns an error without killing anything.

---

## Send multiple requests concurrently

bridge-ws supports multiple in-flight requests on a single connection. Each request must have a unique `requestId`:

```js
ws.send(JSON.stringify({ type: "prompt", prompt: "First task", requestId: "task-1" }));
ws.send(JSON.stringify({ type: "prompt", prompt: "Second task", requestId: "task-2" }));
```

Responses from both requests arrive interleaved on the same connection, each tagged with its `requestId`. Use the `requestId` to route chunks to the correct handler:

```js
const handlers = new Map();

handlers.set("task-1", (chunk) => { /* ... */ });
handlers.set("task-2", (chunk) => { /* ... */ });

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "chunk") {
    handlers.get(msg.requestId)?.(msg.content);
  }
});
```

> **Note:** Claude requests on the same connection share a single runner process (to preserve session state). Two concurrent Claude requests on the same connection run sequentially at the process level — the second waits until the first finishes. Use separate connections for true parallelism across Claude requests.

---

## Use Codex as the provider

Add `"provider": "codex"` to any prompt message:

```js
ws.send(JSON.stringify({
  type: "prompt",
  prompt: "Explain this diff",
  requestId: "req-1",
  provider: "codex",
}));
```

If the Codex CLI is not installed, the server returns an error for that request but continues serving Claude requests normally.

---

## Scope requests to a project directory

Use `projectId` to pin a request to a specific subdirectory inside the server's session directory:

```js
ws.send(JSON.stringify({
  type: "prompt",
  prompt: "List all TODO comments in this codebase",
  requestId: "req-1",
  projectId: "my-project",
}));
```

The `projectId` must contain only alphanumeric characters, hyphens, underscores, and dots. Attempts to use path traversal characters (e.g. `../`) are rejected.

---

## Pass a system prompt

```js
ws.send(JSON.stringify({
  type: "prompt",
  prompt: "What does this code do?",
  requestId: "req-1",
  systemPrompt: "You are a concise code reviewer. Answer in plain text only.",
}));
```

System prompts are passed to Claude via `--system-prompt`. Maximum size is 64 KB.

---

## Send images

Include base64-encoded images in the `images` array (Claude only):

```js
import { readFileSync } from "fs";

const imageData = readFileSync("screenshot.png").toString("base64");

ws.send(JSON.stringify({
  type: "prompt",
  prompt: "Describe what you see in this screenshot.",
  requestId: "req-1",
  images: [
    { media_type: "image/png", data: imageData },
  ],
}));
```

Supported types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Maximum 4 images per request, 10 MB each.

---

## Deploy behind a reverse proxy (nginx)

bridge-ws is a plain WebSocket server. To put nginx in front of it:

```nginx
location /bridge-ws/ {
    proxy_pass http://127.0.0.1:9999/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;  # keep long-running requests alive
}
```

Run bridge-ws bound to localhost only (`--host 127.0.0.1`) so it is not directly reachable from outside. Use `--origins` to restrict the allowed web origins if needed.

---

## Change the port or host

```bash
# Listen on a different port
bridge-ws --port 8080

# Listen on all interfaces (caution: exposes to the network)
bridge-ws --host 0.0.0.0 --port 9999
```

---

## Increase the process timeout

By default each CLI process is killed after 300 seconds. To increase it:

```bash
bridge-ws --timeout 600
```

Value is in seconds. Maximum is 3600 (1 hour).

---

## Use bridge-ws as a library

Import `AgentWebSocketServer` directly from the package:

```ts
import { AgentWebSocketServer } from "bridge-ws";
import { createLogger } from "bridge-ws/logger"; // or bring your own pino instance

const server = new AgentWebSocketServer({
  port: 9999,
  host: "127.0.0.1",
  logger: createLogger({ level: "info" }),
  claudePath: "claude",
  timeoutMs: 60_000,
  apiKey: process.env.BRIDGE_WS_API_KEY,
  maxTurns: 10,
});

await server.start();

// Later:
server.stop();
```

You can inject custom runner factories for testing or to swap in alternative CLI backends:

```ts
const server = new AgentWebSocketServer({
  port: 9999,
  host: "127.0.0.1",
  logger,
  claudeRunnerFactory: (log) => new MyCustomRunner(log),
});
```

**Next:** See the [Reference](reference.md) for a complete list of options, message types, and environment variables.
