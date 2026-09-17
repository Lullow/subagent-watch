import {
  AGENT_ID,
  AGENT_TYPE,
  END_REASONS,
  HOOK_EVENTS,
  STOP_ERRORS,
  TOOL_NAME,
  TOOL_USE_ID,
  type HookRecord,
} from "../collector/record.ts";
import { MAX_PATH } from "../collector/text.ts";

type Check = (value: unknown) => boolean;

const pattern = (re: RegExp): Check => (v) => typeof v === "string" && re.test(v);
const oneOf = (list: readonly string[]): Check => (v) => typeof v === "string" && list.includes(v);
/** Text written by the collector: already cleaned, so any control character means the line is not ours. */
const text: Check = (v) => typeof v === "string" && v.length > 0 && [...v].length <= MAX_PATH && !/[\p{Cc}\p{Bidi_Control}]/u.test(v);
const integer = (max: number): Check => (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

const FIELDS: Record<keyof HookRecord, Check> = {
  v: (v) => v === 1,
  time: integer(Number.MAX_SAFE_INTEGER),
  event: oneOf(HOOK_EVENTS),
  agent_id: pattern(AGENT_ID),
  agent_type: pattern(AGENT_TYPE),
  project: text,
  tool: pattern(TOOL_NAME),
  tool_use_id: pattern(TOOL_USE_ID),
  detail: text,
  background: (v) => v === true,
  spawned_agent_id: pattern(AGENT_ID),
  duration_ms: integer(1e9),
  error_type: oneOf(STOP_ERRORS),
  reason: oneOf(END_REASONS),
};

/**
 * S10: every line is read as untrusted and must match the collector's schema exactly.
 * Unknown fields, wrong types and missing required fields reject the whole line.
 */
export function parseRecordLine(line: string): HookRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const check = FIELDS[key as keyof HookRecord];
    if (check === undefined || !check(value)) return null;
  }
  if (record.v === undefined || record.time === undefined || record.event === undefined) return null;
  if ((record.agent_id === undefined) !== (record.agent_type === undefined)) return null;
  return record as unknown as HookRecord;
}
