import { describe, it, expect } from "vitest";
import { parseClientMessage } from "../src/server/protocol.js";

describe("parseClientMessage", () => {
  describe("prompt messages", () => {
    it("parses a minimal valid prompt", () => {
      const result = parseClientMessage(JSON.stringify({
        type: "prompt",
        prompt: "hello",
        requestId: "req-1",
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.message.type).toBe("prompt");
      expect(result.message.prompt).toBe("hello");
      expect(result.message.requestId).toBe("req-1");
    });

    it("defaults provider to claude when omitted", () => {
      const result = parseClientMessage(JSON.stringify({
        type: "prompt", prompt: "hi", requestId: "r1",
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.message.provider).toBe("claude");
    });

    it("accepts codex as provider", () => {
      const result = parseClientMessage(JSON.stringify({
        type: "prompt", prompt: "hi", requestId: "r1", provider: "codex",
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.message.provider).toBe("codex");
    });

    it("rejects unknown provider", () => {
      const result = parseClientMessage(JSON.stringify({
        type: "prompt", prompt: "hi", requestId: "r1", provider: "gpt4",
      }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/Unknown provider/);
    });

    it("rejects missing prompt", () => {
      const result = parseClientMessage(JSON.stringify({ type: "prompt", requestId: "r1" }));
      expect(result.ok).toBe(false);
    });

    it("rejects empty prompt", () => {
      const result = parseClientMessage(JSON.stringify({ type: "prompt", prompt: "", requestId: "r1" }));
      expect(result.ok).toBe(false);
    });

    it("rejects missing requestId", () => {
      const result = parseClientMessage(JSON.stringify({ type: "prompt", prompt: "hi" }));
      expect(result.ok).toBe(false);
    });

    it("rejects invalid projectId characters", () => {
      const result = parseClientMessage(JSON.stringify({
        type: "prompt", prompt: "hi", requestId: "r1", projectId: "../etc/passwd",
      }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/projectId/);
    });

    it("accepts valid projectId", () => {
      const result = parseClientMessage(JSON.stringify({
        type: "prompt", prompt: "hi", requestId: "r1", projectId: "my-project_1.0",
      }));
      expect(result.ok).toBe(true);
    });
  });

  describe("cancel messages", () => {
    it("parses a valid cancel with requestId", () => {
      const result = parseClientMessage(JSON.stringify({ type: "cancel", requestId: "req-1" }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.message.type).toBe("cancel");
      expect(result.message.requestId).toBe("req-1");
    });

    it("rejects cancel without requestId", () => {
      const result = parseClientMessage(JSON.stringify({ type: "cancel" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/requestId/);
    });

    it("rejects cancel with empty requestId", () => {
      const result = parseClientMessage(JSON.stringify({ type: "cancel", requestId: "" }));
      expect(result.ok).toBe(false);
    });
  });

  describe("error cases", () => {
    it("rejects invalid JSON", () => {
      const result = parseClientMessage("not json");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("Invalid JSON");
    });

    it("rejects unknown message type", () => {
      const result = parseClientMessage(JSON.stringify({ type: "unknown" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/Unknown message type/);
    });

    it("rejects non-object messages", () => {
      const result = parseClientMessage(JSON.stringify(["array"]));
      expect(result.ok).toBe(false);
    });
  });
});
