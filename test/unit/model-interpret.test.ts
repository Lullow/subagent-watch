import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookRecord } from "../../src/collector/record.ts";
import { categoryOf, interpretSession, UNKNOWN_AFTER_MS } from "../../src/model/interpret.ts";
import type { Lane, Piece, Turn } from "../../src/model/types.ts";
import { at, run, T } from "../helpers/records.ts";

const LATER = 60_000;
const lastTime = (records: HookRecord[]): number => records.at(-1)!.time;
const model = (records: HookRecord[], now = lastTime(records) + LATER) => interpretSession("s", records, now);
const onlyTurn = (records: HookRecord[], now?: number): Turn => {
  const turns = model(records, now).turns;
  assert.equal(turns.length, 1);
  return turns[0]!;
};
const lane = (turn: Turn, id: string): Lane => {
  const found = turn.lanes.find((l) => l.id === id || l.description === id);
  assert.ok(found, `raden ${id} saknas`);
  return found;
};
const shape = (pieces: Piece[]) =>
  pieces.map((p) => [p.kind, p.start, p.end, ...(p.failed ? ["misslyckad"] : []), ...(p.unknownEnd ? ["okänt slut"] : []), ...(p.afterStop ? ["efter Stop"] : [])]);

test("en agent i förgrunden och en i bakgrunden visas som egna rader med beskrivning medan de kör", () => {
  const records = run("01-grund");
  const whileRunning = records.slice(0, records.findIndex((r) => r.event === "SubagentStop"));
  const turn = onlyTurn(whileRunning);
  assert.deepEqual(
    turn.lanes.map((l) => [l.kind, l.agentType, l.description, l.background, l.depth, l.state]),
    [
      ["main", undefined, undefined, false, 0, "running"],
      ["agent", "Explore", "List spike files", false, 1, "running"],
      ["agent", "Explore", "Read hook settings", true, 1, "running"],
    ],
  );
  const done = onlyTurn(records);
  assert.equal(done.state, "done");
  assert.deepEqual(done.lanes.map((l) => l.state), ["done", "done", "done"]);
});

test("en agent som startas av en agent får rätt förälder och indrag", () => {
  const turn = onlyTurn(run("05-nastlad"));
  const outer = lane(turn, "outer");
  const inner = lane(turn, "inner");
  assert.deepEqual([outer.parentId, outer.depth, inner.parentId, inner.depth], ["main", 1, outer.id, 2]);
  assert.deepEqual(turn.lanes.map((l) => l.description ?? l.kind), ["main", "outer", "inner"]);
  const wait = outer.pieces.find((p) => p.kind === "wait");
  assert.equal(wait?.agentId, inner.id);
});

test("fyra parallella agenter kopplas till rätt anrop", () => {
  const turn = onlyTurn(run("02-parallel"));
  const main = lane(turn, "main");
  for (const name of ["par-A", "par-B", "par-C", "par-D"]) {
    const agent = turn.lanes.find((l) => l.description?.startsWith(name));
    assert.ok(agent, name);
    const wait = main.pieces.find((p) => p.detail?.startsWith(name));
    assert.equal(wait?.kind, "wait");
    assert.equal(wait?.agentId, agent.id, name);
    assert.ok(wait.end! >= agent.end!, `${name}: väntan slutar när agenten är klar`);
  }
});

test("kopplingen efter ordning rättas av PostToolUse (R2)", () => {
  const records = [
    at(0, "UserPromptSubmit"),
    at(1, "PreToolUse", { tool: "Agent", tool_use_id: "toolu_A", detail: "Uppdrag A" }),
    at(1.1, "PreToolUse", { tool: "Agent", tool_use_id: "toolu_B", detail: "Uppdrag B" }),
    at(1.2, "SubagentStart", { agent_id: "aaaa", agent_type: "Explore" }),
    at(1.3, "SubagentStart", { agent_id: "bbbb", agent_type: "Explore" }),
  ];
  assert.equal(lane(onlyTurn(records), "aaaa").description, "Uppdrag B", "före bekräftelsen gäller ordningen");
  const confirmed = [
    ...records,
    at(3, "SubagentStop", { agent_id: "aaaa", agent_type: "Explore" }),
    at(3.1, "PostToolUse", { tool: "Agent", tool_use_id: "toolu_A", spawned_agent_id: "aaaa" }),
    at(4, "SubagentStop", { agent_id: "bbbb", agent_type: "Explore" }),
    at(4.1, "PostToolUse", { tool: "Agent", tool_use_id: "toolu_B", spawned_agent_id: "bbbb" }),
  ];
  const turn = onlyTurn(confirmed);
  assert.equal(lane(turn, "aaaa").description, "Uppdrag A");
  assert.equal(lane(turn, "bbbb").description, "Uppdrag B");
});

test("verktygsbitar får rätt kategori, växer medan de kör och tiden mellan anrop blir Tänka", () => {
  const records = [
    at(0, "UserPromptSubmit"),
    at(2, "PreToolUse", { tool: "Read", tool_use_id: "toolu_1", detail: "docs/a.md" }),
    at(2.5, "PostToolUse", { tool: "Read", tool_use_id: "toolu_1", duration_ms: 400 }),
    at(4, "PreToolUse", { tool: "Bash", tool_use_id: "toolu_2", detail: "Kör testerna" }),
  ];
  const main = lane(onlyTurn(records), "main");
  assert.deepEqual(shape(main.pieces), [
    ["think", T(0), T(2)],
    ["read", T(2), T(2.5)],
    ["think", T(2.5), T(4)],
    ["term", T(4), undefined],
  ]);
  assert.equal(main.calls, 2);
  const kinds = ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash", "Edit", "Write", "NotebookEdit", "TodoWrite", "mcp__github__create_issue"].map(categoryOf);
  assert.deepEqual(kinds, ["read", "read", "read", "read", "read", "term", "write", "write", "write", "other", "other"]);
});

test("ett misslyckat anrop får en röd markering och ett nekat anrop får okänt slut", () => {
  const records = [
    at(0, "UserPromptSubmit"),
    at(1, "PreToolUse", { tool: "Read", tool_use_id: "toolu_1", detail: "saknas.md" }),
    at(1.1, "PostToolUseFailure", { tool: "Read", tool_use_id: "toolu_1", duration_ms: 3 }),
    at(2, "PreToolUse", { tool: "Edit", tool_use_id: "toolu_2", detail: "src/a.ts" }),
    at(2.01, "PermissionRequest", { tool: "Edit" }),
    at(9, "PreToolUse", { tool: "Read", tool_use_id: "toolu_3", detail: "src/b.ts" }),
    at(9.2, "PostToolUse", { tool: "Read", tool_use_id: "toolu_3" }),
    at(10, "PreToolUse", { tool: "Write", tool_use_id: "toolu_4", detail: "src/c.ts" }),
    at(10.01, "PermissionRequest", { tool: "Write" }),
    at(15, "PostToolUse", { tool: "Write", tool_use_id: "toolu_4", duration_ms: 200 }),
    at(16, "Stop"),
  ];
  const main = lane(onlyTurn(records), "main");
  assert.deepEqual(shape(main.pieces), [
    ["think", T(0), T(1)],
    ["read", T(1), T(1.1), "misslyckad"],
    ["think", T(1.1), T(2)],
    ["you", T(2), T(9), "okänt slut"],
    ["read", T(9), T(9.2)],
    ["think", T(9.2), T(10)],
    ["you", T(10), T(14.8)],
    ["write", T(14.8), T(15)],
    ["think", T(15), T(16)],
  ]);
});

test("SessionEnd stänger öppna agenter som avbrutna och pågående anrop får okänt slut", () => {
  const session = model(run("04-avbruten"));
  const turn = session.turns[0]!;
  assert.equal(session.ended?.reason, "other");
  assert.equal(turn.state, "aborted");
  assert.deepEqual(turn.lanes.map((l) => l.state), ["aborted", "aborted"]);
  const bash = turn.lanes[1]!.pieces.find((p) => p.tool === "Bash");
  assert.equal(bash?.unknownEnd, true);
  assert.equal(bash?.end, session.ended?.at);
  assert.ok(turn.lanes.every((l) => l.pieces.every((p) => p.end !== undefined)), "inga öppna bitar efter SessionEnd");
});

test("utan signal på 10 minuter visas okänt läge, men en agent som väntar på en aktiv agent är inte okänd", () => {
  const records = [
    at(0, "UserPromptSubmit"),
    at(1, "PreToolUse", { tool: "Agent", tool_use_id: "toolu_1", detail: "Yttre" }),
    at(1.1, "SubagentStart", { agent_id: "outer", agent_type: "general-purpose" }),
    at(2, "PreToolUse", { agent_id: "outer", agent_type: "general-purpose", tool: "Agent", tool_use_id: "toolu_2", detail: "Inre" }),
    at(2.1, "SubagentStart", { agent_id: "inner", agent_type: "Explore" }),
    at(3, "PreToolUse", { agent_id: "inner", agent_type: "Explore", tool: "Bash", tool_use_id: "toolu_3", detail: "Långt test" }),
    at(700, "PostToolUse", { agent_id: "inner", agent_type: "Explore", tool: "Bash", tool_use_id: "toolu_3" }),
  ];
  const fresh = onlyTurn(records, T(700) + 1000);
  assert.deepEqual(fresh.lanes.map((l) => l.state), ["running", "running", "running"]);

  const silent = onlyTurn(records, T(700) + UNKNOWN_AFTER_MS + 1000);
  assert.deepEqual(silent.lanes.map((l) => [l.state, l.silentSince]), [
    ["unknown", T(700)],
    ["unknown", T(700)],
    ["unknown", T(700)],
  ]);
  assert.equal(silent.state, "unknown");
  assert.equal(onlyTurn(records, T(700) + UNKNOWN_AFTER_MS - 1000).lanes[1]!.state, "running");
});

test("efter Stop väntar huvudsessionen på bakgrundsagenten, och tiden innan den fortsätter blir Tänka", () => {
  const records = [
    at(0, "UserPromptSubmit"),
    at(1, "PreToolUse", { tool: "Agent", tool_use_id: "toolu_1", detail: "Bakgrund", background: true }),
    at(1.01, "PostToolUse", { tool: "Agent", tool_use_id: "toolu_1", spawned_agent_id: "bg" }),
    at(1.02, "SubagentStart", { agent_id: "bg", agent_type: "general-purpose" }),
    at(2, "Stop"),
    at(5, "SubagentStop", { agent_id: "bg", agent_type: "general-purpose" }),
  ];
  const stopped = onlyTurn(records);
  assert.deepEqual([stopped.state, stopped.end], ["done", T(5)]);
  assert.deepEqual(shape(lane(stopped, "main").pieces), [
    ["think", T(0), T(1)],
    ["other", T(1), T(1.01)],
    ["think", T(1.01), T(2)],
    ["wait", T(2), T(5), "efter Stop"],
  ]);
  assert.equal(lane(stopped, "main").pieces[1]!.launch, true);

  const resumed = onlyTurn([...records, at(6, "PreToolUse", { tool: "Edit", tool_use_id: "toolu_2", detail: "a.md" }), at(6.1, "PostToolUse", { tool: "Edit", tool_use_id: "toolu_2" }), at(7, "Stop")]);
  assert.deepEqual([resumed.state, resumed.end], ["done", T(7)]);
  assert.deepEqual(shape(lane(resumed, "main").pieces).slice(3), [
    ["wait", T(2), T(5), "efter Stop"],
    ["think", T(5), T(6)],
    ["write", T(6), T(6.1)],
    ["think", T(6.1), T(7)],
  ]);
});

test("en ny prompt startar en ny tur, och agenter hör till turen där de startade", () => {
  const records = [
    at(0, "UserPromptSubmit"),
    at(1, "PreToolUse", { tool: "Agent", tool_use_id: "toolu_1", detail: "Första", background: true }),
    at(1.01, "PostToolUse", { tool: "Agent", tool_use_id: "toolu_1", spawned_agent_id: "first" }),
    at(1.02, "SubagentStart", { agent_id: "first", agent_type: "Explore" }),
    at(2, "Stop"),
    at(10, "UserPromptSubmit"),
    at(11, "SubagentStop", { agent_id: "first", agent_type: "Explore" }),
    at(12, "StopFailure", { error_type: "rate_limit" }),
  ];
  const session = model(records);
  assert.equal(session.turns.length, 2);
  const [one, two] = session.turns;
  assert.deepEqual([one!.state, one!.end, one!.lanes.map((l) => l.id)], ["done", T(11), ["main", "first"]]);
  assert.deepEqual([two!.state, two!.end, two!.errorType, two!.lanes.map((l) => l.id)], ["done", T(12), "rate_limit", ["main"]]);
});

test("klockan som hoppar bakåt ger aldrig negativa längder", () => {
  const records = run("03a-stoppad-bgbash");
  assert.ok(records.some((r, i) => i > 0 && r.time < records[i - 1]!.time), "testdatan ska innehålla ett hopp bakåt");
  for (const l of model(records).turns.flatMap((t) => t.lanes)) {
    for (const p of l.pieces) assert.ok(p.end === undefined || p.end >= p.start, `${p.kind} ${p.tool ?? ""}`);
  }
});

test("en återupptagen agent fortsätter på samma rad, och PostToolUse utan PreToolUse byggs från duration_ms", () => {
  const records = [
    at(0, "UserPromptSubmit"),
    at(1, "SubagentStart", { agent_id: "again", agent_type: "Explore" }),
    at(2, "SubagentStop", { agent_id: "again", agent_type: "Explore" }),
    at(5, "SubagentStart", { agent_id: "again", agent_type: "Explore" }),
    at(7, "PostToolUse", { agent_id: "again", agent_type: "Explore", tool: "Grep", tool_use_id: "toolu_9", duration_ms: 1500 }),
  ];
  const turn = onlyTurn(records);
  assert.equal(turn.lanes.length, 2);
  const agent = lane(turn, "again");
  assert.equal(agent.state, "running");
  assert.deepEqual(shape(agent.pieces), [
    ["think", T(1), T(2)],
    ["think", T(5), T(5.5)],
    ["read", T(5.5), T(7)],
    ["think", T(7), undefined],
  ]);
});
