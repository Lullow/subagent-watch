import { basename } from "node:path";
import type { SessionModel } from "./types.ts";

/** Sessions in other projects count in the summary row while they run agents or were active recently. */
export const OTHERS_RECENT_MS = 60 * 60 * 1000;

export interface OtherProject {
  name: string;
  running: number;
  unknown: number;
}

export interface WindowView {
  /** Sessions in the window's projects, the most recently active first (Q16). */
  sessions: SessionModel[];
  /** One row for sessions in other projects (Q3), by project. */
  others: OtherProject[];
  /** Running and unknown agents in the window's projects, for the status bar (Q11). */
  running: number;
  unknown: number;
}

export const expandHome = (path: string, home: string): string => (path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path);

/** Q3: a session belongs to the window when its cwd at SessionStart is inside one of its folders. */
export function inFolders(project: string | undefined, folders: readonly string[], home: string): boolean {
  if (project === undefined) return false;
  const path = expandHome(project, home).replace(/\/+$/, "");
  return folders.some((folder) => {
    const f = folder.replace(/\/+$/, "");
    return path === f || path.startsWith(`${f}/`);
  });
}

function agentCounts(session: SessionModel): { running: number; unknown: number } {
  let running = 0;
  let unknown = 0;
  for (const turn of session.turns) {
    for (const lane of turn.lanes) {
      if (lane.kind !== "agent") continue;
      if (lane.state === "running") running++;
      if (lane.state === "unknown") unknown++;
    }
  }
  return { running, unknown };
}

export function windowView(models: readonly SessionModel[], folders: readonly string[], home: string, now: number): WindowView {
  const mine: SessionModel[] = [];
  const others = new Map<string, OtherProject>();

  for (const session of models) {
    if (inFolders(session.project, folders, home)) {
      // Q15: an ended session stays until a new session starts in the same project.
      const replaced = session.ended !== undefined && models.some((other) => other !== session && other.project === session.project && other.start > session.ended!.at);
      if (!replaced) mine.push(session);
      continue;
    }
    if (session.ended !== undefined) continue;
    const counts = agentCounts(session);
    if (counts.running === 0 && counts.unknown === 0 && now - session.lastEventAt > OTHERS_RECENT_MS) continue;
    const name = session.project === undefined ? "okänt projekt" : basename(expandHome(session.project, home));
    const entry = others.get(name) ?? { name, running: 0, unknown: 0 };
    entry.running += counts.running;
    entry.unknown += counts.unknown;
    others.set(name, entry);
  }

  mine.sort((a, b) => b.lastEventAt - a.lastEventAt);
  const totals = mine.map(agentCounts).reduce((sum, c) => ({ running: sum.running + c.running, unknown: sum.unknown + c.unknown }), { running: 0, unknown: 0 });
  return { sessions: mine, others: [...others.values()].sort((a, b) => a.name.localeCompare(b.name)), ...totals };
}
