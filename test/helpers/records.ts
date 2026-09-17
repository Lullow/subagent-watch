import { readFileSync } from "node:fs";
import type { HookRecord } from "../../src/collector/record.ts";
import { parseRecordLine } from "../../src/model/schema.ts";

/** A cleaned spike run from test/fixtures/runs/, parsed through the reader's schema check. */
export function run(name: string): HookRecord[] {
  return readFileSync(new URL(`../fixtures/runs/${name}.jsonl`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const record = parseRecordLine(line);
      if (record === null) throw new Error(`ogiltig rad i ${name}: ${line}`);
      return record;
    });
}

const T0 = 1_789_646_400_000;

/** A record at T0 + seconds. */
export function at(seconds: number, event: HookRecord["event"], fields: Omit<Partial<HookRecord>, "v" | "time" | "event"> = {}): HookRecord {
  return { v: 1, time: T0 + Math.round(seconds * 1000), event, ...fields } as HookRecord;
}

export const T = (seconds: number): number => T0 + Math.round(seconds * 1000);
