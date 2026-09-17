import assert from "node:assert/strict";
import { appendFileSync, linkSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initStore, logProblem, MAX_SESSION_BYTES, sessionFile, sessionsDir } from "../../src/collector/store.ts";
import { SessionStore } from "../../src/model/reader.ts";
import { UnsafePathError } from "../../src/secure/fs.ts";

const NOW = 1_789_646_400_000;
const SESSION = "3f9a2c1e-7b4d-4e0a-9c55-1d2e8f6a7b90";
const OTHER = "0b8e1c2d-3a4f-4b5c-8d6e-7f8091a2b3c4";
const line = (time: number, event = "Stop") => `${JSON.stringify({ v: 1, time, event })}\n`;

function tempHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), "subagent-watch-reader-")), ".subagent-watch");
  initStore(home);
  return home;
}

test("läser nya rader stegvis och väntar på en rad som inte är färdigskriven", () => {
  const home = tempHome();
  const path = sessionFile(home, SESSION);
  writeFileSync(path, line(1) + line(2), { mode: 0o600 });
  const store = new SessionStore(home);
  assert.deepEqual(store.refresh(NOW).sessions.map((s) => [s.id, s.records.length]), [[SESSION, 2]]);

  appendFileSync(path, `${line(3)}{"v":1,"time":4,"ev`);
  assert.equal(store.refresh(NOW).sessions[0]!.records.length, 3);
  appendFileSync(path, `ent":"Stop"}\n`);
  assert.deepEqual(store.refresh(NOW).sessions[0]!.records.map((r) => r.time), [1, 2, 3, 4]);
});

test("en fil som återskapas med samma namn märks även när första läsningen saknade en hel rad", () => {
  const home = tempHome();
  const path = sessionFile(home, SESSION);
  writeFileSync(path, '{"v":1,"ti', { mode: 0o600 });
  const store = new SessionStore(home);
  assert.equal(store.refresh(NOW).sessions[0]!.records.length, 0);
  appendFileSync(path, `me":1,"event":"Stop"}\n`);
  assert.equal(store.refresh(NOW).sessions[0]!.records.length, 1);
  rmSync(path);
  writeFileSync(path, line(5) + line(6), { mode: 0o600 });
  assert.deepEqual(store.refresh(NOW).sessions[0]!.records.map((r) => r.time), [5, 6]);
});

test("rader som inte följer schemat räknas men används inte", () => {
  const home = tempHome();
  writeFileSync(sessionFile(home, SESSION), `${line(1)}inte json\n${JSON.stringify({ v: 1, time: 2, event: "Stop", prompt: "hemlig" })}\n${line(3)}`, { mode: 0o600 });
  const [session] = new SessionStore(home).refresh(NOW).sessions;
  assert.deepEqual([session!.records.map((r) => r.time), session!.rejected], [[1, 3], 2]);
});

test("en ersatt eller kortad fil läses om från början", () => {
  const home = tempHome();
  const path = sessionFile(home, SESSION);
  writeFileSync(path, line(1) + line(2), { mode: 0o600 });
  const store = new SessionStore(home);
  store.refresh(NOW);
  truncateSync(path, 0);
  appendFileSync(path, line(9));
  assert.deepEqual(store.refresh(NOW).sessions[0]!.records.map((r) => r.time), [9]);
  rmSync(path);
  writeFileSync(path, line(7) + line(8), { mode: 0o600 });
  assert.deepEqual(store.refresh(NOW).sessions[0]!.records.map((r) => r.time), [7, 8]);
  rmSync(path);
  assert.deepEqual(store.refresh(NOW).sessions, []);
});

test("symlänkar, hårda länkar, fel rättigheter och för stora filer avvisas", () => {
  const home = tempHome();
  const outside = join(home, "..", "outside.jsonl");
  writeFileSync(outside, line(1), { mode: 0o600 });
  symlinkSync(outside, sessionFile(home, SESSION));
  linkSync(outside, sessionFile(home, OTHER));
  writeFileSync(sessionFile(home, "1d8e1c2d-3a4f-4b5c-8d6e-7f8091a2b3c4"), line(1), { mode: 0o644 });
  writeFileSync(sessionFile(home, "2e8e1c2d-3a4f-4b5c-8d6e-7f8091a2b3c4"), Buffer.alloc(MAX_SESSION_BYTES + 128 * 1024, 0x20), { mode: 0o600 });
  const snapshot = new SessionStore(home).refresh(NOW);
  assert.deepEqual(snapshot.sessions, []);
  assert.deepEqual(
    snapshot.unsafe.map((u) => u.reason.replace(/^.*\.jsonl /, "")).sort(),
    ["har 2 hårda länkar.", "har rättigheterna 0644.", "är en symbolisk länk.", `är större än ${MAX_SESSION_BYTES + 64 * 1024} byte.`].sort(),
  );
});

test("en symlänkad sessions-mapp avvisas", () => {
  const home = tempHome();
  const elsewhere = mkdtempSync(join(tmpdir(), "subagent-watch-elsewhere-"));
  rmSync(sessionsDir(home), { recursive: true });
  symlinkSync(elsewhere, sessionsDir(home));
  assert.throws(() => new SessionStore(home).refresh(NOW), UnsafePathError);
});

test("kastade händelser från det senaste dygnet räknas", () => {
  const home = tempHome();
  logProblem(home, "not_json", NOW - 25 * 60 * 60 * 1000);
  logProblem(home, "not_json", NOW - 60_000);
  logProblem(home, "session_full", NOW);
  assert.equal(new SessionStore(home).refresh(NOW).dropped, 2);
});
