import type { Logger } from "../utils/logger.js";
import type { Runner, RunOptions, RunHandlers } from "./base-cli-provider.js";

export interface OllamaProviderOptions {
  baseUrl?: string;     // default: http://localhost:11434
  timeoutMs?: number;   // default: 300_000
  logger: Logger;
}

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MODEL = "llama3.2";

/**
 * Ollama provider — streams responses from a local Ollama server via its
 * HTTP API (POST /api/generate). No subprocess; no API key required.
 */
export class OllamaProvider implements Runner {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  protected readonly log: Logger;

  // AbortController for the active fetch request
  private abortController: AbortController | null = null;
  private disposed = false;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.logger.child({ component: "ollama-provider" });
  }

  run(options: RunOptions, handlers: RunHandlers): void {
    if (this.disposed) {
      handlers.onError("Runner has been disposed", options.requestId);
      return;
    }

    // Kill any in-flight request before starting a new one
    this.kill();

    const { prompt, model, systemPrompt, requestId } = options;
    const resolvedModel = model ?? DEFAULT_MODEL;

    this.log.info({ requestId, model: resolvedModel, promptLength: prompt.length }, "Starting Ollama request");

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const timeoutHandle = setTimeout(() => {
      this.log.warn({ requestId }, "Ollama request timed out");
      this.kill();
      handlers.onError("Request timed out", requestId);
    }, this.timeoutMs);

    const body: Record<string, unknown> = {
      model: resolvedModel,
      prompt,
      stream: true,
    };

    if (systemPrompt) {
      body["system"] = systemPrompt;
    }

    this.fetchStream(body, signal, requestId, handlers)
      .catch((err: unknown) => {
        if (signal.aborted) return; // killed intentionally — suppress
        const message = err instanceof Error ? err.message : "Ollama request failed";
        this.log.error({ err, requestId }, "Ollama fetch error");
        handlers.onError(message, requestId);
      })
      .finally(() => {
        clearTimeout(timeoutHandle);
        this.abortController = null;
      });
  }

  private async fetchStream(
    body: Record<string, unknown>,
    signal: AbortSignal,
    requestId: string,
    handlers: RunHandlers,
  ): Promise<void> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err: unknown) {
      if (signal.aborted) return;
      // Connection refused / server not running
      const message = err instanceof Error && err.message.includes("ECONNREFUSED")
        ? `Ollama server not reachable at ${this.baseUrl}. Is Ollama running?`
        : (err instanceof Error ? err.message : "Failed to connect to Ollama");
      throw new Error(message);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ollama returned HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    if (!response.body) {
      throw new Error("Ollama response has no body");
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let handlersDone = false;

    const finish = (cb: () => void) => {
      if (handlersDone) return;
      handlersDone = true;
      cb();
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) return;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // last incomplete line stays in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as {
              response?: string;
              done?: boolean;
              error?: string;
            };

            if (event.error) {
              finish(() => handlers.onError(event.error!, requestId));
              return;
            }

            if (event.response) {
              handlers.onChunk(event.response, requestId);
            }

            if (event.done) {
              this.log.info({ requestId }, "Ollama request completed");
              finish(() => handlers.onComplete(requestId));
              return;
            }
          } catch {
            // Non-JSON line — skip
          }
        }
      }

      // Stream ended without a done:true event — but only complete if not aborted
      if (signal.aborted) return;
      finish(() => handlers.onComplete(requestId));
    } finally {
      reader.releaseLock();
    }
  }

  kill(): void {
    if (this.abortController) {
      this.log.debug("Aborting Ollama request");
      this.abortController.abort();
      this.abortController = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
  }
}
