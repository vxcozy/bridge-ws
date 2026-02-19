import { stripVTControlCharacters } from "node:util";

/**
 * Clean PTY output by removing ANSI/VT control sequences, carriage returns, and BEL characters.
 * Uses Node.js built-in `stripVTControlCharacters` (available since Node 16.11).
 *
 * Exported as a library utility for consumers who use PTY-based transports.
 * The built-in runners use stdio pipes and don't require this internally.
 */
export function cleanOutput(data: string): string {
  // 1. Strip OSC sequences (ESC ] ... BEL/ST) first, since they use BEL as terminator
  const withoutOsc = data.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
  // 2. Strip CSI sequences with private parameter prefixes (<, =, >).
  const withoutPrivateCsi = withoutOsc.replace(/\x1B\[[<>=][0-9;]*[a-zA-Z]/g, "");
  // 3. Remove stray BEL characters
  const withoutBel = withoutPrivateCsi.replace(/\x07/g, "");
  // 4. Strip remaining ANSI/VT control sequences and carriage returns
  return stripVTControlCharacters(withoutBel).replace(/\r/g, "");
}
