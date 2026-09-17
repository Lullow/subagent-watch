// S11: turns the raw hook logs in spike/runs/ (never checked in) into test data in
// test/fixtures/runs/, through the same filtering and masking as the collector.
//   npm run testdata
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseHook } from "../src/collector/record.ts";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "spike", "runs");
const target = join(root, "test", "fixtures", "runs");

let files: string[];
try {
  files = readdirSync(source).filter((f) => f.endsWith(".jsonl")).sort();
} catch {
  console.error("spike/runs/ saknas. Testdata kan bara skapas där rådatan finns.");
  process.exit(1);
}

mkdirSync(target, { recursive: true });
files.forEach((file, index) => {
  // Real session ids are replaced, so the test data cannot be matched to a transcript.
  const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const line of readFileSync(join(source, file), "utf8").trim().split("\n")) {
    const { at, ...event } = JSON.parse(line) as { at: string; session_id?: string };
    const result = parseHook(JSON.stringify({ ...event, session_id: sessionId }), Date.parse(at), homedir());
    if (result.ok) kept.push(JSON.stringify(result.record));
    else dropped.push(result.reason);
  }
  writeFileSync(join(target, file), `${kept.join("\n")}\n`);
  console.log(`${basename(file)}: ${kept.length} händelser${dropped.length ? `, kastade: ${dropped.join(", ")}` : ""}`);
});
