import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendPrivateFileLimited, assertPrivateDir, currentUid, ensurePrivateDir } from "../secure/fs.ts";
import type { HookRecord } from "./record.ts";

export const defaultHome = (): string => join(homedir(), ".subagent-watch");

export const MAX_LINE_BYTES = 2 * 1024;
export const MAX_SESSION_BYTES = 20 * 1024 * 1024;
export const MAX_PROBLEM_BYTES = 256 * 1024;
export const RETENTION_MS = 24 * 60 * 60 * 1000;

export const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
export const PROBLEM_FILE = /^problems-\d{4}-\d{2}-\d{2}\.jsonl$/;

/** The collector writes only inside sessions/. */
export const sessionsDir = (home: string): string => join(home, "sessions");
export const sessionFile = (home: string, sessionId: string): string => join(sessionsDir(home), `${sessionId}.jsonl`);

/** Dropped events are counted per UTC day, with only the reason and the time. */
export function problemFile(home: string, epochMs: number): string {
  return join(sessionsDir(home), `problems-${new Date(epochMs).toISOString().slice(0, 10)}.jsonl`);
}

/** Creates the store. Done by the connect step; the collector itself never creates directories. */
export function initStore(home: string, uid = currentUid()): void {
  ensurePrivateDir(home, uid);
  ensurePrivateDir(sessionsDir(home), uid);
}

export type WriteResult = "appended" | "line_too_long" | "session_full";

export function writeRecord(home: string, sessionId: string, record: HookRecord, uid = currentUid()): WriteResult {
  assertPrivateDir(sessionsDir(home), uid);
  const line = Buffer.from(`${JSON.stringify(record)}\n`);
  if (line.length > MAX_LINE_BYTES) return "line_too_long";
  return appendPrivateFileLimited(sessionFile(home, sessionId), line, MAX_SESSION_BYTES, uid) ? "appended" : "session_full";
}

/** Records that an event was dropped, without any of the input. Never throws. */
export function logProblem(home: string, kind: string, epochMs: number, uid = currentUid()): void {
  try {
    assertPrivateDir(sessionsDir(home), uid);
    const line = Buffer.from(`${JSON.stringify({ time: epochMs, kind })}\n`);
    appendPrivateFileLimited(problemFile(home, epochMs), line, MAX_PROBLEM_BYTES, uid);
  } catch {
    // A hook must never fail because of subagent-watch.
  }
}

/**
 * Removes session and problem files whose last write is more than 24 hours old (Q17, Q25).
 * Only regular files owned by uid with a known name pattern; anything else is left alone.
 */
export function removeExpired(home: string, now: number, uid = currentUid()): number {
  const dir = sessionsDir(home);
  assertPrivateDir(dir, uid);
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!SESSION_FILE.test(name) && !PROBLEM_FILE.test(name)) continue;
    const path = join(dir, name);
    const st = lstatSync(path);
    if (!st.isFile() || st.uid !== uid || now - st.mtimeMs < RETENTION_MS) continue;
    unlinkSync(path);
    removed++;
  }
  return removed;
}
