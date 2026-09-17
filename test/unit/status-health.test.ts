import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectionState } from "../../src/connect/plan.ts";
import { statusFacts, type HealthInput } from "../../src/status/health.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const STATE: ConnectionState = {
  format: 1,
  node: { path: "/usr/bin/node", version: "24.14.1" },
  collectorSha256: A,
  manifestSha256: A,
  hooksSha256: B,
  connectedAt: 0,
};
const OK: HealthInput = {
  connection: { state: "present", value: STATE },
  hooks: { state: "present", sha256: B },
  collector: { state: "present", sha256: A },
  nodeExists: true,
  storeError: null,
  lastEventAt: 1000,
  dropped: 2,
  refused: 1,
};

test("statusraden visar aktivt plugin med senaste händelse och kastade händelser", () => {
  assert.deepEqual(statusFacts(OK), { kind: "active", lastEventAt: 1000, dropped: 2, refused: 1 });
});

test("statusraden visar det allvarligaste problemet först (Q18, Q36, R3)", () => {
  assert.deepEqual(statusFacts({ ...OK, connection: { state: "missing" }, storeError: "fel" }), { kind: "not-connected" });
  assert.deepEqual(statusFacts({ ...OK, connection: { state: "invalid", reason: "trasig" } }), { kind: "invalid-connection", reason: "trasig" });
  assert.deepEqual(statusFacts({ ...OK, hooks: { state: "missing" } }), { kind: "plugin-missing" });
  assert.deepEqual(statusFacts({ ...OK, hooks: { state: "present", sha256: A } }), { kind: "changed", file: "hooks.json", actual: A, expected: B });
  assert.deepEqual(statusFacts({ ...OK, hooks: { state: "unsafe" } }), { kind: "changed", file: "hooks.json", actual: null, expected: B });
  assert.deepEqual(statusFacts({ ...OK, collector: { state: "missing" } }), { kind: "changed", file: "collector.cjs", actual: null, expected: A });
  assert.deepEqual(statusFacts({ ...OK, nodeExists: false }), { kind: "node-missing", path: "/usr/bin/node" });
  assert.deepEqual(statusFacts({ ...OK, storeError: "sessions är en symbolisk länk." }), { kind: "store-refused", reason: "sessions är en symbolisk länk." });
});
