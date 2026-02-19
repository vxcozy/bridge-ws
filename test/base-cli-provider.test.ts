import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { type ChildProcess } from "node:child_process";
import { BaseCliProvider, type RunOptions, type RunHandlers } from "../src/process/base-cli-provider.js";
import { createLogger } from "../src/utils/logger.js";

// Minimal mock ChildProcess — stdout/stderr must be proper Readables for createInterface
function makeMockProcess(): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = { write: vi.fn(), end: vi.fn() };
  Object.assign(proc, { stdout, stderr, stdin, pid: 1234, kill: vi.fn() });
  return proc;
}

// Concrete subclass for testing
class TestProvider extends BaseCliProvider {
  spawnCalled = false;
  linesToEmit: string[] = [];
  failSpawn = false;

  protected spawnProcess(options: RunOptions, handlers: RunHandlers): ChildProcess | null {
    this.spawnCalled = true;
    if (this.failSpawn) {
      handlers.onError("spawn failed", options.requestId);
      return null;
    }
    return makeMockProcess();
  }

  protected parseStreamLine(line: string, handlers: RunHandlers, requestId: string): void {
    if (line === "CHUNK:hello") handlers.onChunk("hello", requestId);
    if (line === "ERROR:oops") handlers.onError("oops", requestId);
  }

  // Expose internal process for testing
  getProcess(): ChildProcess | null { return this.process; }
}

const log = createLogger({ level: "silent", pretty: false });

describe("BaseCliProvider", () => {
  let provider: TestProvider;
  let handlers: RunHandlers;
  const onChunk = vi.fn();
  const onComplete = vi.fn();
  const onError = vi.fn();

  beforeEach(() => {
    provider = new TestProvider(log, 5000);
    onChunk.mockReset();
    onComplete.mockReset();
    onError.mockReset();
    handlers = { onChunk, onComplete, onError };
  });

  it("calls spawnProcess on run()", () => {
    provider.run({ prompt: "hi", requestId: "r1" }, handlers);
    expect(provider.spawnCalled).toBe(true);
  });

  it("calls onError immediately if spawn fails", () => {
    provider.failSpawn = true;
    provider.run({ prompt: "hi", requestId: "r1" }, handlers);
    expect(onError).toHaveBeenCalledWith("spawn failed", "r1");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("calls onError if disposed", () => {
    provider.dispose();
    provider.run({ prompt: "hi", requestId: "r1" }, handlers);
    expect(onError).toHaveBeenCalledWith("Runner has been disposed", "r1");
  });

  it("calls onComplete on exit code 0", () => {
    provider.run({ prompt: "hi", requestId: "r1" }, handlers);
    const proc = provider.getProcess()!;
    proc.emit("exit", 0, null);
    expect(onComplete).toHaveBeenCalledWith("r1");
    expect(onError).not.toHaveBeenCalled();
  });

  it("calls onError on non-zero exit code", () => {
    provider.run({ prompt: "hi", requestId: "r1" }, handlers);
    const proc = provider.getProcess()!;
    proc.emit("exit", 1, null);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("code 1"), "r1");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not double-fire handlers (error + exit both fire)", () => {
    provider.run({ prompt: "hi", requestId: "r1" }, handlers);
    const proc = provider.getProcess()!;
    proc.emit("error", new Error("boom"));
    proc.emit("exit", 1, null);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("kill() terminates process and sets killed flag", () => {
    provider.run({ prompt: "hi", requestId: "r1" }, handlers);
    const proc = provider.getProcess()!;
    provider.kill();
    expect((proc.kill as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(provider.getProcess()).toBeNull();
  });

  it("killed process exit does not call onComplete or onError", () => {
    provider.run({ prompt: "hi", requestId: "r1" }, handlers);
    const proc = provider.getProcess()!;
    provider.kill();
    proc.emit("exit", 0, null);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
