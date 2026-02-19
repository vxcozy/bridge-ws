import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "../utils/logger.js";
import { BaseCliProvider, type RunOptions, type RunHandlers } from "./base-cli-provider.js";

export interface CodexProviderOptions {
  codexPath?: string;
  timeoutMs?: number;
  logger: Logger;
  sessionDir?: string;
}

const ALLOWED_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "OPENAI_API_KEY", "NODE_PATH", "XDG_CONFIG_HOME",
];

export class CodexProvider extends BaseCliProvider {
  private readonly codexPath: string;
  private readonly sessionDir: string;
  private threadId: string | null = null;
  private currentImagePaths: string[] = [];

  constructor(options: CodexProviderOptions) {
    super(options.logger.child({ component: "codex-provider" }), options.timeoutMs);
    this.codexPath = options.codexPath ?? "codex";
    this.sessionDir = options.sessionDir ?? "bridge-ws-sessions";
  }

  protected spawnProcess(options: RunOptions, handlers: RunHandlers): ChildProcess | null {
    const { prompt, model, systemPrompt, projectId, requestId, images } = options;

    let fullPrompt = prompt;
    if (systemPrompt) {
      fullPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;
    }

    // Write images to temp files for the -i flag
    this.currentImagePaths = [];
    if (images && images.length > 0) {
      const imgDir = resolve(tmpdir(), "bridge-ws-images");
      mkdirSync(imgDir, { recursive: true });
      const safeId = requestId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      for (let i = 0; i < images.length; i++) {
        const img = images[i]!;
        const rawExt = img.media_type.split("/")[1] || "png";
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "png";
        const imgPath = join(imgDir, `${safeId}-${i}.${ext}`);
        writeFileSync(imgPath, Buffer.from(img.data, "base64"));
        this.currentImagePaths.push(imgPath);
      }
    }

    const resuming = projectId && this.threadId;
    const args: string[] = resuming
      ? ["exec", "resume", this.threadId!, "--json", "--full-auto", "--skip-git-repo-check"]
      : ["exec", "--json", "--full-auto", "--skip-git-repo-check"];

    if (model && !resuming) {
      args.push("--model", model);
    }
    for (const imgPath of this.currentImagePaths) {
      args.push("-i", imgPath);
    }
    args.push("-");

    let cwd: string | undefined;
    if (projectId) {
      const base = resolve(tmpdir(), this.sessionDir);
      cwd = resolve(base, projectId);
      if (!cwd.startsWith(base + "/") && cwd !== base) {
        this.cleanupImages();
        handlers.onError("Invalid projectId", requestId);
        return null;
      }
      mkdirSync(cwd, { recursive: true });
    }

    const env: Record<string, string> = {};
    for (const key of ALLOWED_ENV_KEYS) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    let proc: ChildProcess;
    try {
      proc = spawn(this.codexPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
        env,
      });
    } catch (err) {
      this.cleanupImages();
      const message = err instanceof Error ? err.message : "Failed to start Codex";
      this.log.error({ err, requestId }, "Failed to spawn Codex process");
      handlers.onError(message, requestId);
      return null;
    }

    this.log.info({ requestId, model, promptLength: prompt.length, pid: proc.pid }, "Spawning Codex process");

    if (proc.stdin) {
      proc.stdin.write(fullPrompt);
      proc.stdin.end();
    }

    return proc;
  }

  protected parseStreamLine(line: string, handlers: RunHandlers, requestId: string): void {
    if (!line.trim()) return;

    try {
      const event = JSON.parse(line);

      if (event.type === "thread.started" && event.thread_id) {
        this.threadId = event.thread_id;
        this.log.debug({ threadId: this.threadId, requestId }, "Captured Codex thread ID");
        return;
      }

      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        handlers.onChunk(event.item.text, requestId);
        return;
      }

      if (event.type === "item.completed" && event.item?.type === "reasoning" && event.item.text) {
        handlers.onChunk(event.item.text, requestId, true);
        return;
      }

      if (event.type === "turn.failed") {
        const msg = event.error?.message || event.message || "Codex turn failed";
        handlers.onError(msg, requestId);
        return;
      }

      if (event.type === "error") {
        const msg = event.message || event.error?.message || "Codex error";
        handlers.onError(msg, requestId);
        return;
      }
    } catch {
      // Non-JSON line, skip
    }
  }

  protected onProcessExit(_options: RunOptions): void {
    this.cleanupImages();
  }

  private cleanupImages(): void {
    for (const p of this.currentImagePaths) {
      try { unlinkSync(p); } catch { /* already cleaned */ }
    }
    this.currentImagePaths = [];
  }
}
