import type { Lane, Piece, PieceKind, SessionModel, Turn } from "../../model/types.ts";
import type { CopyableCommand, FromWebview, ToWebview, ViewSnapshot } from "../types.ts";
import { axisFor, laneCap, links, percent, pieceView, ticks, type Axis } from "./layout.ts";
import {
  CATEGORY,
  clock,
  hourMinute,
  laneElapsed,
  laneMeta,
  laneState,
  laneTitle,
  offset,
  othersText,
  pieceLines,
  statusParts,
  turnSummary,
  type LaneLookup,
  type Part,
} from "./text.ts";

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void; getState(): unknown; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
const SVG_NS = "http://www.w3.org/2000/svg";
/** Q30: narrower than this, the left column shows only the agent type. */
const NARROW_PX = 420;
/** Narrower still, the view turns tall: the text stands above its own timeline. */
const COMPACT_PX = 320;

type Form = "wide" | "narrow" | "compact";
const formFor = (width: number): Form => (width === 0 || width >= NARROW_PX ? "wide" : width >= COMPACT_PX ? "narrow" : "compact");
const form = (): Form => (root.dataset.form as Form | undefined) ?? "wide";

/* ---------- State ---------- */

interface Saved {
  selected: string | null;
  /** Older turns the user opened, per session. The latest turn is shown otherwise (Q27). */
  expanded: Record<string, number>;
}

function loadState(): Saved {
  const raw = vscode.getState() as { selected?: unknown; expanded?: unknown } | undefined;
  const expanded: Record<string, number> = {};
  if (typeof raw?.expanded === "object" && raw.expanded !== null) {
    for (const [id, index] of Object.entries(raw.expanded)) if (typeof index === "number" && Number.isInteger(index)) expanded[id] = index;
  }
  return { selected: typeof raw?.selected === "string" ? raw.selected : null, expanded };
}

const state = loadState();
let snapshot: ViewSnapshot | null = null;
let clockOffset = 0;
let hover: string | null = null;
let copied: CopyableCommand | null = null;
let known = new Set<string>();
let firstRender = true;

const now = (): number => Date.now() + clockOffset;
const reduceMotion = (): boolean => document.body.classList.contains("vscode-reduce-motion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const save = (): void => vscode.setState(state);

/* ---------- DOM helpers: text only, never HTML (S9) ---------- */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string | null): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function svgEl(name: string, attributes: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, name) as SVGElement;
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function warnIcon(): SVGElement {
  const svg = svgEl("svg", { viewBox: "0 0 16 16", class: "ic-warn", "aria-hidden": "true" });
  svg.append(
    svgEl("path", { d: "M8 1.8 15 14.2H1Z", fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linejoin": "round" }),
    svgEl("path", { d: "M8 6v4M8 11.6v1", stroke: "currentColor", "stroke-width": "1.4" }),
  );
  return svg;
}

function renderParts(node: HTMLElement, parts: readonly Part[]): void {
  for (const part of parts) {
    if (typeof part === "string") node.append(part);
    else if ("b" in part) node.append(el("b", undefined, part.b));
    else if ("code" in part) node.append(el("code", undefined, part.code));
    else if ("dim" in part) node.append(el("span", "dim", part.dim));
    else if ("nosave" in part) node.append(el("span", "nosave", part.nosave));
    else if ("strong" in part) node.append(el("span", "st-strong", part.strong));
    else if ("chip" in part) node.append(el("span", `chip k-${part.chip}`));
    else if ("icon" in part) node.append(part.icon === "ok" ? el("span", "dot-ok") : warnIcon());
    else if ("copy" in part) {
      const button = el("button", "btn2", copied === part.copy ? "Kopierat" : "Kopiera");
      button.type = "button";
      button.dataset.copy = part.copy;
      node.append(button);
    }
  }
}

/* ---------- Static frame ---------- */

const root = document.getElementById("root") as HTMLElement;
root.dataset.form = "wide";
const legend = el("div", "sw-legend");
const scroll = el("div", "sw-scroll");
const detail = el("div", "sw-detail");
const othersRow = el("div", "sw-others");
const statusRow = el("div", "sw-status");
const tip = el("div", "sw-tip");
detail.setAttribute("aria-live", "polite");
tip.setAttribute("role", "tooltip");
tip.hidden = true;
root.append(el("div", "sw-spacer"), legend, scroll, detail, othersRow, statusRow, el("div", "sw-spacer"), tip);

/** Q26: the legend, with the explanation of Tänka in its tooltip. */
const MARKS = [
  { cls: "mk-done", label: "klar", tip: "SubagentStop eller Stop har kommit." },
  { cls: "mk-fail", label: "misslyckades", tip: "PostToolUseFailure. Felmeddelandet sparas inte." },
  { cls: "k-read mk-fade", label: "okänt slut", tip: "Anropet fick inget eget slut och stängdes av en senare händelse." },
  { cls: "k-you mk-denied", label: "nekat", tip: "Frågan om lov fick inget svar i datan: du sa nej, eller hann inte svara innan turen slutade." },
];
for (const kind of ["read", "term", "write", "think", "wait", "you", "other"] as PieceKind[]) {
  const item = el("span", kind === "think" ? "lg lg-tip" : "lg");
  item.tabIndex = 0;
  item.dataset.title = CATEGORY[kind].label;
  item.dataset.tip = CATEGORY[kind].tip;
  item.append(el("i", `k-${kind}`), CATEGORY[kind].label);
  legend.append(item);
}
legend.append(el("span", "lg-sep"));
for (const mark of MARKS) {
  const item = el("span", "lg");
  item.tabIndex = 0;
  item.dataset.title = mark.label[0]!.toUpperCase() + mark.label.slice(1);
  item.dataset.tip = mark.tip;
  item.append(el("i", mark.cls), mark.label);
  legend.append(item);
}

function showTip(target: HTMLElement, parts: readonly Part[]): void {
  tip.replaceChildren();
  renderParts(tip, parts);
  tip.hidden = false;
  const box = root.getBoundingClientRect();
  const at = target.getBoundingClientRect();
  const x = Math.max(4, Math.min(at.left - box.left, box.width - tip.offsetWidth - 4));
  let y = at.bottom - box.top + 4;
  if (y + tip.offsetHeight > box.height - 4) y = at.top - box.top - tip.offsetHeight - 4;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = (): void => {
  tip.hidden = true;
};

/* ---------- Rendering ---------- */

interface Rendered {
  session: SessionModel;
  turn: Turn | undefined;
  axis: Axis | undefined;
  rows: Map<string, { lane: Lane; track: HTMLElement }>;
  open: { piece: Piece; el: HTMLElement }[];
  /** The elapsed time beside each running lane in the tall form. */
  metas: { lane: Lane; el: HTMLElement }[];
  now: HTMLElement | undefined;
  links: SVGElement;
}

let rendered: Rendered[] = [];
const laneIndex = new Map<string, { session: SessionModel; turn: Turn; lane: Lane }>();
const pieceIndex = new Map<string, { session: SessionModel; turn: Turn; lane: Lane; piece: Piece }>();

const laneKey = (session: SessionModel, turn: Turn, lane: Lane): string => `${session.id}|${turn.index}|${lane.id}`;
const turnKey = (session: SessionModel, index: number): string => `${session.id}|turn|${index}`;
const lookup = (turn: Turn): LaneLookup => (id) => turn.lanes.find((l) => l.id === id);

function expandedIndex(session: SessionModel): number {
  const chosen = state.expanded[session.id];
  return chosen !== undefined && chosen >= 0 && chosen < session.turns.length ? chosen : session.turns.length - 1;
}

function place(node: HTMLElement, axis: Axis, start: number, end: number): void {
  const left = percent(axis, start);
  node.style.left = `${left.toFixed(3)}%`;
  node.style.width = `max(2px, calc(${(percent(axis, end) - left).toFixed(3)}% - 1px))`;
}

function waitLabel(piece: Piece, turn: Turn): string {
  if (piece.afterStop) return "Väntar på agenter i bakgrunden";
  const agent = piece.agentId === undefined ? undefined : lookup(turn)(piece.agentId);
  return `Väntar på ${agent?.agentType ?? "en agent"}`;
}

function renderAxis(axisEl: HTMLElement, under: HTMLElement, axis: Axis, turn: Turn): void {
  const narrow = form() !== "wide";
  const offsets = ticks(axis);
  const end = axis.endLabel === null ? null : `${axis.endLabel.kind === "now" ? "nu" : "avslutad"} ${clock(axis.endLabel.at)}`;
  const limit = end === null ? 100 : narrow ? 60 : 85;
  const labels = offsets
    .filter((ms, i) => percent(axis, axis.start + ms) <= limit && !(narrow && offsets.length > 4 && i % 2 === 1))
    .map((ms) => {
      const label = el("span", ms === 0 ? "ax-first" : undefined, ms === 0 ? clock(turn.start) : offset(ms));
      label.style.left = `${percent(axis, axis.start + ms)}%`;
      return label;
    });
  if (end !== null) labels.push(el("span", "ax-end", end));
  axisEl.replaceChildren(...labels);
  under.replaceChildren(
    ...offsets.map((ms) => {
      const line = el("div", "gl");
      line.style.left = `${percent(axis, axis.start + ms)}%`;
      return line;
    }),
  );
}

function renderLane(entry: Rendered, turn: Turn, axis: Axis, lane: Lane, time: number, seen: Set<string>, animate: boolean): HTMLElement {
  const { session } = entry;
  const key = laneKey(session, turn, lane);
  seen.add(key);
  laneIndex.set(key, { session, turn, lane });

  const row = el("div", "sw-row");
  row.setAttribute("role", "option");
  row.dataset.key = key;
  row.tabIndex = -1;
  if (animate && !known.has(key)) row.classList.add("enter");

  const lc = el("div", "sw-lc");
  lc.style.setProperty("--d", String(lane.depth));
  lc.append(lane.kind === "main" ? el("span", "sw-tw", "▾") : el("span", "sw-elbow"));
  const title = laneTitle(lane, session);
  const names = el("span", "sw-names");
  const description =
    title.description === null
      ? el("span", "sw-ds none", "ingen beskrivning")
      : el("span", "sw-ds", lane.kind === "main" && session.ended !== undefined ? `${title.description} · Avslutad ${hourMinute(session.ended.at)}` : title.description);
  names.append(el("span", "sw-ty", title.type), description);
  lc.append(names);
  const meta = el("span", "sw-meta", laneElapsed(lane, time));
  lc.append(meta);
  entry.metas.push({ lane, el: meta });

  const cell = el("div", "sw-tr");
  const track = el("div", "sw-track");
  cell.append(track);
  row.append(lc, cell);

  const silent = lane.state === "unknown" || turn.state === "unknown";
  for (const piece of lane.pieces) {
    if (piece.launch) continue;
    const view = pieceView(piece, lane, turn, axis, time);
    const pieceKey = `${key}|${piece.start}|${piece.kind}|${piece.tool ?? ""}`;
    seen.add(pieceKey);
    pieceIndex.set(pieceKey, { session, turn, lane, piece });
    const denied = piece.kind === "you" && piece.unknownEnd === true;
    const seg = el("div", `seg k-${piece.kind}`);
    seg.dataset.piece = pieceKey;
    if (animate && !known.has(pieceKey) && piece.kind !== "think") seg.classList.add("enter");
    if (view.fade && !denied) seg.classList.add("fade");
    if (denied) seg.classList.add("denied");
    if (piece.failed) seg.classList.add("fail");
    if (pieceKey === hover) seg.classList.add("hov");
    if (piece.kind === "wait") seg.append(el("span", "seg-lb", waitLabel(piece, turn)));
    place(seg, axis, view.start, view.end);
    track.append(seg);
    if (denied) {
      const mark = el("div", "cap denied", "✕");
      mark.style.left = `${percent(axis, view.end)}%`;
      track.append(mark);
    }
    if (view.open && !silent) entry.open.push({ piece, el: seg });
  }

  const cap = laneCap(lane, axis);
  if (cap !== null) {
    const mark = el("div", `cap ${cap.kind}`, cap.kind === "aborted" ? "✕" : null);
    mark.style.left = `${percent(axis, cap.at)}%`;
    track.append(mark);
    if (cap.label !== null) {
      const text = cap.label === "okänt läge" && form() === "wide" ? `okänt läge · ingen signal sedan ${clock(lane.silentSince ?? lane.lastEventAt)}` : cap.label;
      const label = el("div", "tlabel", text);
      label.style.left = `${percent(axis, cap.at)}%`;
      track.append(label);
    }
  }
  entry.rows.set(key, { lane, track });
  return row;
}

function renderSession(session: SessionModel, time: number, seen: Set<string>, animate: boolean): HTMLElement {
  const block = el("div", "sw-session");
  block.dataset.ended = String(session.ended !== undefined);
  const index = expandedIndex(session);
  const turn = session.turns[index];

  const current = el("div", "sw-cur");
  const under = el("div", "sw-under");
  const head = el("div", "sw-head");
  const axisEl = el("div", "sw-axis");
  head.append(el("div", "sw-lc", "Session"), axisEl);
  const rows = el("div");
  rows.setAttribute("role", "listbox");
  rows.setAttribute("aria-label", "Huvudsessionen och agenterna");
  const over = el("div", "sw-over");
  const svg = svgEl("svg", { class: "sw-links", "aria-hidden": "true" });
  over.append(svg);
  current.append(under, head, rows, over);

  const entry: Rendered = { session, turn, axis: undefined, rows: new Map(), open: [], metas: [], now: undefined, links: svg };
  if (turn === undefined) {
    rows.append(el("div", "sw-empty", `${session.project ?? "Sessionen"} har startat, men ingen prompt har kommit än.`));
  } else {
    const axis = axisFor(turn, time);
    entry.axis = axis;
    renderAxis(axisEl, under, axis, turn);
    for (const lane of turn.lanes) rows.append(renderLane(entry, turn, axis, lane, time, seen, animate));
    if (turn.state === "running" || turn.state === "unknown") {
      entry.now = el("div", "now");
      entry.now.style.left = turn.state === "running" ? `${percent(axis, time)}%` : "100%";
      over.append(entry.now);
    }
  }
  block.append(current);

  const folded = el("div");
  folded.setAttribute("role", "listbox");
  folded.setAttribute("aria-label", "Äldre turer");
  for (let i = session.turns.length - 1; i >= 0; i--) {
    if (i === index) continue;
    const row = el("div", "sw-turn");
    row.setAttribute("role", "option");
    row.dataset.key = turnKey(session, i);
    row.tabIndex = -1;
    row.append(el("span", "sw-tw", "▸"), turnSummary(session.turns[i]!, time));
    folded.append(row);
  }
  block.append(folded);
  rendered.push(entry);
  return block;
}

function renderAll(): void {
  if (snapshot === null) return;
  const time = now();
  root.dataset.form = formFor(root.clientWidth);
  const focused = scroll.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
  const seen = new Set<string>();
  const animate = !firstRender && !reduceMotion();
  rendered = [];
  laneIndex.clear();
  pieceIndex.clear();
  const blocks = snapshot.sessions.map((session) => renderSession(session, time, seen, animate));
  if (blocks.length === 0) {
    blocks.push(
      el("div", "sw-empty", snapshot.status.kind === "not-connected" ? "subagent-watch är inte ansluten till Claude Code än." : "Inga sessioner med Claude Code i det här projektet det senaste dygnet."),
    );
  }
  scroll.replaceChildren(...blocks);
  known = seen;
  firstRender = false;
  if (hover !== null && !pieceIndex.has(hover)) hover = null;
  applySelection();
  if (focused !== undefined) items().find((item) => item.dataset.key === focused)?.focus({ preventScroll: true });
  othersRow.textContent = othersText(snapshot.others);
  renderStatus();
  drawLinks();
  renderDetail();
  schedule();
}

/* ---------- Selection, links and detail panel (Q14, Q29) ---------- */

const items = (): HTMLElement[] => [...scroll.querySelectorAll<HTMLElement>(".sw-row, .sw-turn")];

function applySelection(): void {
  const all = items();
  if (!all.some((item) => item.dataset.key === state.selected)) state.selected = all.find((item) => item.classList.contains("sw-row"))?.dataset.key ?? null;
  for (const item of all) {
    const on = item.dataset.key === state.selected;
    item.setAttribute("aria-selected", String(on));
    item.tabIndex = on ? 0 : -1;
  }
  save();
}

function drawLinks(): void {
  for (const entry of rendered) {
    const shapes: string[] = [];
    const selected = state.selected === null ? undefined : laneIndex.get(state.selected);
    if (entry.turn !== undefined && entry.axis !== undefined && selected !== undefined && selected.session === entry.session) {
      const box = entry.links.getBoundingClientRect();
      const y = (lane: Lane): number | null => {
        const row = entry.rows.get(laneKey(entry.session, entry.turn!, lane));
        if (row === undefined) return null;
        const at = row.track.getBoundingClientRect();
        return at.top - box.top + at.height / 2;
      };
      const x = (time: number): number => (box.width * percent(entry.axis!, time)) / 100;
      const half = form() === "wide" ? 7 : 6;
      for (const { parent, child } of links(entry.turn, selected.lane.id)) {
        const yp = y(parent);
        const yc = y(child);
        if (yp === null || yc === null) continue;
        const dir = yc > yp ? 1 : -1;
        const y0 = yp + dir * half;
        const y1 = yc - dir * half;
        const xs = x(child.start);
        shapes.push(`M ${xs} ${y0} V ${y1}`, `M ${xs - 2.5} ${y0} H ${xs + 2.5}`, `M ${xs - 2.5} ${y1} H ${xs + 2.5}`);
        if ((child.state === "done" || child.state === "aborted") && child.end !== undefined) {
          const xe = x(child.end);
          shapes.push(`M ${xe} ${y1} Q ${xe + 12} ${(y0 + y1) / 2} ${xe} ${y0}`, `M ${xe - 2.5} ${y0} H ${xe + 2.5}`, `M ${xe - 2.5} ${y1} H ${xe + 2.5}`);
        }
      }
    }
    entry.links.replaceChildren(...shapes.map((d) => svgEl("path", { d, class: "lk" })));
  }
}

function titleLine(session: SessionModel, lane: Lane): Part[] {
  const title = laneTitle(lane, session);
  const line: Part[] = [{ b: title.type }, title.description === null ? { dim: " · ingen beskrivning" } : ` · ${title.description}`];
  if (lane.background) line.push({ dim: " · i bakgrunden" });
  if (lane.kind === "main" && session.ended !== undefined) line.push({ dim: ` · Avslutad ${clock(session.ended.at)}` });
  return line;
}

let detailSignature = "";
function renderDetail(): void {
  if (snapshot === null) return;
  const time = now();
  let lines: Part[][];
  const hovered = hover === null ? undefined : pieceIndex.get(hover);
  const selected = state.selected === null ? undefined : laneIndex.get(state.selected);
  const turnMatch = state.selected === null ? null : /^(.+)\|turn\|(\d+)$/.exec(state.selected);
  if (hovered !== undefined) {
    const axis = axisFor(hovered.turn, time);
    const view = pieceView(hovered.piece, hovered.lane, hovered.turn, axis, time);
    lines = [titleLine(hovered.session, hovered.lane), ...pieceLines(hovered.piece, view.end, lookup(hovered.turn), hovered.turn)];
  } else if (turnMatch !== null) {
    const session = snapshot.sessions.find((s) => s.id === turnMatch[1]);
    const turn = session?.turns[Number(turnMatch[2])];
    lines =
      turn === undefined
        ? []
        : [[{ b: `Tur ${clock(turn.start)}` }, { dim: " · ihopfälld" }], [turnSummary(turn, time).split(" · ").slice(1).join(" · ")], ["Klicka eller tryck Enter för att fälla ut turen."]];
  } else if (selected !== undefined) {
    lines = [titleLine(selected.session, selected.lane), laneState(selected.lane, selected.turn, lookup(selected.turn)), [laneMeta(selected.lane, selected.turn, time)]];
  } else {
    lines = [[{ dim: "Väntar på en session med Claude Code i det här projektet." }]];
  }
  root.dataset.hover = String(hovered !== undefined);
  const signature = JSON.stringify(lines);
  if (signature === detailSignature) return;
  detailSignature = signature;
  detail.replaceChildren(
    ...lines.map((parts, i) => {
      const line = el("div", `dt-${i + 1}`);
      renderParts(line, parts);
      return line;
    }),
  );
}

let statusSignature = "";
function renderStatus(): void {
  if (snapshot === null) return;
  const parts = statusParts(snapshot.status);
  const signature = JSON.stringify(parts) + String(copied);
  if (signature === statusSignature) return;
  statusSignature = signature;
  statusRow.replaceChildren();
  renderParts(statusRow, parts);
}

/* ---------- Time: pieces grow only while something runs (Q10) ---------- */

let frame = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule(): void {
  if (frame !== 0) cancelAnimationFrame(frame);
  if (timer !== undefined) clearTimeout(timer);
  frame = 0;
  timer = undefined;
  if (document.hidden || !rendered.some((entry) => entry.open.length > 0 || entry.now !== undefined)) return;
  if (reduceMotion()) timer = setTimeout(tick, 1000);
  else frame = requestAnimationFrame(tick);
}

function tick(): void {
  frame = 0;
  timer = undefined;
  const time = now();
  for (const entry of rendered) {
    if (entry.turn === undefined || entry.axis === undefined) continue;
    // Decision 4 from the sketch: the axis jumps only when the turn passes a step.
    if (axisFor(entry.turn, time).length !== entry.axis.length) return renderAll();
    for (const open of entry.open) place(open.el, entry.axis, open.piece.start, Math.max(open.piece.start, time));
    for (const meta of entry.metas) {
      const text = laneElapsed(meta.lane, time);
      if (meta.el.textContent !== text) meta.el.textContent = text;
    }
    if (entry.now !== undefined && entry.turn.state === "running") entry.now.style.left = `${percent(entry.axis, time)}%`;
  }
  renderDetail();
  schedule();
}

/* ---------- Input ---------- */

function select(key: string, focus: boolean): void {
  state.selected = key;
  applySelection();
  drawLinks();
  renderDetail();
  if (focus) items().find((item) => item.dataset.key === key)?.focus({ preventScroll: false });
}

function expand(key: string): void {
  const match = /^(.+)\|turn\|(\d+)$/.exec(key);
  const session = snapshot?.sessions.find((s) => s.id === match?.[1]);
  if (match === null || session === undefined) return;
  const index = Number(match[2]);
  if (index === session.turns.length - 1) delete state.expanded[session.id];
  else state.expanded[session.id] = index;
  state.selected = `${session.id}|${index}|main`;
  hover = null;
  renderAll();
  items().find((item) => item.dataset.key === state.selected)?.focus({ preventScroll: true });
}

scroll.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const turn = target.closest<HTMLElement>(".sw-turn");
  if (turn?.dataset.key !== undefined) return expand(turn.dataset.key);
  const row = target.closest<HTMLElement>(".sw-row");
  if (row?.dataset.key !== undefined) select(row.dataset.key, true);
});

scroll.addEventListener("keydown", (event) => {
  const all = items();
  const index = Math.max(0, all.findIndex((item) => item.dataset.key === state.selected));
  const current = all[index];
  if ((event.key === "Enter" || event.key === " " || event.key === "ArrowRight") && current?.classList.contains("sw-turn")) {
    event.preventDefault();
    return expand(current.dataset.key!);
  }
  const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : null;
  if (next === null) return;
  event.preventDefault();
  const target = all[Math.max(0, Math.min(all.length - 1, next))];
  if (target?.dataset.key !== undefined) select(target.dataset.key, true);
});

scroll.addEventListener("mouseover", (event) => {
  const target = event.target as HTMLElement;
  const seg = target.closest<HTMLElement>(".seg");
  const next = seg?.dataset.piece ?? null;
  if (next !== hover) {
    scroll.querySelector(".seg.hov")?.classList.remove("hov");
    seg?.classList.add("hov");
    hover = next;
    renderDetail();
  }
  const cell = target.closest<HTMLElement>(".sw-lc");
  const key = cell?.parentElement?.dataset.key;
  const found = key === undefined ? undefined : laneIndex.get(key);
  if (cell !== null && found !== undefined) showTip(cell, titleLine(found.session, found.lane));
  else hideTip();
});

scroll.addEventListener("mouseleave", () => {
  scroll.querySelector(".seg.hov")?.classList.remove("hov");
  hover = null;
  hideTip();
  renderDetail();
});

const legendTip = (event: Event): void => {
  const item = (event.target as HTMLElement).closest<HTMLElement>(".lg");
  if (item !== null) showTip(item, [{ b: `${item.dataset.title ?? ""}. ` }, item.dataset.tip ?? ""]);
};
legend.addEventListener("mouseover", legendTip);
legend.addEventListener("focusin", legendTip);
legend.addEventListener("mouseleave", hideTip);
legend.addEventListener("focusout", hideTip);

statusRow.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-copy]");
  if (button === null) return;
  vscode.postMessage({ type: "copy", command: button.dataset.copy as CopyableCommand });
});

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  if (message?.type === "snapshot") {
    snapshot = message.snapshot;
    clockOffset = snapshot.now - Date.now();
    renderAll();
  } else if (message?.type === "copied") {
    copied = message.command;
    renderStatus();
    setTimeout(() => {
      copied = null;
      renderStatus();
    }, 1600);
  }
});

new ResizeObserver(() => {
  if (snapshot !== null && root.dataset.form !== formFor(root.clientWidth)) renderAll();
  else drawLinks();
}).observe(root);
document.addEventListener("visibilitychange", schedule);

vscode.postMessage({ type: "ready" });
