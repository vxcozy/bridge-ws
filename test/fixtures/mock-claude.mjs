#!/usr/bin/env node
/**
 * Mock Claude CLI for E2E testing.
 * Reads stdin and emits a predictable stream-json response.
 */

const args = process.argv.slice(2);

// Handle --version check from claude-check.ts
if (args.includes("--version")) {
  process.stdout.write("mock-claude 1.0.0\n");
  process.exit(0);
}

// Read stdin prompt
let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  // Emit a content_block_delta event then a result event
  const chunk = JSON.stringify({
    type: "content_block_delta",
    delta: { type: "text_delta", text: `echo: ${input.trim()}` },
  });
  process.stdout.write(chunk + "\n");

  const result = JSON.stringify({ type: "result", subtype: "success" });
  process.stdout.write(result + "\n");

  process.exit(0);
});
