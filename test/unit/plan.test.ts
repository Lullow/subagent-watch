import assert from "node:assert/strict";
import { test } from "node:test";
import { HOOK_EVENTS } from "../../src/collector/record.ts";
import {
  assertCommandPath,
  canonicalJson,
  collectorArgs,
  hooksConfig,
  layoutFor,
  manifestJson,
  nodeVersionSupported,
  parseConnectionState,
  planRemovals,
} from "../../src/connect/plan.ts";

const NODE = "/home/lullo/.nvm/versions/node/v24.14.1/bin/node";

test("hookens kommando är exec-form med tom miljö och snäva rättigheter", () => {
  const layout = layoutFor("/home/lullo");
  assert.equal(layout.plugin, "/home/lullo/.claude/skills/subagent-watch");
  assert.equal(layout.hooks, "/home/lullo/.claude/skills/subagent-watch/hooks/hooks.json");
  assert.deepEqual(collectorArgs(NODE, layout), [
    "-i",
    NODE,
    "--permission",
    "--allow-fs-read=/home/lullo/.subagent-watch/bin/collector.cjs",
    "--allow-fs-read=/home/lullo/.subagent-watch/sessions/",
    "--allow-fs-write=/home/lullo/.subagent-watch/sessions/",
    "/home/lullo/.subagent-watch/bin/collector.cjs",
    "--home=/home/lullo/.subagent-watch",
  ]);
});

test("hooks.json har alla händelser, sync och timeout 3 s, utan skal", () => {
  const layout = layoutFor("/home/lullo");
  const config = hooksConfig(NODE, layout);
  assert.deepEqual(Object.keys(config.hooks), [...HOOK_EVENTS]);
  for (const groups of Object.values(config.hooks)) {
    assert.deepEqual(groups, [{ hooks: [{ type: "command", command: "/usr/bin/env", args: collectorArgs(NODE, layout), timeout: 3 }] }]);
  }
});

test("sökvägar med otillåtna tecken avvisas i kommandot", () => {
  for (const path of ["/home/lullo/min node/node", "/home/lullo/../root/node", "relativ/node", "/home/lullo/$(id)/node", "/home/lullo/a;b"]) {
    assert.throws(() => assertCommandPath(path), /inte är tillåtna/, path);
  }
  assert.throws(() => collectorArgs("/home/lullo/min node/node", layoutFor("/home/lullo")));
  assert.throws(() => collectorArgs(NODE, layoutFor("/home/lu llo")));
});

test("bara Node med rättelsen av CVE-2025-55130 godkänns", () => {
  const cases: [string, boolean][] = [
    ["24.13.0", true],
    ["v24.14.1", true],
    ["24.12.9", false],
    ["22.22.0", false],
    ["25.2.0", false],
    ["25.3.0", true],
    ["26.0.0", true],
    ["24.13", false],
    ["v24.14.1-pre", false],
  ];
  for (const [version, ok] of cases) assert.equal(nodeVersionSupported(version), ok, version);
});

test("plugin.json har ett giltigt namn och inga fält för hooks", () => {
  const manifest = JSON.parse(manifestJson());
  assert.deepEqual(Object.keys(manifest).sort(), ["description", "name"]);
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test("lika planer ger samma JSON oavsett nyckelordning", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } }), canonicalJson({ a: { c: null, d: [2, { e: 0, f: 1 }] }, b: 1 }));
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

const HASH = "a".repeat(64);
const STATE = {
  format: 1,
  node: { path: NODE, version: "24.14.1" },
  collectorSha256: HASH,
  manifestSha256: HASH,
  hooksSha256: HASH,
  connectedAt: 1_789_646_400_000,
};

test("connection.json läses strikt", () => {
  assert.deepEqual(parseConnectionState(JSON.stringify(STATE)), STATE);
  const broken: [unknown, RegExp][] = [
    [{ ...STATE, extra: 1 }, /extra/],
    [{ ...STATE, format: 2 }, /format/],
    [{ ...STATE, hooksSha256: "ABC" }, /hooksSha256/],
    [{ ...STATE, node: { path: "/min node/node", version: "24.14.1" } }, /node\.path/],
    [{ ...STATE, node: { path: NODE, version: "24.14.1", extra: true } }, /node/],
    [[], /rot/],
  ];
  for (const [value, message] of broken) assert.throws(() => parseConnectionState(JSON.stringify(value)), message);
  assert.throws(() => parseConnectionState("{"), /inte giltig JSON/);
});

test("bortkopplingen tar bara bort filer vars kontrollsumma stämmer", () => {
  const other = "b".repeat(64);
  assert.deepEqual(
    planRemovals([
      { path: "/h/hooks.json", expected: HASH, state: "present", sha256: other },
      { path: "/h/plugin.json", expected: HASH, state: "present", sha256: HASH },
      { path: "/h/collector.cjs", expected: HASH, state: "missing" },
    ]),
    {
      remove: [{ path: "/h/plugin.json", sha256: HASH }],
      keep: [{ path: "/h/hooks.json", reason: `har ändrats sedan anslutningen (sha256 ${other})` }],
      removeConnection: false,
    },
  );
  assert.deepEqual(planRemovals([{ path: "/h/hooks.json", expected: HASH, state: "unsafe", reason: "är en symbolisk länk." }]), {
    remove: [],
    keep: [{ path: "/h/hooks.json", reason: "är en symbolisk länk." }],
    removeConnection: false,
  });
  assert.deepEqual(planRemovals([{ path: "/h/hooks.json", expected: HASH, state: "missing" }]), { remove: [], keep: [], removeConnection: true });
});
