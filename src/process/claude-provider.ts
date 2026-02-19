import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "../utils/logger.js";
import { BaseCliProvider, type RunOptions, type RunHandlers } from "./base-cli-provider.js";

export interface ClaudeProviderOptions {
  claudePath?: string;
  timeoutMs?: number;
  logger: Logger;
  sessionDir?: string;
  maxTurns?: number;    // default: unlimited (no --max-turns flag)
  tools?: string;       // default: not restricted (no --tools flag)
}

const ALLOWED_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "ANTHROPIC_API_KEY", "NODE_PATH", "XDG_CONFIG_HOME",
];

export class ClaudeProvider extends BaseCliProvider {
  private readonly claudePath: string;
  private readonly sessionDir: string;
  private readonly maxTurns: number | undefined;
  private readonly tools: string | undefined;

  constructor(options: ClaudeProviderOptions) {
    super(options.logger.child({ component: "claude-provider" }), options.timeoutMs);
    this.claudePath = options.claudePath ?? "claude";
    this.sessionDir = options.sessionDir ?? "bridge-ws-sessions";
    this.maxTurns = options.maxTurns;
    this.tools = options.tools;
  }

  protected spawnProcess(options: RunOptions, handlers: RunHandlers): ChildProcess | null {
    const { prompt, model, systemPrompt, projectId, requestId, thinkingTokens, images } = options;
    const hasImages = images && images.length > 0;

    const args = [
      "--print",
      "--verbose",
      "--output-format", "stream-json",
    ];

    if (this.maxTurns !== undefined) {
      args.push("--max-turns", String(this.maxTurns));
    }
    if (this.tools !== undefined) {
      args.push("--tools", this.tools);
    }
    if (hasImages) {
      args.push("--input-format", "stream-json");
    }
    if (projectId) {
      args.push("--continue");
    }
    if (model) {
      args.push("--model", model);
    }
    if (systemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
    }
    args.push("-");

    let cwd: string | undefined;
    if (projectId) {
      const base = resolve(tmpdir(), this.sessionDir);
      cwd = resolve(base, projectId);
      if (!cwd.startsWith(base + "/") && cwd !== base) {
        handlers.onError("Invalid projectId", requestId);
        return null;
      }
      mkdirSync(cwd, { recursive: true });
    }

    const env: Record<string, string> = {};
    if (thinkingTokens !== undefined) {
      env["MAX_THINKING_TOKENS"] = String(thinkingTokens);
    }
    for (const key of ALLOWED_ENV_KEYS) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    let proc: ChildProcess;
    try {
      proc = spawn(this.claudePath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
        env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start Claude";
      this.log.error({ err, requestId }, "Failed to spawn Claude process");
      handlers.onError(message, requestId);
      return null;
    }

    this.log.info({ requestId, model, promptLength: prompt.length, pid: proc.pid }, "Spawning Claude process");

    if (proc.stdin) {
      if (hasImages) {
        const content: Array<Record<string, unknown>> = [];
        for (const img of images!) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: img.media_type, data: img.data },
          });
        }
        content.push({ type: "text", text: prompt });
        const msg = JSON.stringify({ type: "user", message: { role: "user", content } });
        proc.stdin.write(msg + "\n");
      } else {
        proc.stdin.write(prompt);
      }
      proc.stdin.end();
    }

    return proc;
  }

  protected parseStreamLine(line: string, handlers: RunHandlers, requestId: string): void {
    if (!line.trim()) return;

    try {
      const event = JSON.parse(line);

      // Pattern 1: Raw content_block_delta
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          handlers.onChunk(event.delta.text, requestId);
        } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
          handlers.onChunk(event.delta.thinking, requestId, true);
        }
        return;
      }

      // Pattern 2: Wrapped in stream_event
      if (event.type === "stream_event" && event.event) {
        const inner = event.event;
        if (inner.type === "content_block_delta") {
          if (inner.delta?.type === "text_delta" && inner.delta.text) {
            handlers.onChunk(inner.delta.text, requestId);
          } else if (inner.delta?.type === "thinking_delta" && inner.delta.thinking) {
            handlers.onChunk(inner.delta.thinking, requestId, true);
          }
        }
        return;
      }

      // Pattern 3: Complete assistant message
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            handlers.onChunk(block.text, requestId);
          } else if (block.type === "thinking" && block.thinking) {
            handlers.onChunk(block.thinking, requestId, true);
          }
        }
        return;
      }

      // Result event — ignore (content already streamed)
      if (event.type === "result") return;

    } catch {
      // Non-JSON line, skip
    }
  }
}
