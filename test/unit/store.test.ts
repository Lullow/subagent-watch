import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HookRecord } from "../../src/collector/record.ts";
import {
  initStore,
  logProblem,
  MAX_SESSION_BYTES,
  problemFile,
  removeExpired,
  RETENTION_MS,
  sessionFile,
  sessionsDir,
  writeRecord,
} from "../../src/collector/store.ts";
import { UnsafePathError } from "../../src/secure/fs.ts";

const NOW = 1_789_646_400_000;
const SESSION = "3f9a2c1e-7b4d-4e0a-9c55-1d2e8f6a7b90";
const OTHER = "0b8e1c2d-3a4f-4b5c-8d6e-7f8091a2b3c4";
const record: HookRecord = { v: 1, time: NOW, event: "PreToolUse", tool: "Read", tool_use_id: "toolu_1", detail: "docs/a.md" };
const mode = (path: string): number => statSync(path).mode & 0o7777;

function tempHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), "subagent-watch-store-")), ".subagent-watch");
  initStore(home);
  return home;
}

test("skriver en rad per händelse i en privat fil i en privat mapp", () => {
  const home = tempHome();
  assert.equal(writeRecord(home, SESSION, record), "appended");
  assert.equal(writeRecord(home, SESSION, { ...record, event: "PostToolUse" }), "appended");
  const lines = readFileSync(sessionFile(home, SESSION), "utf8").trim().split("\n");
  assert.deepEqual(lines.map((l) => JSON.parse(l).event), ["PreToolUse", "PostToolUse"]);
  assert.equal(mode(sessionFile(home, SESSION)), 0o600);
  assert.equal(mode(home), 0o700);
  assert.equal(mode(sessionsDir(home)), 0o700);
});

test("en för lång rad och en full session kastas", () => {
  const home = tempHome();
  assert.equal(writeRecord(home, SESSION, { ...record, detail: "x".repeat(3000) }), "line_too_long");
  assert.ok(!existsSync(sessionFile(home, SESSION)));

  writeFileSync(sessionFile(home, OTHER), Buffer.alloc(MAX_SESSION_BYTES - 10, 0x20), { mode: 0o600 });
  assert.equal(writeRecord(home, OTHER, record), "session_full");
  assert.equal(statSync(sessionFile(home, OTHER)).size, MAX_SESSION_BYTES - 10);
});

test("symlänkad sessions-mapp avvisas och målet lämnas orört", () => {
  const home = tempHome();
  const elsewhere = join(home, "..", "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  rmSync(sessionsDir(home), { recursive: true });
  symlinkSync(elsewhere, sessionsDir(home));
  assert.throws(() => writeRecord(home, SESSION, record), UnsafePathError);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("symlänkad eller hårt länkad sessionsfil avvisas och målet lämnas orört", () => {
  const home = tempHome();
  const target = join(home, "..", "target.txt");
  writeFileSync(target, "orörd\n", { mode: 0o600 });

  symlinkSync(target, sessionFile(home, SESSION));
  assert.throws(() => writeRecord(home, SESSION, record), /symbolisk länk/);

  linkSync(target, sessionFile(home, OTHER));
  assert.throws(() => writeRecord(home, OTHER, record), /hårda länkar/);
  assert.equal(readFileSync(target, "utf8"), "orörd\n");
});

test("rensningen tar bara bort gamla sessions- och problemfiler", () => {
  const home = tempHome();
  const dir = sessionsDir(home);
  const old = (NOW - RETENTION_MS - 60_000) / 1000;
  const recent = (NOW - RETENTION_MS + 60_000) / 1000;
  const file = (name: string, time: number) => {
    writeFileSync(join(dir, name), "{}\n", { mode: 0o600 });
    utimesSync(join(dir, name), time, time);
  };
  file(`${SESSION}.jsonl`, old);
  file(`${OTHER}.jsonl`, recent);
  file("problems-2026-09-15.jsonl", old);
  file("anteckningar.txt", old);
  file(`${SESSION.toUpperCase()}.jsonl`, old);
  const outside = join(home, "..", "outside.jsonl");
  writeFileSync(outside, "{}\n", { mode: 0o600 });
  symlinkSync(outside, join(dir, "0c8e1c2d-3a4f-4b5c-8d6e-7f8091a2b3c4.jsonl"));
  mkdirSync(join(dir, "1d8e1c2d-3a4f-4b5c-8d6e-7f8091a2b3c4.jsonl"));

  assert.equal(removeExpired(home, NOW), 2);
  assert.deepEqual(readdirSync(dir).sort(), [
    "0c8e1c2d-3a4f-4b5c-8d6e-7f8091a2b3c4.jsonl",
    `${OTHER}.jsonl`,
    "1d8e1c2d-3a4f-4b5c-8d6e-7f8091a2b3c4.jsonl",
    `${SESSION.toUpperCase()}.jsonl`,
    "anteckningar.txt",
  ].sort());
  assert.ok(existsSync(outside));
});

test("problem sparas med bara orsak och tid, och loggningen kastar aldrig", () => {
  assert.doesNotThrow(() => logProblem("/finns/inte/.subagent-watch", "not_json", NOW));
  const home = tempHome();
  logProblem(home, "not_json", NOW);
  logProblem(home, "session_full", NOW);
  const path = problemFile(home, NOW);
  assert.equal(path, join(sessionsDir(home), "problems-2026-09-17.jsonl"));
  assert.deepEqual(readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)), [
    { time: NOW, kind: "not_json" },
    { time: NOW, kind: "session_full" },
  ]);
  assert.equal(mode(path), 0o600);
});
