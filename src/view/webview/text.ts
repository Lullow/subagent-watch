// Pure text helpers for the webview: no DOM, so they are tested in Node.
import type { Lane, OtherProject, Piece, PieceKind, SessionModel, Turn } from "../../model/types.ts";
import type { CopyableCommand, StatusFacts } from "../types.ts";

/** Parts of a line. Every string ends up in a text node, never in HTML (S9). */
export type Part =
  | string
  | { b: string }
  | { code: string }
  | { dim: string }
  | { nosave: string }
  | { strong: string }
  | { chip: PieceKind }
  | { icon: "ok" | "warn" }
  | { copy: CopyableCommand };

const two = (n: number): string => String(n).padStart(2, "0");

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export const hourMinute = (ms: number): string => clock(ms).slice(0, 5);

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1).replace(".", ",")} s`;
  const s = Math.floor(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min`;
}

/** Axis labels after the first: time since the turn started. */
export function offset(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `+${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `+${m} min` : `+${m}:${two(s % 60)}`;
  return m % 60 === 0 ? `+${m / 60} h` : `+${Math.floor(m / 60)}:${two(m % 60)} h`;
}

export const countOf = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const CATEGORY: Record<PieceKind, { label: string; tip: string }> = {
  read: { label: "Läsa", tip: "Read, Grep, Glob, WebFetch och WebSearch." },
  term: { label: "Terminal", tip: "Bash. Bara anropets beskrivning sparas, aldrig kommandot." },
  write: { label: "Skriva", tip: "Edit, Write och NotebookEdit." },
  think: {
    label: "Tänka",
    tip: "Tiden mellan två verktygsanrop under en tur. Hooks säger inget om vad som händer då, så det kan vara modellen som tänker men också väntan på API:t.",
  },
  wait: { label: "Vänta", tip: "Väntar på en agent som raden själv har startat." },
  you: { label: "Väntar på dig", tip: "Från att Claude Code frågar om lov tills du har svarat. Bara tid och verktygsnamn sparas." },
  other: { label: "Övrigt", tip: "Andra verktyg, till exempel TodoWrite och TaskStop." },
};

export const projectName = (session: SessionModel): string => session.project?.split("/").filter(Boolean).at(-1) ?? "okänt projekt";

export function laneTitle(lane: Lane, session: SessionModel): { type: string; description: string | null } {
  if (lane.kind === "main") return { type: "huvudsession", description: `${projectName(session)} · ${session.id.slice(0, 8)}` };
  return { type: lane.agentType ?? "agent", description: lane.description ?? null };
}

/** The one detail kept for a call, with a note where the input is never saved (Q33, Q34). */
export function callDetail(piece: Piece): Part[] {
  if (piece.tool === "Grep") return [{ nosave: "mönstret sparas inte" }];
  if (piece.tool === "WebSearch") return [{ nosave: "sökfrågan sparas inte" }];
  if (piece.detail === undefined) return [{ dim: "ingen detalj sparas" }];
  return piece.tool === "Bash" || piece.tool === "Agent" ? [piece.detail] : [{ code: piece.detail }];
}

export type LaneLookup = (id: string) => Lane | undefined;

function waitParts(piece: Piece, turn: Turn, find: LaneLookup): Part[] {
  if (piece.afterStop) {
    const running = turn.lanes.filter((l) => l.kind === "agent" && l.state !== "done" && l.state !== "aborted").length;
    return [`Turen är klar · väntar på ${countOf(Math.max(running, 1), "agent", "agenter")} i bakgrunden`];
  }
  const agent = piece.agentId === undefined ? undefined : find(piece.agentId);
  return [`Väntar på ${agent?.agentType ?? "en agent"}`, ...(agent?.description === undefined ? [] : [{ dim: ` · ${agent.description}` }])];
}

/** What a running lane does now. Several calls can be open at once; the most telling one wins. */
export function activity(lane: Lane, turn: Turn, find: LaneLookup): Part[] {
  const open = lane.pieces.filter((p) => p.end === undefined);
  const you = open.find((p) => p.kind === "you");
  if (you !== undefined) return [{ chip: "you" }, `Väntar på dig · ${you.tool ?? "ett verktyg"}`];
  const calls = open.filter((p) => p.kind !== "think" && p.kind !== "wait");
  const waits = open.filter((p) => p.kind === "wait");
  if (calls.length > 0) {
    const latest = calls.reduce((a, b) => (b.start > a.start ? b : a));
    return [{ chip: latest.kind }, `Kör ${latest.tool ?? "ett verktyg"} · `, ...callDetail(latest), ...(calls.length > 1 ? [{ dim: ` · ${calls.length} anrop samtidigt` }] : [])];
  }
  if (waits.length > 1 && !waits.some((w) => w.afterStop)) return [{ chip: "wait" }, `Väntar på ${waits.length} agenter`];
  if (waits.length > 0) return [{ chip: "wait" }, ...waitParts(waits[0]!, turn, find)];
  const think = open.find((p) => p.kind === "think");
  return [{ chip: "think" }, "Tänka", { dim: ` · inget anrop sedan ${clock(think?.start ?? lane.lastEventAt)}` }];
}

export function laneState(lane: Lane, turn: Turn, find: LaneLookup): Part[] {
  switch (lane.state) {
    case "done":
      if (lane.kind === "agent") return [`Klar ${clock(lane.end ?? lane.lastEventAt)}`];
      return turn.errorType === undefined
        ? [`Turen klar ${clock(turn.end ?? lane.lastEventAt)}`]
        : [`Turen slutade med ett API-fel ${clock(turn.end ?? lane.lastEventAt)}`, { dim: ` · ${turn.errorType}` }];
    case "aborted":
      return lane.kind === "agent"
        ? [`Avbruten ${clock(lane.end ?? lane.lastEventAt)}`, { dim: " · sessionen slutade innan agenten stoppade" }]
        : [`Avslutad ${clock(lane.end ?? lane.lastEventAt)}`, { dim: " · sessionen slutade mitt i turen" }];
    case "unknown":
      return ["Okänt läge", { dim: ` · ingen signal sedan ${clock(lane.silentSince ?? lane.lastEventAt)}` }];
    default:
      return activity(lane, turn, find);
  }
}

export function laneMeta(lane: Lane, turn: Turn, now: number): string {
  const end = lane.end ?? (lane.state === "unknown" ? (lane.silentSince ?? now) : now);
  const started = turn.lanes.filter((l) => l.parentId === lane.id).length;
  return [duration(end - lane.start), countOf(lane.calls, "anrop", "anrop"), ...(started > 0 ? [`${countOf(started, "agent", "agenter")} startade`] : [])].join(" · ");
}

export function pieceLines(piece: Piece, visibleEnd: number, find: LaneLookup, turn: Turn): [Part[], Part[]] {
  const label: Part[] = [{ chip: piece.kind }];
  if (piece.kind === "think") label.push("Tänka", { dim: " · tiden mellan två anrop" });
  else if (piece.kind === "wait") label.push(...waitParts(piece, turn, find));
  else if (piece.kind === "you") label.push(`Väntar på dig · ${piece.tool ?? "ett verktyg"}`);
  else label.push(`${piece.tool ?? "Verktyg"} · `, ...callDetail(piece));
  const open = piece.end === undefined;
  const bits = [duration(visibleEnd - piece.start), open ? `${clock(piece.start)}–` : `${clock(piece.start)}–${clock(piece.end!)}`];
  if (open) bits.push("pågår");
  if (piece.failed) bits.push("misslyckades");
  if (piece.unknownEnd) bits.push("okänt slut");
  return [label, [bits.join(" · ")]];
}

export function turnSummary(turn: Turn, now: number): string {
  const agents = turn.lanes.filter((l) => l.kind === "agent").length;
  const tail =
    turn.state === "running" ? "pågår" : turn.state === "unknown" ? "okänt läge" : turn.state === "aborted" ? "avbruten" : duration((turn.end ?? now) - turn.start);
  return `${hourMinute(turn.start)} · ${countOf(agents, "agent", "agenter")} · ${tail}`;
}

export function othersText(others: readonly OtherProject[]): string {
  if (others.length === 0) return "Andra sessioner · inga aktiva";
  const parts = others.map((o) => {
    const bits = [o.running > 0 ? countOf(o.running, "agent kör", "agenter kör") : null, o.unknown > 0 ? `${o.unknown} i okänt läge` : null].filter(Boolean);
    return `${o.name} · ${bits.length > 0 ? bits.join(", ") : "ingen agent kör"}`;
  });
  return `Andra sessioner · ${parts.join(" · ")}`;
}

const DISCONNECT: CopyableCommand = "npm run connect -- --disconnect";

export function statusParts(facts: StatusFacts): Part[] {
  switch (facts.kind) {
    case "not-connected":
      return [{ icon: "warn" }, { strong: "Inte ansluten till Claude Code" }, " · anslut i subagent-watch-repot med ", { code: "npm run connect" }, { copy: "npm run connect" }];
    case "invalid-connection":
      return [{ icon: "warn" }, { strong: "Anslutningsuppgifterna går inte att läsa" }, ` · ${facts.reason} · `, { code: DISCONNECT }, { copy: DISCONNECT }];
    case "store-refused":
      return [{ icon: "warn" }, { strong: "Den insamlade datan avvisades" }, ` · ${facts.reason}`];
    case "plugin-missing":
      return [{ icon: "warn" }, { strong: "Pluginet saknas" }, " · koppla från och anslut igen: ", { code: DISCONNECT }, { copy: DISCONNECT }];
    case "changed":
      return [
        { icon: "warn" },
        { strong: "Insamlaren har ändrats" },
        ` · ${facts.file} har kontrollsumman `,
        { code: facts.actual === null ? "okänd" : `${facts.actual.slice(0, 4)}…${facts.actual.slice(-4)}` },
        ", väntad ",
        { code: `${facts.expected.slice(0, 4)}…${facts.expected.slice(-4)}` },
        " · ",
        { code: DISCONNECT },
        { copy: DISCONNECT },
      ];
    case "node-missing":
      return [{ icon: "warn" }, { strong: "Inga nya händelser" }, " · Node-sökvägen i pluginet finns inte längre: ", { code: facts.path }, " · ", { code: DISCONNECT }, { copy: DISCONNECT }];
    case "active": {
      const parts: Part[] = [{ icon: "ok" }, `Pluginet aktivt · ${facts.lastEventAt === null ? "inga händelser än" : `senaste händelse ${clock(facts.lastEventAt)}`}`];
      if (facts.dropped > 0) parts.push(" · ", { strong: `${countOf(facts.dropped, "händelse", "händelser")} kastades` }, " eftersom formatet var okänt");
      if (facts.refused > 0) parts.push(" · ", { strong: `${countOf(facts.refused, "fil avvisades", "filer avvisades")}` });
      return parts;
    }
  }
}
