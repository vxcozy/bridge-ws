# Explanation

> **Conceptual background for bridge-ws.**
>
> This document explains the design decisions behind bridge-ws and why it works the way it does. It is not a guide for doing things — see the [How-to guides](howto.md) for that.

---

## What bridge-ws actually is

bridge-ws is a thin WebSocket-to-CLI bridge. It does not implement any AI logic itself. It:

1. Opens a WebSocket server.
2. Receives a text prompt from a client.
3. Spawns a CLI process (`claude` or `codex`) with that prompt as an argument.
4. Reads the process stdout line by line, parses each line as a structured JSON event, and relays content chunks back to the client as they arrive.
5. Reports completion or failure when the process exits.

That's it. Everything else — model selection, tool execution, memory, context — is handled inside the CLI process. bridge-ws is intentionally ignorant of these details.

---

## The dumb-pipe philosophy

The design goal is to be a dumb pipe, not a smart proxy.

A smart proxy would understand the AI protocol, inject system prompts on behalf of the server, manage conversation history, implement retry logic, or transform model outputs. This creates coupling to the specific capabilities of a particular model or CLI version.

A dumb pipe forwards whatever the CLI produces, validates message framing, and handles connection lifecycle. When the CLI gains new features (new output event types, new flags), bridge-ws does not need to change.

The downside is that clients must understand the streaming protocol. The upside is that bridge-ws is simple, predictable, and unlikely to break when the underlying CLI evolves.

---

## Why WebSockets

Streaming AI responses are inherently push-based. The server pushes content chunks as they are produced; the client does not poll.

WebSockets provide a persistent, full-duplex channel over a single TCP connection. This makes them well-suited for:

- **Streaming responses**: chunks arrive in order, the server pushes without client requests.
- **Cancellation**: the client can send a `cancel` message at any time on the same connection.
- **Multiplexing**: multiple request/response pairs can coexist on a single connection, identified by `requestId`.

Server-Sent Events (SSE) would work for streaming but are unidirectional — cancellation would require a separate HTTP channel. HTTP streaming (chunked transfer encoding) has similar limitations.

---

## Request multiplexing

Each connection maintains a `Map<requestId, ActiveRequest>` instead of a single active request slot.

This allows a client to issue several prompts without waiting for prior responses to complete. Each response stream is identified by its `requestId`, so a client can route chunks to the right handler.

**The limit is that Claude requests on the same connection share one runner process.** The runner maintains session state (working directory, conversation context) across requests. Concurrent Claude requests on the same connection are therefore serialised at the process level — the second `run()` call waits for the first to exit before starting.

For true parallel Claude requests, use separate WebSocket connections. Each connection gets its own runner instance.

Codex requests are separate: a connection has a distinct codex runner alongside its claude runner.

---

## Provider model

bridge-ws supports two providers: `claude` and `codex`. The provider is specified per request.

Each provider is a subclass of `BaseCliProvider`, which handles the common lifecycle:

- Spawning the process with the correct environment
- Reading stdout line by line via `readline`
- Killing the process on timeout or cancellation
- Guarding against double-firing of `onComplete` / `onError`

Subclasses implement two methods:

- `spawnProcess()` — constructs CLI arguments and calls `spawn()`
- `parseStreamLine()` — interprets one line of stdout output

Claude uses `stream-json` NDJSON format; Codex uses JSONL. Each provider knows how to parse its own format.

---

## Runner reuse per connection

When a connection handles its first Claude request, a `ClaudeProvider` instance is created and stored on the connection state. Subsequent Claude requests on that connection reuse the same instance.

This design preserves Claude's session state. The Claude CLI maintains conversation history within a working directory. By keeping the same runner alive across requests on the same connection, a client can have a continuous conversation without re-supplying context.

Disposing a connection (on close or server shutdown) disposes both the claude and codex runners, releasing the underlying process.

---

## Why `requestId` is required on `cancel`

In the original design, a cancel message could have an optional `requestId` and would cancel the single active request if none was specified. With multiplexing, there may be multiple active requests simultaneously. An ambiguous cancel would be unsafe — it is not clear which request should be stopped.

Requiring `requestId` on cancel makes the operation unambiguous. Cancelling a non-existent `requestId` is an explicit error rather than a silent no-op, which makes client bugs easier to diagnose.

---

## Path traversal protection on `projectId`

The `projectId` field scopes requests to a subdirectory of the session directory. Because this value is used to construct a filesystem path, it must be restricted.

Validation rules:
- Only alphanumeric characters, hyphens, underscores, and dots are accepted.
- Maximum 128 characters.

This prevents directory traversal attacks (`../etc/passwd`) and shell injection via unusual characters.

---

## Authentication model

Authentication is optional and minimal: a single shared secret passed as a Bearer token on WebSocket upgrade.

This is appropriate for a server running locally or within a trusted network, accessed by a single application. It is not a multi-user access control system.

For stronger isolation, run bridge-ws behind a reverse proxy that handles TLS termination and more sophisticated authentication (OAuth, mTLS, etc.).

---

## Heartbeat

The server sends a WebSocket `ping` to every client every 30 seconds. If a client does not respond with a `pong` before the next ping cycle, the connection is terminated and any active runners are disposed.

This prevents zombie connections from accumulating when clients disconnect without sending a close frame (e.g. due to network interruption or process crash).

---

## Logging

bridge-ws uses [pino](https://getpino.io) for structured JSON logging. In production (pretty: false), every log line is a JSON object for easy ingestion by log aggregators. In development, use `--log-level debug` to see per-request detail.

The logger is injected into `AgentWebSocketServer` as a dependency, making it easy to replace with a compatible logger in tests or library use.

---

**See also:** [Tutorial](tutorial.md) — [How-to guides](howto.md) — [Reference](reference.md)
