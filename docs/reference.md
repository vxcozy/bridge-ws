# Reference

> **Complete technical reference for bridge-ws.**
>
> This document lists every CLI flag, environment variable, wire protocol message, and HTTP endpoint.

---

## CLI

```
bridge-ws [options]
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` | `9999` | WebSocket server port (1–65535) |
| `-H, --host <host>` | `localhost` | WebSocket server bind address |
| `-c, --claude-path <path>` | `claude` | Path to the Claude CLI binary |
| `--codex-path <path>` | `codex` | Path to the Codex CLI binary |
| `--ollama-url <url>` | `http://localhost:11434` | Base URL of the Ollama HTTP API |
| `-t, --timeout <seconds>` | `300` | Per-request CLI process timeout (1–3600) |
| `--log-level <level>` | `info` | Log verbosity: `debug`, `info`, `warn`, `error`, `silent` |
| `--origins <origins>` | _(any)_ | Comma-separated allowlist of permitted origins |
| `--max-turns <n>` | _(unlimited)_ | Max agentic turns per Claude request |
| `--tools <tools>` | _(all tools)_ | Comma-separated list of Claude tools to enable |
| `--version` | — | Print version and exit |
| `--help` | — | Print help and exit |

### Environment variables

| Variable | Description |
|----------|-------------|
| `BRIDGE_WS_API_KEY` | When set, clients must supply this value as a Bearer token in the `Authorization` header on connect |

---

## Wire protocol

All messages are JSON objects sent as UTF-8 text frames over a WebSocket connection.

### Connection lifecycle

1. Client opens a WebSocket connection to `ws://<host>:<port>`.
2. Server sends a `connected` message immediately on successful connection.
3. Client sends `prompt` messages; server responds with `chunk` and `complete` messages.
4. Either party may close the connection at any time.

---

### Client → Server messages

#### `prompt`

Send a prompt to the AI agent.

```json
{
  "type": "prompt",
  "prompt": "Your question or task here",
  "requestId": "unique-id-for-this-request",
  "provider": "claude",
  "projectId": "my-project",
  "model": "claude-opus-4-6",
  "systemPrompt": "You are a helpful assistant.",
  "thinkingTokens": 1024,
  "images": [
    { "media_type": "image/png", "data": "<base64>" }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"prompt"` | yes | Message type |
| `prompt` | string | yes | The prompt text. Maximum 512 KB. |
| `requestId` | string | yes | Unique identifier for this request. Must not match any active request on this connection. |
| `provider` | `"claude"` \| `"codex"` \| `"ollama"` | no | Which AI agent to use. Defaults to `"claude"`. Unknown values are rejected. |
| `projectId` | string | no | Scopes the request to a subdirectory. Alphanumeric, hyphens, underscores, dots only. Max 128 chars. |
| `model` | string | no | Model identifier passed to the CLI. Behaviour depends on the provider. |
| `systemPrompt` | string | no | System prompt override. Maximum 64 KB. |
| `thinkingTokens` | integer | no | Extended thinking token budget (Claude only, non-negative). |
| `images` | array | no | Up to 4 images. Each: `{ "media_type": string, "data": string }`. Supported types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Max 10 MB per image. |

#### `cancel`

Cancel an in-flight request.

```json
{
  "type": "cancel",
  "requestId": "unique-id-to-cancel"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"cancel"` | yes | Message type |
| `requestId` | string | yes | The `requestId` of the request to cancel. Must be non-empty. |

---

### Server → Client messages

#### `connected`

Sent immediately after a successful connection.

```json
{
  "type": "connected",
  "version": "2.0",
  "agent": "bridge-ws"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"connected"` | Message type |
| `version` | string | Protocol version |
| `agent` | string | Server agent name |

#### `chunk`

A partial response fragment from the AI agent, streamed as it is produced.

```json
{
  "type": "chunk",
  "content": "partial response text",
  "requestId": "unique-id-for-this-request",
  "thinking": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"chunk"` | Message type |
| `content` | string | A fragment of the AI response |
| `requestId` | string | Matches the `requestId` from the originating `prompt` message |
| `thinking` | boolean | Present and `true` when this chunk is extended thinking output (Claude only) |

#### `complete`

Sent once when a request finishes successfully. No more `chunk` messages will follow for this `requestId`.

```json
{
  "type": "complete",
  "requestId": "unique-id-for-this-request"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"complete"` | Message type |
| `requestId` | string | Matches the `requestId` from the originating `prompt` message |

#### `error`

Sent when a request fails, is cancelled, or when a protocol violation occurs.

```json
{
  "type": "error",
  "message": "Human-readable description of the error",
  "requestId": "unique-id-for-this-request"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"error"` | Message type |
| `message` | string | Error description |
| `requestId` | string or absent | Present when the error relates to a specific request. Absent for connection-level errors (e.g. invalid JSON, unknown message type). |

---

### Validation errors

The following conditions result in an `error` message (no `requestId` unless stated):

| Condition | Error message |
|-----------|---------------|
| Invalid JSON | `"Invalid JSON"` |
| Message is not a JSON object | `"Message must be a JSON object"` |
| Missing `type` field | `"Missing or invalid 'type' field"` |
| Unknown `type` value | `"Unknown message type: <value>"` |
| `prompt` missing or empty | `"Missing or empty 'prompt' field"` |
| `prompt` exceeds 512 KB | `"Prompt exceeds maximum size of ..."` |
| `requestId` missing or empty | `"Missing or empty 'requestId' field"` |
| Duplicate `requestId` (active) | `"Request <id> is already in progress"` (with `requestId`) |
| Unknown `provider` value | `"Unknown provider: \"<value>\" (supported: claude, codex, ollama)"` |
| `projectId` invalid chars | `"projectId contains invalid characters ..."` |
| `projectId` exceeds 128 chars | `"projectId exceeds maximum length of 128"` |
| `systemPrompt` exceeds 64 KB | `"System prompt exceeds maximum size of ..."` |
| Too many images | `"Too many images (max 4)"` |
| Unsupported image type | `"Unsupported image type: <value>"` |
| Image exceeds 10 MB | `"Image exceeds maximum size of ..."` |
| `cancel` missing `requestId` | `"Missing or empty 'requestId' field in cancel message"` |
| `cancel` unknown `requestId` | `"No active request with id: <id>"` (with `requestId`) |
| Request cancelled | `"Request cancelled"` (with `requestId`) |

---

### Connection close codes

| Code | Condition |
|------|-----------|
| `4001` | API key authentication failed |
| `4003` | Origin not in the allowed origins list |
| Normal close codes (1000, 1001, etc.) | Clean shutdown by either party |

---

## HTTP endpoints

The same port serves both WebSocket connections and HTTP health checks.

### `GET /healthz`

Returns server health status.

**Response** — `200 OK`, `Content-Type: application/json`:

```json
{
  "status": "ok",
  "connections": 3
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` | Always `"ok"` when the server is running |
| `connections` | integer | Number of currently active WebSocket connections |

Any other path returns `404`.

---

## Library API

### `AgentWebSocketServer`

```ts
import { AgentWebSocketServer } from "bridge-ws";
```

#### Constructor options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | — | **Required.** Listen port. |
| `host` | string | — | **Required.** Bind address. |
| `logger` | Logger | — | **Required.** Pino-compatible logger instance. |
| `claudePath` | string | `"claude"` | Path to the Claude CLI binary. |
| `codexPath` | string | `"codex"` | Path to the Codex CLI binary. |
| `ollamaUrl` | string | `"http://localhost:11434"` | Base URL of the Ollama HTTP API. |
| `timeoutMs` | number | `300000` | Per-request process timeout in milliseconds. |
| `allowedOrigins` | string[] | _(any)_ | Origin allowlist. |
| `maxPayload` | number | `52428800` | Maximum incoming WebSocket message size in bytes (50 MB). |
| `apiKey` | string | _(none)_ | Required Bearer token for connecting clients. |
| `maxTurns` | number | _(unlimited)_ | Max Claude agentic turns per request. |
| `tools` | string | _(all)_ | Comma-separated Claude tools to enable. |
| `agentName` | string | `"bridge-ws"` | Value sent in the `connected` message `agent` field. |
| `sessionDir` | string | _(cwd)_ | Base directory for per-project sessions. |
| `claudeRunnerFactory` | function | _(default)_ | Override Claude runner creation. Signature: `(logger: Logger) => Runner`. |
| `codexRunnerFactory` | function | _(default)_ | Override Codex runner creation. Same signature. |
| `ollamaRunnerFactory` | function | _(default)_ | Override Ollama runner creation. Same signature. |

#### Methods

| Method | Description |
|--------|-------------|
| `start(): Promise<void>` | Start the HTTP and WebSocket server. Rejects if the port is in use. |
| `stop(): void` | Gracefully stop the server, kill all active runners, close all connections. |

---

## Heartbeat

The server sends a WebSocket `ping` frame to every connected client every **30 seconds**. Clients that do not respond with a `pong` are terminated on the next heartbeat cycle.

Standard WebSocket clients (browsers, the `ws` npm package) handle ping/pong automatically.

---

**Next:** See [Explanation](explanation.md) for the reasoning behind these design choices.
