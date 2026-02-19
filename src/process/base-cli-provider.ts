import { type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Logger } from "../utils/logger.js";
import type { PromptImage } from "../server/protocol.js";

export interface RunOptions {
  prompt: string;
  model?: string;
  systemPrompt?: string;
  projectId?: string;
  requestId: string;
  thinkingTokens?: number;
  images?: PromptImage[];
}

export interface RunHandlers {
  onChunk: (content: string, requestId: string, thinking?: boolean) => void;
  onComplete: (requestId: string) => void;
  onError: (message: string, requestId: string) => void;
}

export interface Runner {
  run(options: RunOptions, handlers: RunHandlers): void;
  kill(): void;
  dispose(): void;
}

export type RunnerFactory = (log: Logger) => Runner;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Abstract base for CLI-based providers (Claude, Codex).
 * Handles the shared mechanics: timeout, stderr capture, kill, dispose,
 * handlersDone guard, and exit/error events.
 *
 * Subclasses implement:
 *   - spawnProcess(): spawn the child process and write to stdin
 *   - parseStreamLine(): parse a single line of CLI output
 */
export abstract class BaseCliProvider implements Runner {
  protected process: ChildProcess | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private disposed = false;
  protected killed = false;
  protected readonly log: Logger;
  protected readonly timeoutMs: number;

  constructor(log: Logger, timeoutMs?: number) {
    this.log = log;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get isRunning(): boolean {
    return this.process !== null;
  }

  run(options: RunOptions, handlers: RunHandlers): void {
    if (this.disposed) {
      handlers.onError("Runner has been disposed", options.requestId);
      return;
    }

    this.kill();

    const { requestId } = options;
    this.killed = false;

    // Subclass spawns the process and writes to stdin
    const proc = this.spawnProcess(options, handlers);
    if (!proc) return; // subclass already called handlers.onError
    this.process = proc;

    // Guard against double handler invocation (error + exit can both fire)
    let handlersDone = false;
    const finish = (cb: () => void) => {
      if (handlersDone) return;
      handlersDone = true;
      this.clearTimeout();
      cb();
    };

    this.timeout = setTimeout(() => {
      this.log.warn({ requestId }, "Process timed out");
      this.kill();
      finish(() => handlers.onError("Process timed out", requestId));
    }, this.timeoutMs);

    // Parse stdout line by line
    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      rl.on("line", (line) => {
        this.parseStreamLine(line, handlers, requestId);
      });
    }

    // Capture stderr
    if (this.process.stderr) {
      const stderrRl = createInterface({ input: this.process.stderr });
      stderrRl.on("line", (line) => {
        if (line.trim()) {
          this.log.warn({ requestId, stderr: line }, "stderr");
        }
      });
    }

    this.process.on("exit", (exitCode, signal) => {
      this.process = null;
      this.onProcessExit(options);

      if (this.killed) {
        this.log.debug({ requestId }, "Process was killed");
        return;
      }

      if (exitCode === 0) {
        this.log.info({ requestId }, "Process completed successfully");
        finish(() => handlers.onComplete(requestId));
      } else {
        const reason = exitCode !== null
          ? `CLI exited with code ${exitCode}`
          : `CLI killed by signal ${signal ?? "unknown"}`;
        this.log.warn({ requestId, exitCode, signal }, reason);
        finish(() => handlers.onError(reason, requestId));
      }
    });

    this.process.on("error", (err) => {
      this.process = null;
      this.onProcessExit(options);
      this.log.error({ err, requestId }, "Process error");
      finish(() => handlers.onError(err.message, requestId));
    });
  }

  kill(): void {
    this.clearTimeout();
    if (this.process) {
      this.log.debug({ pid: this.process.pid }, "Killing process");
      this.killed = true;
      try {
        this.process.kill();
      } catch {
        // Process may already be dead
      }
      this.process = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
  }

  private clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  /**
   * Spawn the child process and write prompt to stdin.
   * Return the ChildProcess on success, or null after calling handlers.onError.
   */
  protected abstract spawnProcess(options: RunOptions, handlers: RunHandlers): ChildProcess | null;

  /**
   * Parse a single line of stdout output and call handlers as appropriate.
   */
  protected abstract parseStreamLine(line: string, handlers: RunHandlers, requestId: string): void;

  /**
   * Called on process exit/error. Subclasses can override to do cleanup
   * (e.g. Codex runner deletes temp image files).
   */
  protected onProcessExit(_options: RunOptions): void {
    // no-op by default
  }
}
