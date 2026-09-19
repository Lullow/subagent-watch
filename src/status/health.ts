import type { ConnectionState } from "../connect/plan.ts";
import type { StatusFacts } from "../view/types.ts";

export type FileHash = { state: "present"; sha256: string } | { state: "missing" } | { state: "unsafe" };

export interface InstallFacts {
  connection: { state: "missing" } | { state: "invalid"; reason: string } | { state: "present"; value: ConnectionState };
  hooks: FileHash;
  collector: FileHash;
  nodeExists: boolean;
}

export interface HealthInput extends InstallFacts {
  storeError: string | null;
  lastEventAt: number | null;
  dropped: number;
  anonymous: number;
  refused: number;
}

const actual = (file: FileHash): string | null => (file.state === "present" ? file.sha256 : null);

/** Q18, Q36 and R3, in order of what blocks the most. */
export function statusFacts(input: HealthInput): StatusFacts {
  const { connection } = input;
  if (connection.state === "missing") return { kind: "not-connected" };
  if (connection.state === "invalid") return { kind: "invalid-connection", reason: connection.reason };
  if (input.hooks.state === "missing") return { kind: "plugin-missing" };
  const state = connection.value;
  if (actual(input.hooks) !== state.hooksSha256) return { kind: "changed", file: "hooks.json", actual: actual(input.hooks), expected: state.hooksSha256 };
  if (actual(input.collector) !== state.collectorSha256) {
    return { kind: "changed", file: "collector.cjs", actual: actual(input.collector), expected: state.collectorSha256 };
  }
  if (!input.nodeExists) return { kind: "node-missing", path: state.node.path };
  if (input.storeError !== null) return { kind: "store-refused", reason: input.storeError };
  return { kind: "active", lastEventAt: input.lastEventAt, dropped: input.dropped, anonymous: input.anonymous, refused: input.refused };
}
