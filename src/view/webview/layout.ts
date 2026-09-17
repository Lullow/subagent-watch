// Pure geometry for the timeline: no DOM, so it is tested in Node.
import type { Lane, Piece, Turn } from "../../model/types.ts";

/** Axis steps in seconds with their tick interval (decision 4 from the sketch). */
export const STEPS: readonly (readonly [number, number])[] = [
  [30, 10],
  [60, 15],
  [120, 30],
  [180, 30],
  [300, 60],
  [600, 120],
  [900, 180],
  [1800, 300],
  [3600, 600],
  [7200, 1200],
  [14400, 3600],
];
/** Room after the step, so a turn just past a round length does not jump at once. */
export const AIR = 1.08;
/** How far an open piece of a silent lane fades out, as a share of the axis. */
export const FADE_SHARE = 0.06;

export interface Axis {
  start: number;
  /** Milliseconds shown, including the air. */
  length: number;
  every: number;
  /** The axis ends at the last signal and names the current time instead (unknown), or the end of the session. */
  endLabel: { kind: "now" | "ended"; at: number } | null;
}

export function lastSignal(turn: Turn): number {
  return Math.max(turn.start, ...turn.lanes.map((l) => l.silentSince ?? l.lastEventAt));
}

/** The span the axis must show: it grows only while something happens (Q10). */
export function turnSpan(turn: Turn, now: number): number {
  if (turn.state === "unknown") return lastSignal(turn) - turn.start;
  if (turn.end !== undefined) return turn.end - turn.start;
  return now - turn.start;
}

export function axisFor(turn: Turn, now: number): Axis {
  const seconds = Math.max(0, turnSpan(turn, now)) / 1000;
  const last = STEPS[STEPS.length - 1]!;
  const [step, every] = STEPS.find(([s]) => seconds <= s * AIR) ?? [Math.ceil(seconds / AIR / last[0]) * last[0], last[1]];
  const endLabel = turn.state === "unknown" ? { kind: "now" as const, at: now } : turn.state === "aborted" ? { kind: "ended" as const, at: turn.end ?? now } : null;
  return { start: turn.start, length: step * AIR * 1000, every: every * 1000, endLabel };
}

export const ticks = (axis: Axis): number[] => {
  const out: number[] = [];
  for (let t = 0; t < axis.length; t += axis.every) out.push(t);
  return out;
};

/** Position on the axis in percent, clamped to the axis. */
export const percent = (axis: Axis, time: number): number => (Math.min(Math.max(time - axis.start, 0), axis.length) / axis.length) * 100;

export interface PieceView {
  start: number;
  end: number;
  fade: boolean;
  open: boolean;
}

/** Where a piece ends on screen: open pieces grow with the clock, and those of a silent lane fade out. */
export function pieceView(piece: Piece, lane: Lane, turn: Turn, axis: Axis, now: number): PieceView {
  if (piece.end !== undefined) return { start: piece.start, end: piece.end, fade: piece.unknownEnd === true, open: false };
  const silent = lane.state === "unknown" || turn.state === "unknown";
  if (!silent) return { start: piece.start, end: Math.max(piece.start, now), fade: false, open: true };
  if (piece.kind === "wait" && lane.kind === "main") return { start: piece.start, end: axis.start + axis.length, fade: false, open: true };
  const from = Math.max(piece.start, lane.silentSince ?? piece.start);
  return { start: piece.start, end: Math.min(from + axis.length * FADE_SHARE, axis.start + axis.length), fade: true, open: true };
}

export interface Cap {
  kind: "done" | "aborted" | "unknown";
  at: number;
  label: "avbruten" | "sessionen slutade" | "okänt läge" | null;
}

export function laneCap(lane: Lane, axis: Axis): Cap | null {
  switch (lane.state) {
    case "done":
      return { kind: "done", at: lane.end ?? lane.lastEventAt, label: null };
    case "aborted":
      return { kind: "aborted", at: lane.end ?? lane.lastEventAt, label: lane.kind === "main" ? "sessionen slutade" : "avbruten" };
    case "unknown":
      return { kind: "unknown", at: Math.min((lane.silentSince ?? lane.lastEventAt) + axis.length * FADE_SHARE, axis.start + axis.length), label: "okänt läge" };
    default:
      return null;
  }
}

/** Decision 2 from the sketch: the selected lane links to its parent and to the lanes it started. */
export function links(turn: Turn, selected: string): { parent: Lane; child: Lane }[] {
  const lane = turn.lanes.find((l) => l.id === selected);
  if (lane === undefined) return [];
  const byId = new Map(turn.lanes.map((l) => [l.id, l]));
  const out: { parent: Lane; child: Lane }[] = [];
  const parent = lane.parentId === undefined ? undefined : byId.get(lane.parentId);
  if (parent !== undefined) out.push({ parent, child: lane });
  for (const child of turn.lanes) if (child.parentId === lane.id) out.push({ parent: lane, child });
  return out;
}
