import type { OtherProject, SessionModel } from "../model/types.ts";

/** The only text the view may put on the clipboard (S10). Nothing is ever run. */
export const COPYABLE_COMMANDS = ["npm run connect", "npm run connect -- --disconnect"] as const;
export type CopyableCommand = (typeof COPYABLE_COMMANDS)[number];

/** Q18, Q36, R3: what the status row says. Clock times are formatted in the webview. */
export type StatusFacts =
  | { kind: "not-connected" }
  | { kind: "invalid-connection"; reason: string }
  | { kind: "store-refused"; reason: string }
  | { kind: "plugin-missing" }
  | { kind: "changed"; file: "collector.cjs" | "hooks.json"; actual: string | null; expected: string }
  | { kind: "node-missing"; path: string }
  | { kind: "active"; lastEventAt: number | null; dropped: number; anonymous: number; refused: number };

export interface ViewSnapshot {
  /** The extension host's clock. Records use it too, and in WSL it can differ from the webview's. */
  now: number;
  sessions: SessionModel[];
  others: OtherProject[];
  status: StatusFacts;
}

export type ToWebview = { type: "snapshot"; snapshot: ViewSnapshot } | { type: "copied"; command: CopyableCommand };
export type FromWebview = { type: "ready" } | { type: "copy"; command: CopyableCommand };
