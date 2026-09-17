import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseRecordLine } from "../../src/model/schema.ts";

const valid = { v: 1, time: 1_789_646_400_000, event: "PreToolUse", agent_id: "a25fe1c0d2e3f4a5b", agent_type: "Explore", tool: "Read", tool_use_id: "toolu_1", detail: "docs/a.md" };

test("alla rader från insamlaren i testdatan godkänns", () => {
  const dir = new URL("../fixtures/runs/", import.meta.url);
  let lines = 0;
  for (const file of readdirSync(dir)) {
    for (const line of readFileSync(new URL(file, dir), "utf8").trim().split("\n")) {
      assert.notEqual(parseRecordLine(line), null, line);
      lines++;
    }
  }
  assert.ok(lines > 80);
  assert.deepEqual(parseRecordLine(JSON.stringify(valid)), valid);
});

test("rader som inte följer schemat avvisas helt", () => {
  const rtl = String.fromCodePoint(0x202e);
  const cases: unknown[] = [
    { ...valid, extra: "okänt fält" },
    { ...valid, v: 2 },
    { ...valid, time: "nu" },
    { ...valid, time: -1 },
    { ...valid, event: "Notification" },
    { ...valid, agent_type: undefined },
    { ...valid, agent_id: "../x" },
    { ...valid, tool: "Read Bash" },
    { ...valid, detail: `fil${rtl}.md` },
    { ...valid, detail: "x".repeat(241) },
    { ...valid, detail: "" },
    { ...valid, background: false },
    { ...valid, duration_ms: 1.5 },
    { ...valid, error_type: "hemligt fel" },
    { v: 1, event: "Stop" },
    [valid],
  ];
  for (const value of cases) assert.equal(parseRecordLine(JSON.stringify(value)), null, JSON.stringify(value));
  assert.equal(parseRecordLine("{inte json"), null);
});
