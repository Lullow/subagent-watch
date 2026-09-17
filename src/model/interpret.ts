import type { HookRecord } from "../collector/record.ts";
import type { Lane, Piece, PieceKind, SessionModel, Turn } from "./types.ts";

/** A new turn this soon after a background agent finished is its answer, not a new prompt. */
const AGENT_TURN_MS = 3000;

/** Q13: a running lane with no signal for this long is shown as unknown. */
export const UNKNOWN_AFTER_MS = 10 * 60 * 1000;

const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "NotebookEdit"]);

/** Q26. The Agent tool is Vänta in the foreground and an instant launch in the background. */
export function categoryOf(tool: string): PieceKind {
  if (READ_TOOLS.has(tool)) return "read";
  if (tool === "Bash") return "term";
  if (WRITE_TOOLS.has(tool)) return "write";
  return "other";
}

interface OpenCall {
  piece: Piece;
  askedAt?: number;
}

interface LaneWork {
  lane: Lane;
  turn: TurnWork;
  /** Keyed by tool_use_id; a lane can run several calls in parallel. */
  open: Map<string, OpenCall>;
  active: boolean;
  /** Start of the current Tänka piece: the lane is active and runs no call. */
  idleSince?: number | undefined;
  /** Main lane: the agents finished after Stop; if the main session resumes, the gap is Tänka. */
  resumeThinkFrom?: number | undefined;
  afterStopWait?: Piece | undefined;
}

interface TurnWork {
  turn: Turn;
  main: LaneWork;
  agents: LaneWork[];
  stoppedAt?: number;
  abortedAt?: number;
}

interface AgentCall {
  parentId: string;
  description?: string;
  background: boolean;
  /** undefined: not paired yet. "": closed without an agent. */
  agentId?: string;
}

const newLane = (id: string, kind: Lane["kind"], t: number): Lane => ({
  id,
  kind,
  background: false,
  depth: kind === "main" ? 0 : 1,
  start: t,
  state: "running",
  pieces: [],
  calls: 0,
  lastEventAt: t,
});

/**
 * Builds the session from its records in file order (the order is reliable, timestamps are not:
 * they are made monotonic and used only for lengths and clock times). Follows the interpretation
 * rules in the summary, section 4.
 */
export function interpretSession(id: string, records: readonly HookRecord[], now: number): SessionModel {
  const first = records[0]?.time ?? now;
  const session: SessionModel = { id, start: first, lastEventAt: first, turns: [] };
  const turns: TurnWork[] = [];
  const agents = new Map<string, LaneWork>();
  const calls = new Map<string, AgentCall>();
  let time = 0;
  let asks = 0;

  const current = (): TurnWork | undefined => turns.at(-1);

  /** Claude Code sends a new prompt when a background agent finishes, so the turn is its answer. */
  function triggerAt(t: number): Turn["trigger"] {
    const previous = current();
    if (previous === undefined || previous.stoppedAt === undefined) return "prompt";
    return previous.agents.some((a) => a.lane.end !== undefined && t - a.lane.end <= AGENT_TURN_MS) ? "agent" : "prompt";
  }

  function startTurn(t: number): TurnWork {
    const lane = newLane("main", "main", t);
    const turn: Turn = { index: turns.length, trigger: triggerAt(t), start: t, state: "running", lanes: [lane] };
    const main = { lane, open: new Map(), active: true, idleSince: t } as unknown as LaneWork;
    const work: TurnWork = { turn, main, agents: [] };
    main.turn = work;
    turns.push(work);
    session.turns.push(turn);
    return work;
  }

  function think(w: LaneWork, until: number): void {
    if (w.idleSince !== undefined && until > w.idleSince) w.lane.pieces.push({ kind: "think", start: w.idleSince, end: until });
    w.idleSince = undefined;
  }

  function closeCall(w: LaneWork, key: string, call: OpenCall, t: number, how: { failed?: boolean; unknownEnd?: boolean; durationMs?: number }): void {
    const { piece } = call;
    if (call.askedAt !== undefined && how.unknownEnd) {
      // Q31, Q32: asked for permission and never ran, typically because you said no.
      piece.kind = "you";
    } else if (call.askedAt !== undefined && piece.kind !== "you") {
      // Q31: from the question until you answered; the tool ran for duration_ms after that.
      const ran = how.durationMs === undefined ? t : Math.min(t, Math.max(call.askedAt, t - how.durationMs));
      w.lane.pieces.push({ kind: "you", start: piece.start, end: ran, ...(piece.tool === undefined ? {} : { tool: piece.tool }) });
      piece.start = ran;
    }
    piece.end = t;
    if (how.failed) piece.failed = true;
    if (how.unknownEnd) piece.unknownEnd = true;
    w.open.delete(key);
    if (w.open.size === 0 && w.active) w.idleSince = t;
  }

  function closeAll(w: LaneWork, t: number): void {
    for (const [key, call] of w.open) closeCall(w, key, call, t, { unknownEnd: true });
    think(w, t);
  }

  function resumeMain(work: TurnWork, t: number): void {
    const { main } = work;
    if (main.afterStopWait !== undefined) {
      main.afterStopWait.end = t;
      main.afterStopWait = undefined;
    } else if (main.resumeThinkFrom !== undefined && t > main.resumeThinkFrom) {
      main.lane.pieces.push({ kind: "think", start: main.resumeThinkFrom, end: t });
    }
    main.resumeThinkFrom = undefined;
    main.active = true;
    main.idleSince = t;
    delete work.stoppedAt;
  }

  function mainLane(t: number): LaneWork {
    const work = current() ?? startTurn(t);
    if (!work.main.active) resumeMain(work, t);
    return work.main;
  }

  function createAgent(agentId: string, agentType: string, t: number): LaneWork {
    const work = current() ?? startTurn(t);
    const lane = newLane(agentId, "agent", t);
    lane.agentType = agentType;
    const w: LaneWork = { lane, turn: work, open: new Map(), active: true, idleSince: t };
    work.agents.push(w);
    agents.set(agentId, w);
    // Rule: pair with the nearest preceding unpaired Agent call, unless a background launch already named this agent.
    const all = [...calls.values()];
    if (!all.some((c) => c.agentId === agentId)) {
      const pending = all.reverse().find((c) => c.agentId === undefined);
      if (pending !== undefined) pending.agentId = agentId;
    }
    return w;
  }

  function agentLane(r: HookRecord, t: number): LaneWork {
    return agents.get(r.agent_id!) ?? createAgent(r.agent_id!, r.agent_type!, t);
  }

  const laneFor = (r: HookRecord, t: number): LaneWork => (r.agent_id === undefined ? mainLane(t) : agentLane(r, t));

  /** Rule: PostToolUse on Agent confirms or corrects the pairing through tool_use_id. */
  function linkCall(toolUseId: string, spawned: string | undefined): void {
    const call = calls.get(toolUseId);
    if (call === undefined) return;
    if (spawned === undefined) {
      if (call.agentId === undefined) call.agentId = "";
      return;
    }
    for (const other of calls.values()) if (other !== call && other.agentId === spawned) delete other.agentId;
    call.agentId = spawned;
  }

  function stopMain(work: TurnWork, t: number, errorType: string | undefined): void {
    const { main } = work;
    if (main.active) {
      closeAll(main, t);
      main.active = false;
    }
    work.stoppedAt = t;
    main.lane.lastEventAt = t;
    if (errorType !== undefined) work.turn.errorType = errorType;
    if (work.agents.some((a) => a.lane.state === "running") && main.afterStopWait === undefined) {
      main.afterStopWait = { kind: "wait", start: t, afterStop: true };
      main.lane.pieces.push(main.afterStopWait);
    }
  }

  function agentFinished(work: TurnWork, t: number): void {
    const { main } = work;
    if (work.stoppedAt === undefined || main.afterStopWait === undefined) return;
    if (work.agents.some((a) => a.lane.state === "running")) return;
    main.afterStopWait.end = t;
    main.afterStopWait = undefined;
    main.resumeThinkFrom = t;
  }

  function endSession(t: number): void {
    for (const work of turns) {
      let open = work.main.active || work.main.afterStopWait !== undefined;
      for (const a of work.agents) {
        if (a.lane.state !== "running") continue;
        closeAll(a, t);
        a.active = false;
        a.lane.end = t;
        a.lane.state = "aborted";
        open = true;
      }
      if (!open) continue;
      if (work.main.active) closeAll(work.main, t);
      work.main.active = false;
      if (work.main.afterStopWait !== undefined) work.main.afterStopWait.end = t;
      work.main.afterStopWait = undefined;
      work.abortedAt = t;
    }
  }

  for (const r of records) {
    time = Math.max(time, r.time);
    const t = time;
    session.lastEventAt = t;
    if (session.ended !== undefined && r.event !== "SessionEnd") delete session.ended;

    switch (r.event) {
      case "SessionStart":
        if (r.project !== undefined && session.project === undefined) session.project = r.project;
        break;

      case "UserPromptSubmit": {
        const previous = current();
        if (previous !== undefined && previous.main.active) stopMain(previous, t, undefined);
        startTurn(t);
        break;
      }

      case "PreToolUse": {
        const w = laneFor(r, t);
        w.lane.lastEventAt = t;
        // A new call after a permission question means it was answered; an asked call without an end was denied.
        for (const [key, call] of w.open) if (call.askedAt !== undefined) closeCall(w, key, call, t, { unknownEnd: true });
        think(w, t);
        const tool = r.tool!;
        const toolUseId = r.tool_use_id!;
        const agent = tool === "Agent";
        const piece: Piece = { kind: agent ? (r.background ? "other" : "wait") : categoryOf(tool), start: t, tool, toolUseId };
        if (r.detail !== undefined) piece.detail = r.detail;
        if (agent && r.background) piece.launch = true;
        w.lane.pieces.push(piece);
        w.lane.calls++;
        w.open.set(toolUseId, { piece });
        if (agent) calls.set(toolUseId, { parentId: w.lane.id, background: r.background === true, ...(r.detail === undefined ? {} : { description: r.detail }) });
        break;
      }

      case "PermissionRequest": {
        const w = laneFor(r, t);
        w.lane.lastEventAt = t;
        const call = [...w.open.values()].reverse().find((c) => c.piece.tool === r.tool && c.askedAt === undefined);
        if (call !== undefined) {
          call.askedAt = t;
        } else {
          think(w, t);
          const piece: Piece = { kind: "you", start: t, tool: r.tool! };
          w.lane.pieces.push(piece);
          w.open.set(`ask:${asks++}`, { piece, askedAt: t });
        }
        break;
      }

      case "PostToolUse":
      case "PostToolUseFailure":
      case "PermissionDenied": {
        const w = laneFor(r, t);
        w.lane.lastEventAt = t;
        const key = r.tool_use_id!;
        let call = w.open.get(key);
        if (call === undefined) {
          // The PreToolUse hook did not run: rebuild the piece from the duration.
          const start = Math.max(w.lane.start, t - (r.duration_ms ?? 0));
          think(w, start);
          const piece: Piece = { kind: categoryOf(r.tool!), start, tool: r.tool!, toolUseId: key };
          w.lane.pieces.push(piece);
          w.lane.calls++;
          call = { piece };
          w.open.set(key, call);
        }
        closeCall(w, key, call, t, { failed: r.event !== "PostToolUse", ...(r.duration_ms === undefined ? {} : { durationMs: r.duration_ms }) });
        if (r.tool === "Agent") linkCall(key, r.spawned_agent_id);
        break;
      }

      case "SubagentStart": {
        const existing = agents.get(r.agent_id!);
        if (existing === undefined) {
          createAgent(r.agent_id!, r.agent_type!, t);
        } else {
          // A resumed agent runs SubagentStart again (documented).
          existing.active = true;
          existing.idleSince = t;
          existing.lane.state = "running";
          existing.lane.lastEventAt = t;
          delete existing.lane.end;
        }
        break;
      }

      case "SubagentStop": {
        const w = agentLane(r, t);
        w.lane.lastEventAt = t;
        closeAll(w, t);
        w.active = false;
        w.lane.end = t;
        w.lane.state = "done";
        agentFinished(w.turn, t);
        break;
      }

      case "Stop":
      case "StopFailure":
        stopMain(current() ?? startTurn(t), t, r.error_type);
        break;

      case "SessionEnd":
        endSession(t);
        session.ended = { at: t, ...(r.reason === undefined ? {} : { reason: r.reason }) };
        break;
    }
  }

  finish(turns, calls, agents, session, now);
  return session;
}

/** How much later than its agent an Agent call may end and still count as waiting for it. */
const LAUNCH_MARGIN_MS = 500;

function finish(turns: TurnWork[], calls: Map<string, AgentCall>, agents: Map<string, LaneWork>, session: SessionModel, now: number): void {
  const callByAgent = new Map<string, AgentCall>();
  for (const call of calls.values()) if (call.agentId) callByAgent.set(call.agentId, call);

  for (const work of turns) {
    const works = [work.main, ...work.agents];
    for (const w of works) {
      if (w.active && w.idleSince !== undefined) w.lane.pieces.push({ kind: "think", start: w.idleSince });
      for (const piece of w.lane.pieces) {
        const agentId = piece.tool === "Agent" && piece.toolUseId !== undefined ? calls.get(piece.toolUseId)?.agentId : undefined;
        if (!agentId) continue;
        piece.agentId = agentId;
        // An Agent call that ends long before its agent does was a launch, not a wait: Claude Code
        // answers at once for a background agent, even when run_in_background is not in the call.
        const agent = agents.get(agentId);
        if (agent === undefined || piece.end === undefined) continue;
        const ended = agent.lane.end;
        if (ended !== undefined && piece.end >= ended - LAUNCH_MARGIN_MS) continue;
        piece.kind = "other";
        piece.launch = true;
        agent.lane.background = true;
      }
      w.lane.pieces.sort((a, b) => a.start - b.start);
    }
    for (const a of work.agents) {
      const call = callByAgent.get(a.lane.id);
      a.lane.parentId = call?.parentId ?? "main";
      if (call !== undefined) {
        a.lane.background = a.lane.background || call.background;
        if (call.description !== undefined) a.lane.description = call.description;
      }
    }

    const { turn, main } = work;
    const running = work.agents.some((a) => a.lane.state === "running");
    if (work.abortedAt !== undefined) {
      turn.state = main.lane.state = "aborted";
      turn.end = main.lane.end = work.abortedAt;
    } else if (!main.active && work.stoppedAt !== undefined && !running) {
      turn.state = main.lane.state = "done";
      turn.end = main.lane.end = Math.max(work.stoppedAt, ...work.agents.map((a) => a.lane.end ?? 0));
    }

    turn.lanes = treeOrder(works.map((w) => w.lane));
  }

  if (session.ended !== undefined) return;
  for (const turn of session.turns) {
    const signal = (lane: Lane): number =>
      Math.max(lane.lastEventAt, ...turn.lanes.filter((l) => l.parentId === lane.id && l.state === "running").map(signal));
    for (const lane of turn.lanes) {
      if (lane.kind !== "agent" || lane.state !== "running") continue;
      const last = signal(lane);
      if (now - last > UNKNOWN_AFTER_MS) {
        lane.state = "unknown";
        lane.silentSince = last;
      }
    }
    const main = turn.lanes[0];
    if (main !== undefined && turn.state === "running" && now - session.lastEventAt > UNKNOWN_AFTER_MS) {
      turn.state = main.state = "unknown";
      main.silentSince = session.lastEventAt;
    }
  }
}

/** The main session first, then each lane followed by the lanes it started, by start time. */
function treeOrder(lanes: Lane[]): Lane[] {
  const ids = new Set(lanes.map((l) => l.id));
  for (const lane of lanes) if (lane.kind === "agent" && !ids.has(lane.parentId ?? "")) lane.parentId = "main";
  const ordered: Lane[] = [];
  const visit = (lane: Lane, depth: number): void => {
    if (ordered.includes(lane)) return;
    lane.depth = depth;
    ordered.push(lane);
    for (const child of lanes.filter((l) => l.parentId === lane.id).sort((a, b) => a.start - b.start)) visit(child, depth + 1);
  };
  for (const lane of lanes) if (lane.kind === "main") visit(lane, 0);
  for (const lane of lanes) visit(lane, 1);
  return ordered;
}
