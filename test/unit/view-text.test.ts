import assert from "node:assert/strict";
import { test } from "node:test";
import type { Lane, Piece, SessionModel, Turn } from "../../src/model/types.ts";
import {
  activity,
  callDetail,
  clock,
  duration,
  laneMeta,
  laneState,
  laneTitle,
  offset,
  othersText,
  pieceLines,
  statusParts,
  turnSummary,
} from "../../src/view/webview/text.ts";

const at = (h: number, m: number, s: number): number => new Date(2026, 8, 17, h, m, s).getTime();
const T0 = at(14, 32, 0);
const lane = (fields: Partial<Lane>): Lane => ({ id: "main", kind: "main", background: false, depth: 0, start: T0, state: "running", pieces: [], calls: 0, lastEventAt: T0, ...fields });
const turn = (lanes: Lane[], fields: Partial<Turn> = {}): Turn => ({ index: 0, trigger: "prompt", start: T0, state: "running", lanes, ...fields });
const none = () => undefined;
const session: SessionModel = { id: "9f5e56ac-b6ec-41eb-aac1-86304f7ecc1f", project: "~/projects/subagent-watch", start: T0, lastEventAt: T0, turns: [] };

test("klockslag, längder och axelns etiketter", () => {
  assert.equal(clock(at(14, 32, 5)), "14:32:05");
  assert.deepEqual([30, 400, 1_000, 9_950, 34_000, 64_000, 3_720_000].map(duration), ["30 ms", "400 ms", "1,0 s", "9,9 s", "34 s", "1 min 4 s", "1 h 2 min"]);
  assert.deepEqual([10_000, 60_000, 90_000, 3_600_000, 5_400_000].map(offset), ["+10 s", "+1 min", "+1:30", "+1 h", "+1:30 h"]);
});

test("huvudsessionen visar projektet och sessionens id, agenter sin beskrivning", () => {
  assert.deepEqual(laneTitle(lane({}), session), { type: "huvudsession", description: "subagent-watch · 9f5e56ac" });
  assert.deepEqual(laneTitle(lane({ id: "a", kind: "agent", agentType: "Explore", description: "Läs README" }), session), { type: "Explore", description: "Läs README" });
  assert.deepEqual(laneTitle(lane({ id: "a", kind: "agent", agentType: "Explore" }), session), { type: "Explore", description: null });
});

test("detaljen för ett anrop säger när indata aldrig sparas (Q33, Q34)", () => {
  assert.deepEqual(callDetail({ kind: "read", start: 0, tool: "Grep" }), [{ nosave: "mönstret sparas inte" }]);
  assert.deepEqual(callDetail({ kind: "read", start: 0, tool: "WebSearch" }), [{ nosave: "sökfrågan sparas inte" }]);
  assert.deepEqual(callDetail({ kind: "term", start: 0, tool: "Bash", detail: "Kör testerna" }), ["Kör testerna"]);
  assert.deepEqual(callDetail({ kind: "read", start: 0, tool: "Read", detail: "docs/<img src=x onerror=alert(1)>.md" }), [{ code: "docs/<img src=x onerror=alert(1)>.md" }]);
  assert.deepEqual(callDetail({ kind: "other", start: 0, tool: "TodoWrite" }), [{ dim: "ingen detalj sparas" }]);
});

test("vad en rad gör just nu: väntar på dig går först, sedan anrop, väntan och Tänka", () => {
  const explore = lane({ id: "e", kind: "agent", agentType: "Explore", description: "Kartlägg hooks" });
  const find = (id: string) => (id === "e" ? explore : undefined);
  const open = (pieces: Piece[]) => activity(lane({ pieces }), turn([lane({}), explore]), find);
  assert.deepEqual(open([{ kind: "you", start: T0, tool: "Edit" }, { kind: "wait", start: T0, agentId: "e" }]), [{ chip: "you" }, "Väntar på dig · Edit"]);
  assert.deepEqual(open([{ kind: "read", start: T0, tool: "Read", detail: "a.md" }, { kind: "term", start: T0 + 1, tool: "Bash", detail: "Bygg" }]), [
    { chip: "term" },
    "Kör Bash · ",
    "Bygg",
    { dim: " · 2 anrop samtidigt" },
  ]);
  assert.deepEqual(open([{ kind: "wait", start: T0, tool: "Agent", agentId: "e" }]), [{ chip: "wait" }, "Väntar på Explore", { dim: " · Kartlägg hooks" }]);
  assert.deepEqual(open([{ kind: "wait", start: T0, agentId: "e" }, { kind: "wait", start: T0, agentId: "x" }]), [{ chip: "wait" }, "Väntar på 2 agenter"]);
  assert.deepEqual(open([{ kind: "wait", start: T0, afterStop: true }]), [{ chip: "wait" }, "Turen är klar · väntar på 1 agent i bakgrunden"]);
  assert.deepEqual(open([{ kind: "think", start: at(14, 32, 7) }]), [{ chip: "think" }, "Tänka", { dim: " · inget anrop sedan 14:32:07" }]);
});

test("klar, avbruten och okänt läge beskrivs med klockslag", () => {
  const agent = lane({ id: "a", kind: "agent", state: "done", end: at(14, 32, 13) });
  assert.deepEqual(laneState(agent, turn([agent]), none), ["Klar 14:32:13"]);
  const failedTurn = turn([lane({ state: "done" })], { state: "done", end: at(14, 33, 0), errorType: "rate_limit" });
  assert.deepEqual(laneState(failedTurn.lanes[0]!, failedTurn, none), ["Turen slutade med ett API-fel 14:33:00", { dim: " · rate_limit" }]);
  assert.deepEqual(laneState(lane({ kind: "agent", state: "aborted", end: at(14, 32, 22) }), turn([]), none), [
    "Avbruten 14:32:22",
    { dim: " · sessionen slutade innan agenten stoppade" },
  ]);
  assert.deepEqual(laneState(lane({ state: "unknown", silentSince: at(14, 32, 20) }), turn([]), none), ["Okänt läge", { dim: " · ingen signal sedan 14:32:20" }]);
});

test("tid, anrop och startade agenter under detaljen", () => {
  const main = lane({ calls: 5 });
  const child = lane({ id: "a", kind: "agent", parentId: "main" });
  assert.equal(laneMeta(main, turn([main, child]), T0 + 34_000), "34 s · 5 anrop · 1 agent startade");
  assert.equal(laneMeta(lane({ calls: 1, end: T0 + 4_000 }), turn([]), T0 + 90_000), "4,0 s · 1 anrop");
});

test("en bit under musen visar anropet, längden och om det misslyckades eller fick okänt slut", () => {
  const piece: Piece = { kind: "read", start: at(14, 32, 4), end: at(14, 32, 5), tool: "Read", detail: "docs/a.md", failed: true };
  assert.deepEqual(pieceLines(piece, piece.end!, none, turn([])), [
    [{ chip: "read" }, "Read · ", { code: "docs/a.md" }],
    ["1,0 s · 14:32:04–14:32:05 · misslyckades"],
  ]);
  const denied: Piece = { kind: "you", start: at(14, 32, 17), end: at(14, 32, 19), tool: "Read", unknownEnd: true };
  assert.deepEqual(pieceLines(denied, denied.end!, none, turn([])), [
    [{ chip: "you" }, "Väntar på dig · Read", { dim: " · nekat eller obesvarat" }],
    ["2,0 s · 14:32:17–14:32:19 · inget svar i datan"],
  ]);
  const open: Piece = { kind: "think", start: at(14, 32, 30) };
  assert.deepEqual(pieceLines(open, at(14, 32, 31), none, turn([])), [[{ chip: "think" }, "Tänka", { dim: " · tiden mellan två anrop" }], ["1,0 s · 14:32:30– · pågår"]]);
});

test("ihopfällda turer och raden för andra sessioner", () => {
  const agents = [lane({}), lane({ id: "a", kind: "agent" }), lane({ id: "b", kind: "agent" })];
  assert.equal(turnSummary(turn(agents, { state: "done", end: T0 + 124_000 }), 0), "14:32 · 2 agenter · 2 min 4 s");
  assert.equal(turnSummary(turn(agents.slice(0, 2)), 0), "14:32 · 1 agent · pågår");
  assert.equal(turnSummary(turn([lane({})], { trigger: "agent", state: "done", end: T0 + 4_000 }), 0), "14:32 · svar på bakgrundsagent · 4,0 s");
  assert.equal(othersText([]), "Andra sessioner · inga aktiva");
  assert.equal(
    othersText([
      { name: "tokeniser", running: 1, unknown: 0 },
      { name: "dotfiles", running: 0, unknown: 2 },
    ]),
    "Andra sessioner · tokeniser · 1 agent kör · dotfiles · 2 i okänt läge",
  );
});

test("statusraden har ett fast kommando att kopiera vid problem (Q18, S10)", () => {
  assert.deepEqual(statusParts({ kind: "active", lastEventAt: at(14, 32, 5), dropped: 0, refused: 0 }), [{ icon: "ok" }, "Pluginet aktivt · senaste händelse 14:32:05"]);
  assert.deepEqual(statusParts({ kind: "active", lastEventAt: null, dropped: 3, refused: 1 }), [
    { icon: "ok" },
    "Pluginet aktivt · inga händelser än",
    " · ",
    { strong: "3 händelser kastades" },
    " eftersom formatet var okänt",
    " · ",
    { strong: "1 fil avvisades" },
  ]);
  const changed = statusParts({ kind: "changed", file: "hooks.json", actual: "4c1e".padEnd(60, "0") + "9b02", expected: "a7d3".padEnd(60, "0") + "61f8" });
  assert.deepEqual(changed.slice(1, 6), [{ strong: "Insamlaren har ändrats" }, " · hooks.json har kontrollsumman ", { code: "4c1e…9b02" }, ", väntad ", { code: "a7d3…61f8" }]);
  assert.deepEqual(changed.at(-1), { copy: "npm run connect -- --disconnect" });
  assert.deepEqual(statusParts({ kind: "not-connected" }).at(-1), { copy: "npm run connect" });
});
