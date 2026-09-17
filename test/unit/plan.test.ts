import assert from "node:assert/strict";
import { test } from "node:test";
import { HOOK_EVENTS } from "../../src/collector/record.ts";
import { assertCommandPath, collectorArgs, hooksConfig, layoutFor, nodeVersionSupported } from "../../src/connect/plan.ts";

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
