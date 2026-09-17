import assert from "node:assert/strict";
import { test } from "node:test";
import type { Lane, Piece, Turn } from "../../src/model/types.ts";
import { AIR, axisFor, FADE_SHARE, laneCap, links, percent, pieceView, ticks } from "../../src/view/webview/layout.ts";

const S = 1000;
const lane = (fields: Partial<Lane>): Lane => ({ id: "main", kind: "main", background: false, depth: 0, start: 0, state: "running", pieces: [], calls: 0, lastEventAt: 0, ...fields });
const turn = (fields: Partial<Turn>): Turn => ({ index: 0, trigger: "prompt", start: 0, state: "running", lanes: [lane({})], ...fields });

test("tidsaxeln växer i steg med luft och hoppar bara när turen passerar ett steg", () => {
  const lengths = [10, 30, 32, 33, 64, 65, 125, 130, 3600, 4 * 3600, 9 * 3600].map((s) => axisFor(turn({}), s * S).length / S / AIR);
  assert.deepEqual(lengths.map(Math.round), [30, 30, 30, 60, 60, 120, 120, 180, 3600, 14400, 43200]);
  const axis = axisFor(turn({}), 20 * S);
  assert.deepEqual(ticks(axis), [0, 10 * S, 20 * S, 30 * S]);
  assert.equal(percent(axis, -5), 0);
  assert.equal(percent(axis, 10 * axis.length), 100);
});

test("en klar tur använder sitt slut, en okänd sin senaste signal och en avbruten sitt slut som etikett", () => {
  assert.equal(Math.round(axisFor(turn({ state: "done", end: 40 * S }), 900 * S).length), Math.round(60 * S * AIR));
  const silent = turn({ state: "unknown", lanes: [lane({ state: "unknown", silentSince: 20 * S, lastEventAt: 20 * S })] });
  const unknownAxis = axisFor(silent, 700 * S);
  assert.deepEqual([Math.round(unknownAxis.length), unknownAxis.endLabel], [Math.round(30 * S * AIR), { kind: "now", at: 700 * S }]);
  assert.deepEqual(axisFor(turn({ state: "aborted", end: 22 * S }), 900 * S).endLabel, { kind: "ended", at: 22 * S });
});

test("öppna bitar växer med klockan och bitar i en tyst rad tonas ut", () => {
  const running = turn({});
  const axis = axisFor(running, 20 * S);
  const open: Piece = { kind: "term", start: 5 * S, tool: "Bash" };
  assert.deepEqual(pieceView(open, lane({}), running, axis, 20 * S), { start: 5 * S, end: 20 * S, fade: false, open: true });
  assert.deepEqual(pieceView({ ...open, end: 9 * S, unknownEnd: true }, lane({}), running, axis, 20 * S), { start: 5 * S, end: 9 * S, fade: true, open: false });

  const silentLane = lane({ id: "a", kind: "agent", state: "unknown", silentSince: 8 * S });
  const view = pieceView(open, silentLane, running, axis, 900 * S);
  assert.deepEqual(view, { start: 5 * S, end: 8 * S + axis.length * FADE_SHARE, fade: true, open: true });
  const silentTurn = turn({ state: "unknown" });
  assert.equal(pieceView({ kind: "wait", start: 2 * S, afterStop: true }, lane({ state: "unknown" }), silentTurn, axis, 900 * S).end, axis.length);
});

test("slutmarkeringar för klar, avbruten och okänd rad", () => {
  const axis = axisFor(turn({}), 20 * S);
  assert.deepEqual(laneCap(lane({ state: "done", end: 7 * S }), axis), { kind: "done", at: 7 * S, label: null });
  assert.deepEqual(laneCap(lane({ id: "a", kind: "agent", state: "aborted", end: 9 * S }), axis), { kind: "aborted", at: 9 * S, label: "avbruten" });
  assert.deepEqual(laneCap(lane({ state: "aborted", end: 9 * S }), axis), { kind: "aborted", at: 9 * S, label: "sessionen slutade" });
  assert.equal(laneCap(lane({ state: "unknown", silentSince: 3 * S }), axis)?.label, "okänt läge");
  assert.equal(laneCap(lane({}), axis), null);
});

test("den markerade raden länkas till sin förälder och till raderna den startade", () => {
  const main = lane({});
  const outer = lane({ id: "outer", kind: "agent", parentId: "main" });
  const inner = lane({ id: "inner", kind: "agent", parentId: "outer" });
  const t = turn({ lanes: [main, outer, inner] });
  assert.deepEqual(links(t, "outer").map((l) => [l.parent.id, l.child.id]), [["main", "outer"], ["outer", "inner"]]);
  assert.deepEqual(links(t, "main").map((l) => [l.parent.id, l.child.id]), [["main", "outer"]]);
  assert.deepEqual(links(t, "saknas"), []);
});
