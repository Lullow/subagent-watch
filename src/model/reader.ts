import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { HookRecord } from "../collector/record.ts";
import { MAX_SESSION_BYTES, PROBLEM_FILE, RETENTION_MS, SESSION_FILE, sessionsDir } from "../collector/store.ts";
import { assertPrivateDir, currentUid, readFileChecked, readRangeChecked, UnsafePathError } from "../secure/fs.ts";
import { parseRecordLine } from "./schema.ts";

const CHUNK_BYTES = 4 * 1024 * 1024;
/** The collector stops at 20 MB; a larger file was not written by it. */
const MAX_FILE_BYTES = MAX_SESSION_BYTES + 64 * 1024;
const MAX_PROBLEM_FILE_BYTES = 1024 * 1024;

export interface SessionData {
  id: string;
  records: HookRecord[];
  /** Lines that did not match the schema (S10, R7). */
  rejected: number;
}

export interface StoreSnapshot {
  sessions: SessionData[];
  /** Session files that were refused: symlinks, hard links, wrong owner or mode, too large. */
  unsafe: { file: string; reason: string }[];
  /** Events the collector dropped in the last 24 hours, from problems-*.jsonl. */
  dropped: number;
}

interface Cached {
  dev: number;
  ino: number;
  offset: number;
  /** The first bytes read, so a file recreated under the same name and inode is noticed. */
  head: Buffer;
  data: SessionData;
}

const HEAD_BYTES = 256;

const decoder = new TextDecoder("utf-8");

/**
 * Reads ~/.subagent-watch/sessions/ as untrusted input (S10). Each file is read incrementally:
 * only bytes up to the last complete line are consumed, so a line being written is read next time.
 */
export class SessionStore {
  private readonly cache = new Map<string, Cached>();
  private readonly home: string;
  private readonly uid: number;

  constructor(home: string, uid = currentUid()) {
    this.home = home;
    this.uid = uid;
  }

  refresh(now: number): StoreSnapshot {
    const dir = sessionsDir(this.home);
    assertPrivateDir(this.home, this.uid);
    assertPrivateDir(dir, this.uid);
    const names = readdirSync(dir);
    const unsafe: StoreSnapshot["unsafe"] = [];
    const sessions: SessionData[] = [];

    for (const name of names.filter((n) => SESSION_FILE.test(n))) {
      try {
        const data = this.readSession(join(dir, name), name);
        if (data !== null) sessions.push(data);
      } catch (error) {
        this.cache.delete(name);
        if (!(error instanceof UnsafePathError)) throw error;
        unsafe.push({ file: name, reason: error.message });
      }
    }
    for (const name of this.cache.keys()) if (!names.includes(name)) this.cache.delete(name);

    let dropped = 0;
    for (const name of names.filter((n) => PROBLEM_FILE.test(n))) {
      try {
        const file = readFileChecked(join(dir, name), { private: true, maxBytes: MAX_PROBLEM_FILE_BYTES }, this.uid);
        if (file === null) continue;
        for (const line of decoder.decode(file.bytes).split("\n")) {
          const time = (() => {
            try {
              return (JSON.parse(line) as { time?: unknown }).time;
            } catch {
              return undefined;
            }
          })();
          if (typeof time === "number" && now - time < RETENTION_MS) dropped++;
        }
      } catch (error) {
        if (!(error instanceof UnsafePathError)) throw error;
        unsafe.push({ file: name, reason: error.message });
      }
    }
    return { sessions, unsafe, dropped };
  }

  private readSession(path: string, name: string): SessionData | null {
    let cached = this.cache.get(name);
    if (cached !== undefined) {
      const head = readRangeChecked(path, true, 0, cached.head.length, this.uid);
      if (head === null || !head.bytes.equals(cached.head)) {
        cached = undefined;
        this.cache.delete(name);
      }
    }
    for (;;) {
      const offset = cached?.offset ?? 0;
      const range = readRangeChecked(path, true, offset, CHUNK_BYTES, this.uid);
      if (range === null) {
        this.cache.delete(name);
        return null;
      }
      if (range.size > MAX_FILE_BYTES) throw new UnsafePathError(path, `är större än ${MAX_FILE_BYTES} byte`);
      if (cached !== undefined && (range.dev !== cached.dev || range.ino !== cached.ino || range.size < cached.offset)) {
        // Replaced or truncated: start over.
        cached = undefined;
        this.cache.delete(name);
        continue;
      }
      if (cached === undefined) {
        cached = { dev: range.dev, ino: range.ino, offset: 0, head: Buffer.alloc(0), data: { id: name.slice(0, -".jsonl".length), records: [], rejected: 0 } };
        this.cache.set(name, cached);
      }
      const end = range.bytes.lastIndexOf(0x0a);
      if (end < 0) return cached.data;
      for (const line of decoder.decode(range.bytes.subarray(0, end)).split("\n")) {
        if (line === "") continue;
        const record = parseRecordLine(line);
        if (record === null) cached.data.rejected++;
        else cached.data.records.push(record);
      }
      if (offset === 0) cached.head = Buffer.from(range.bytes.subarray(0, Math.min(HEAD_BYTES, end + 1)));
      cached.offset += end + 1;
      if (cached.offset >= range.size) return cached.data;
    }
  }
}
