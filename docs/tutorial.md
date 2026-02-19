# Tutorial: Your First Bridge

> **Goal:** Get bridge-ws running locally and send your first prompt to Claude through a WebSocket connection.
>
> This tutorial assumes you have Node.js ≥ 20 and Claude Code installed. You do not need prior WebSocket experience.

---

## Step 1 — Install

```bash
npm install -g bridge-ws
```

Or run without installing:

```bash
npx bridge-ws
```

## Step 2 — Verify Claude is available

bridge-ws bridges to the Claude CLI. Check it is installed:

```bash
claude --version
```

If Claude is not found, install it:

```bash
npm install -g @anthropic-ai/claude-code
```

## Step 3 — Start the server

```bash
bridge-ws
```

You should see:

```
╔═══════════════════════════════════════╗
║          bridge-ws v2.0.0             ║
║     CLI AI Agent Bridge              ║
╚═══════════════════════════════════════╝

Found Claude CLI: 1.x.x
bridge-ws running on ws://localhost:9999
Health check: http://localhost:9999/healthz
Press Ctrl+C to stop
```

The server is now listening for WebSocket connections on port 9999.

## Step 4 — Send your first prompt

Open a new terminal and run this Node.js snippet:

```js
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:9999");

ws.on("open", () => {
  console.log("Connected to bridge-ws");
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === "connected") {
    // Server is ready — send a prompt
    ws.send(JSON.stringify({
      type: "prompt",
      prompt: "Say hello in one sentence.",
      requestId: "req-1",
    }));
  }

  if (msg.type === "chunk") {
    process.stdout.write(msg.content);
  }

  if (msg.type === "complete") {
    console.log("\n\nDone.");
    ws.close();
  }

  if (msg.type === "error") {
    console.error("Error:", msg.message);
    ws.close();
  }
});
```

Save as `client.mjs` and run:

```bash
node client.mjs
```

You will see Claude's response streamed back chunk by chunk.

## Step 5 — Try multiple requests on one connection

Unlike v1, bridge-ws handles multiple requests simultaneously on a single connection. Extend the client:

```js
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === "connected") {
    // Send two prompts at the same time
    ws.send(JSON.stringify({
      type: "prompt",
      prompt: "What is 2 + 2?",
      requestId: "math",
    }));

    ws.send(JSON.stringify({
      type: "prompt",
      prompt: "What colour is the sky?",
      requestId: "sky",
      provider: "claude",
    }));
  }

  if (msg.type === "chunk") {
    console.log(`[${msg.requestId}] ${msg.content}`);
  }

  if (msg.type === "complete") {
    console.log(`[${msg.requestId}] Done.`);
  }
});
```

Both responses stream back independently, tagged by their `requestId`.

## What you learned

- How to start bridge-ws
- The basic message flow: `connected` → send `prompt` → receive `chunk`s → `complete`
- How to send multiple concurrent requests using `requestId`

**Next:** See the [How-to guides](howto.md) for common tasks like enabling auth, controlling Claude's tools, and cancelling requests.
