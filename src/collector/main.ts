import "./silence.ts";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { UnsafePathError } from "../secure/fs.ts";
import { parseHook } from "./record.ts";
import { defaultHome, logProblem, removeExpired, writeRecord } from "./store.ts";

/** Below the hook timeout of 3 s, so the collector always ends on its own. */
const STDIN_TIMEOUT_MS = 2000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

function readStdin(): Promise<Buffer | "too_large"> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Buffer | "too_large") => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        process.stdin.destroy();
        finish("too_large");
      } else {
        chunks.push(chunk);
      }
    });
    process.stdin.on("end", () => finish(Buffer.concat(chunks)));
    process.stdin.on("error", () => finish(Buffer.alloc(0)));
  });
}

/** The store location comes from argv, never from the environment. */
function homeFromArgs(args: readonly string[]): string | undefined {
  const arg = args.find((a) => a.startsWith("--home="));
  if (arg === undefined) return defaultHome();
  const home = arg.slice("--home=".length);
  return isAbsolute(home) ? home : undefined;
}

async function main(): Promise<void> {
  const home = homeFromArgs(process.argv.slice(2));
  const input = await readStdin();
  const now = Date.now();
  if (home === undefined) return;
  if (input === "too_large") return logProblem(home, "too_large", now);

  const parsed = parseHook(input.toString("utf8"), now, homedir());
  if (!parsed.ok) return logProblem(home, parsed.reason, now);

  try {
    const result = writeRecord(home, parsed.sessionId, parsed.record);
    if (result !== "appended") logProblem(home, result, now);
    if (parsed.record.event === "SessionStart") removeExpired(home, now);
  } catch (error) {
    logProblem(home, error instanceof UnsafePathError ? "unsafe_path" : "write_failed", now);
  }
}

const guard = setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS);

main()
  .catch(() => undefined)
  .finally(() => {
    clearTimeout(guard);
    process.exitCode = 0;
  });
