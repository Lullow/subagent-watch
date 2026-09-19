import { cleanText, displayPath, hostOf, MAX_DESCRIPTION, MAX_HOST, MAX_PATH } from "./text.ts";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The documented error_type values for StopFailure. */
export const STOP_ERRORS = [
  "rate_limit",
  "overloaded",
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "cloud_credential_error",
  "unknown",
] as const;

/** The documented reason values for SessionEnd. */
export const END_REASONS = ["clear", "resume", "logout", "prompt_input_exit", "other"] as const;

/**
 * One line in ~/.subagent-watch/sessions/<session_id>.jsonl. Only the allowlisted
 * fields from Q8, Q33 and Q34. Never commands, prompts, Grep patterns, search
 * queries, reports, error messages, transcript paths or prompt_id.
 */
export interface HookRecord {
  v: 1;
  time: number;
  event: HookEvent;
  agent_id?: string;
  agent_type?: string;
  /** SessionStart: the project directory, with ~ for the home directory. */
  project?: string;
  tool?: string;
  tool_use_id?: string;
  /** PreToolUse: a path, a Glob pattern, the description of Bash or Agent, or the host of WebFetch. */
  detail?: string;
  /** PreToolUse on Agent: run_in_background. */
  background?: boolean;
  /** PostToolUse on Agent: tool_response.agentId. */
  spawned_agent_id?: string;
  duration_ms?: number;
  error_type?: (typeof STOP_ERRORS)[number];
  reason?: (typeof END_REASONS)[number];
}

export type ParseFailure = "empty" | "not_json" | "not_object" | "session_id" | "event" | "tool" | "tool_use_id";

/** Counted like a failure, but the event is still kept: only a field was lost. */
export type ParseNote = "agent_identity";

export type ParseResult =
  | { ok: true; sessionId: string; record: HookRecord; note?: ParseNote }
  | { ok: false; reason: ParseFailure };

type Json = Record<string, unknown>;

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const AGENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,79}$/;
export const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_:.-]{0,99}$/;
export const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,100}$/;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const matches = (v: unknown, pattern: RegExp): v is string => typeof v === "string" && pattern.test(v);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;

const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);
const NEEDS_TOOL_USE_ID: ReadonlySet<HookEvent> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied"]);

/** The one detail kept for each tool, from tool_input (Q8, Q33, Q34). */
function toolDetail(tool: string, input: Json, cwd: string | undefined, home: string): string | undefined {
  const path = (value: unknown) => {
    const p = str(value);
    return p === undefined ? undefined : cleanText(displayPath(p, cwd, home), MAX_PATH);
  };
  switch (tool) {
    case "Read":
    case "Edit":
    case "Write":
      return path(input.file_path);
    case "NotebookEdit":
      return path(input.notebook_path);
    case "Glob":
      return path(input.pattern);
    case "Bash":
    case "Agent": {
      const description = str(input.description);
      return description === undefined ? undefined : cleanText(description, MAX_DESCRIPTION);
    }
    case "WebFetch": {
      const url = str(input.url);
      const host = url === undefined ? undefined : hostOf(url);
      return host === undefined ? undefined : cleanText(host, MAX_HOST);
    }
    default:
      return undefined;
  }
}

export function parseHook(text: string, now: number, home: string): ParseResult {
  if (text.trim() === "") return { ok: false, reason: "empty" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!isObj(data)) return { ok: false, reason: "not_object" };
  if (!matches(data.session_id, SESSION_ID)) return { ok: false, reason: "session_id" };
  const event = oneOf(data.hook_event_name, HOOK_EVENTS);
  if (event === undefined) return { ok: false, reason: "event" };

  const record: HookRecord = { v: 1, time: now, event };

  // The identity is metadata, not a precondition. Validating both fields together
  // threw the whole event away over one unusable field, so they are validated
  // apart: what passes is kept, what does not is dropped as a field alone.
  //
  // An absent field, and an empty one, both mean "no identity here" and are
  // normal. Claude Code's own internal agents send SubagentStop with
  // agent_type: "" every turn, so noting those would raise an alarm on every
  // turn. Only a non-empty value we cannot use is worth counting: that is the
  // shape that says the format moved under us.
  const supplied = (v: unknown): boolean => v !== undefined && v !== "";
  if (matches(data.agent_id, AGENT_ID)) record.agent_id = data.agent_id;
  if (matches(data.agent_type, AGENT_TYPE)) record.agent_type = data.agent_type;
  const unusable =
    (supplied(data.agent_id) && record.agent_id === undefined) || (supplied(data.agent_type) && record.agent_type === undefined);
  const note: ParseNote | undefined = unusable ? "agent_identity" : undefined;

  const cwd = str(data.cwd);
  if (event === "SessionStart" && cwd !== undefined) {
    const project = cleanText(displayPath(cwd, undefined, home), MAX_PATH);
    if (project !== undefined) record.project = project;
  }

  if (TOOL_EVENTS.has(event)) {
    if (!matches(data.tool_name, TOOL_NAME)) return { ok: false, reason: "tool" };
    record.tool = data.tool_name;
    if (NEEDS_TOOL_USE_ID.has(event)) {
      if (!matches(data.tool_use_id, TOOL_USE_ID)) return { ok: false, reason: "tool_use_id" };
      record.tool_use_id = data.tool_use_id;
    }
  }

  const input = isObj(data.tool_input) ? data.tool_input : {};
  if (event === "PreToolUse" && record.tool !== undefined) {
    const detail = toolDetail(record.tool, input, cwd, home);
    if (detail !== undefined) record.detail = detail;
    if (record.tool === "Agent" && input.run_in_background === true) record.background = true;
  }

  if (event === "PostToolUse" && record.tool === "Agent" && isObj(data.tool_response) && matches(data.tool_response.agentId, AGENT_ID)) {
    record.spawned_agent_id = data.tool_response.agentId;
  }

  if ((event === "PostToolUse" || event === "PostToolUseFailure") && typeof data.duration_ms === "number") {
    const ms = data.duration_ms;
    if (Number.isFinite(ms) && ms >= 0 && ms < 1e9) record.duration_ms = Math.round(ms);
  }

  if (event === "StopFailure") {
    const type = oneOf(data.error_type, STOP_ERRORS);
    if (type !== undefined) record.error_type = type;
  }

  if (event === "SessionEnd") {
    const reason = oneOf(data.reason, END_REASONS);
    if (reason !== undefined) record.reason = reason;
  }

  return note === undefined ? { ok: true, sessionId: data.session_id, record } : { ok: true, sessionId: data.session_id, record, note };
}
