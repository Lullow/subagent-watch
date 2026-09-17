/** Q26: Läsa, Terminal, Skriva, Tänka, Vänta, Väntar på dig and Övrigt. */
export type PieceKind = "read" | "term" | "write" | "think" | "wait" | "you" | "other";

export interface Piece {
  kind: PieceKind;
  /** Milliseconds since the epoch, made monotonic in file order. */
  start: number;
  /** Undefined while the piece is still open. */
  end?: number;
  tool?: string;
  toolUseId?: string;
  detail?: string;
  /** Wait pieces: the agent that is waited for. */
  agentId?: string;
  /** Main lane: the turn has stopped but agents in the background are still running. */
  afterStop?: boolean;
  failed?: boolean;
  /** Closed by a later event instead of its own (Q32). */
  unknownEnd?: boolean;
  /** Launch of a background agent: an instant call the view leaves out. */
  launch?: boolean;
}

/** unknown: running, but no signal for 10 minutes (Q13). aborted: the session ended first. */
export type LaneState = "running" | "done" | "aborted" | "unknown";

export interface Lane {
  /** "main" for the main session, otherwise the agent_id. */
  id: string;
  kind: "main" | "agent";
  agentType?: string;
  /** The description of the Agent call that started the agent, when the pairing is known. */
  description?: string;
  background: boolean;
  /** The lane that started this one; undefined for the main session. */
  parentId?: string;
  depth: number;
  start: number;
  end?: number;
  state: LaneState;
  /** For the unknown state: the last signal from the lane or its running descendants. */
  silentSince?: number;
  pieces: Piece[];
  calls: number;
  lastEventAt: number;
}

export interface Turn {
  index: number;
  start: number;
  /** When the main session has stopped and every agent started in the turn is done (Q27). */
  end?: number;
  state: LaneState;
  errorType?: string;
  /** Tree order: the main session first, then each agent followed by the agents it started. */
  lanes: Lane[];
}

export interface SessionModel {
  id: string;
  project?: string;
  start: number;
  lastEventAt: number;
  ended?: { at: number; reason?: string };
  turns: Turn[];
}

/** A project outside the window, summarized on one row (Q3). */
export interface OtherProject {
  name: string;
  running: number;
  unknown: number;
}
