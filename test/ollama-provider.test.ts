import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider } from "../src/process/ollama-provider.js";
import type { RunHandlers } from "../src/process/base-cli-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeHandlers() {
  return {
    onChunk: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  } as RunHandlers;
}

/**
 * Build a fake Response whose body is a ReadableStream that emits the given
 * ndjson lines, then closes.
 */
function mockOllamaResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OllamaProvider", () => {
  let globalFetch: typeof fetch;

  beforeEach(() => {
    globalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = globalFetch;
    vi.restoreAllMocks();
  });

  // --- Happy-path streaming ---

  it("streams chunks and calls onComplete on done:true", async () => {
    const lines = [
      JSON.stringify({ model: "llama3.2", response: "Hello", done: false }),
      JSON.stringify({ model: "llama3.2", response: " world", done: false }),
      JSON.stringify({ model: "llama3.2", response: "", done: true }),
    ];

    global.fetch = vi.fn().mockResolvedValueOnce(mockOllamaResponse(lines));

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onComplete = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-1" }, handlers);
    });

    expect(handlers.onChunk).toHaveBeenCalledTimes(2);
    expect(handlers.onChunk).toHaveBeenNthCalledWith(1, "Hello", "req-1");
    expect(handlers.onChunk).toHaveBeenNthCalledWith(2, " world", "req-1");
    expect(handlers.onComplete).toHaveBeenCalledWith("req-1");
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("calls onComplete when stream ends without done:true", async () => {
    const lines = [
      JSON.stringify({ response: "partial", done: false }),
    ];

    global.fetch = vi.fn().mockResolvedValueOnce(mockOllamaResponse(lines));

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onComplete = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-2" }, handlers);
    });

    expect(handlers.onComplete).toHaveBeenCalledWith("req-2");
  });

  // --- System prompt ---

  it("includes system field when systemPrompt is provided", async () => {
    const lines = [JSON.stringify({ response: "ok", done: true })];
    const mockFetch = vi.fn().mockResolvedValueOnce(mockOllamaResponse(lines));
    global.fetch = mockFetch;

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onComplete = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-3", systemPrompt: "Be concise" }, handlers);
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.system).toBe("Be concise");
  });

  it("omits system field when systemPrompt is not provided", async () => {
    const lines = [JSON.stringify({ response: "ok", done: true })];
    const mockFetch = vi.fn().mockResolvedValueOnce(mockOllamaResponse(lines));
    global.fetch = mockFetch;

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onComplete = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-4" }, handlers);
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.system).toBeUndefined();
  });

  // --- Model selection ---

  it("uses provided model", async () => {
    const lines = [JSON.stringify({ response: "ok", done: true })];
    const mockFetch = vi.fn().mockResolvedValueOnce(mockOllamaResponse(lines));
    global.fetch = mockFetch;

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onComplete = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-5", model: "mistral" }, handlers);
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.model).toBe("mistral");
  });

  it("uses default model (llama3.2) when none is provided", async () => {
    const lines = [JSON.stringify({ response: "ok", done: true })];
    const mockFetch = vi.fn().mockResolvedValueOnce(mockOllamaResponse(lines));
    global.fetch = mockFetch;

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onComplete = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-6" }, handlers);
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.model).toBe("llama3.2");
  });

  // --- Error field in event ---

  it("calls onError when event contains an error field", async () => {
    const lines = [
      JSON.stringify({ error: "model not found" }),
    ];
    global.fetch = vi.fn().mockResolvedValueOnce(mockOllamaResponse(lines));

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onError = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-7" }, handlers);
    });

    expect(handlers.onError).toHaveBeenCalledWith("model not found", "req-7");
    expect(handlers.onComplete).not.toHaveBeenCalled();
  });

  // --- HTTP errors ---

  it("calls onError on HTTP 500", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("internal error", { status: 500 }),
    );

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onError = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-8" }, handlers);
    });

    expect(handlers.onError).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 500"),
      "req-8",
    );
  });

  it("calls onError with helpful message when server is unreachable (ECONNREFUSED)", async () => {
    const err = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    global.fetch = vi.fn().mockRejectedValueOnce(err);

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onError = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-9" }, handlers);
    });

    expect(handlers.onError).toHaveBeenCalledWith(
      expect.stringContaining("not reachable"),
      "req-9",
    );
  });

  // --- Cancellation ---

  it("kill() aborts an in-flight request and suppresses errors", async () => {
    // A stream that never finishes (so we can cancel it mid-flight)
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) { streamController = c; },
    });
    const response = new Response(body, { status: 200 });

    global.fetch = vi.fn().mockResolvedValueOnce(response);

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    // Start the request, then immediately kill it
    provider.run({ prompt: "hi", requestId: "req-10" }, handlers);

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    provider.kill();

    // Close the stream so fetchStream's read loop can exit
    streamController.close();

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // After kill, no completion or error should fire
    expect(handlers.onComplete).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  // --- Dispose ---

  it("dispose() marks the runner as disposed and rejects new runs", () => {
    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    provider.dispose();
    provider.run({ prompt: "hi", requestId: "req-11" }, handlers);

    expect(handlers.onError).toHaveBeenCalledWith("Runner has been disposed", "req-11");
  });

  // --- Custom base URL ---

  it("uses the provided baseUrl", async () => {
    const lines = [JSON.stringify({ response: "ok", done: true })];
    const mockFetch = vi.fn().mockResolvedValueOnce(mockOllamaResponse(lines));
    global.fetch = mockFetch;

    const log = makeLogger();
    const provider = new OllamaProvider({ baseUrl: "http://custom-host:9999", logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onComplete = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-12" }, handlers);
    });

    expect(mockFetch.mock.calls[0][0]).toBe("http://custom-host:9999/api/generate");
  });

  // --- Skips non-JSON lines ---

  it("silently skips non-JSON lines in the stream", async () => {
    const lines = [
      "not json",
      JSON.stringify({ response: "hi", done: false }),
      "also not json",
      JSON.stringify({ response: "", done: true }),
    ];
    global.fetch = vi.fn().mockResolvedValueOnce(mockOllamaResponse(lines));

    const log = makeLogger();
    const provider = new OllamaProvider({ logger: log as never });
    const handlers = makeHandlers();

    await new Promise<void>((resolve) => {
      handlers.onComplete = vi.fn().mockImplementation(() => resolve());
      provider.run({ prompt: "hi", requestId: "req-13" }, handlers);
    });

    expect(handlers.onChunk).toHaveBeenCalledTimes(1);
    expect(handlers.onChunk).toHaveBeenCalledWith("hi", "req-13");
    expect(handlers.onComplete).toHaveBeenCalledWith("req-13");
  });
});
