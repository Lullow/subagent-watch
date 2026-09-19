import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseHook, type HookRecord } from "../../src/collector/record.ts";

/** 2026-09-17 12:00 UTC. */
const NOW = 1_789_646_400_000;
const HOME = "/home/lullo";
const SESSION = "3f9a2c1e-7b4d-4e0a-9c55-1d2e8f6a7b90";

const fixtureLines = (): string[] =>
  readFileSync(new URL("../fixtures/hooks/session.jsonl", import.meta.url), "utf8").trim().split("\n");

function parsed(line: string): HookRecord {
  const result = parseHook(line, NOW, HOME);
  assert.ok(result.ok, `raden ska gå att tolka: ${line.slice(0, 120)}`);
  assert.equal(result.sessionId, SESSION);
  return result.record;
}

const base = { v: 1, time: NOW } as const;
const explore = { agent_id: "a25fe1c0d2e3f4a5b", agent_type: "Explore" } as const;

test("varje händelsetyp sparar bara fälten i tillåtelselistan", () => {
  assert.deepEqual(fixtureLines().map(parsed), [
    { ...base, event: "SessionStart", project: "~/projects/subagent-watch" },
    { ...base, event: "UserPromptSubmit" },
    { ...base, event: "PreToolUse", tool: "Agent", tool_use_id: "toolu_01AgentForeground", detail: "Kartlägg hook-dokumentationen" },
    { ...base, event: "SubagentStart", ...explore },
    { ...base, event: "PreToolUse", ...explore, tool: "Bash", tool_use_id: "toolu_02Bash", detail: "Hämta sidan" },
    { ...base, event: "PostToolUse", ...explore, tool: "Bash", tool_use_id: "toolu_02Bash", duration_ms: 56 },
    { ...base, event: "PreToolUse", ...explore, tool: "Grep", tool_use_id: "toolu_03Grep" },
    { ...base, event: "PreToolUse", ...explore, tool: "WebFetch", tool_use_id: "toolu_04WebFetch", detail: "code.claude.com" },
    { ...base, event: "PreToolUse", ...explore, tool: "WebSearch", tool_use_id: "toolu_05WebSearch" },
    { ...base, event: "PreToolUse", ...explore, tool: "Read", tool_use_id: "toolu_06Read", detail: "docs/<img src=x onerror=alert(1)>.md" },
    { ...base, event: "PostToolUseFailure", ...explore, tool: "Read", tool_use_id: "toolu_06Read", duration_ms: 3 },
    { ...base, event: "PermissionRequest", ...explore, tool: "Edit" },
    { ...base, event: "PermissionDenied", ...explore, tool: "Edit", tool_use_id: "toolu_07Edit" },
    { ...base, event: "SubagentStop", ...explore },
    { ...base, event: "PostToolUse", tool: "Agent", tool_use_id: "toolu_01AgentForeground", spawned_agent_id: "a25fe1c0d2e3f4a5b", duration_ms: 6600 },
    { ...base, event: "PreToolUse", tool: "Agent", tool_use_id: "toolu_08AgentBackground", detail: "Testa plugin-installationen", background: true },
    { ...base, event: "PreToolUse", tool: "Write", tool_use_id: "toolu_09Write", detail: "~/.claude/settings.json" },
    { ...base, event: "Stop" },
    { ...base, event: "StopFailure", error_type: "rate_limit" },
    { ...base, event: "SessionEnd", reason: "other" },
  ]);
});

test("sparar aldrig kommandon, prompter, mönster, sökfrågor, rapporter, felmeddelanden eller hela adresser", () => {
  const saved = fixtureLines().map((line) => JSON.stringify(parsed(line))).join("\n").toLowerCase();
  const forbidden = ["hemlig", "curl", "sk-ant", "hunter2", "password", "sökfråga", "token", "enoent", "transcript", "prompt_id", "5c1d0b7e", "/hooks?", "example.com", "rapport", "anledning", "detaljer", "stdout", "claude-opus"];
  for (const word of forbidden) assert.ok(!saved.includes(word), `${word} får inte sparas`);
});

test("ogiltig indata kastas med en orsak men utan innehåll", () => {
  const event = (fields: Record<string, unknown>) =>
    JSON.stringify({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_1", ...fields });
  const cases: [string, string][] = [
    ["", "empty"],
    ["inte json", "not_json"],
    ["null", "not_object"],
    ["[]", "not_object"],
    ["{}", "session_id"],
    [event({ session_id: "../../etc/passwd" }), "session_id"],
    [event({ session_id: SESSION.toUpperCase() }), "session_id"],
    [event({ hook_event_name: "Notification" }), "event"],
    [event({ tool_name: "Read Bash" }), "tool"],
    [event({ tool_name: undefined }), "tool"],
    [event({ tool_use_id: "toolu_1; rm" }), "tool_use_id"],
  ];
  for (const [input, reason] of cases) {
    assert.deepEqual(parseHook(input, NOW, HOME), { ok: false, reason }, input);
  }
});

test("en halv eller ogiltig identitet kostar fältet, aldrig händelsen", () => {
  const event = (fields: Record<string, unknown>) =>
    JSON.stringify({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_1", ...fields });
  const pre = { ...base, event: "PreToolUse", tool: "Read", tool_use_id: "toolu_1" } as const;
  const cases: [string, HookRecord, "agent_identity" | undefined][] = [
    // Ett oanvändbart fält tar bara sig självt med sig, och räknas.
    [event({ agent_id: "a/b", agent_type: "Explore" }), { ...pre, agent_type: "Explore" }, "agent_identity"],
    [event({ agent_id: explore.agent_id, agent_type: "a b" }), { ...pre, agent_id: explore.agent_id }, "agent_identity"],
    // Huvudtråden i en --agent-session skickar agent_type utan agent_id.
    [event({ agent_type: "Explore" }), { ...pre, agent_type: "Explore" }, undefined],
    [event({ agent_id: explore.agent_id }), { ...pre, agent_id: explore.agent_id }, undefined],
    // Claude Codes interna agenter avslutar med tom agent_type, varje tur.
    // Tomt betyder "ingen identitet", inte "identitet vi tappade": inget larm.
    [
      JSON.stringify({ session_id: SESSION, hook_event_name: "SubagentStop", agent_id: explore.agent_id, agent_type: "" }),
      { ...base, event: "SubagentStop", agent_id: explore.agent_id },
      undefined,
    ],
    // Även utan identitet alls är subagent-händelsen värd att spara.
    [JSON.stringify({ session_id: SESSION, hook_event_name: "SubagentStart" }), { ...base, event: "SubagentStart" }, undefined],
    // En hel identitet passerar orörd.
    [event(explore), { ...pre, ...explore }, undefined],
  ];
  for (const [input, record, note] of cases) {
    const result = parseHook(input, NOW, HOME);
    assert.ok(result.ok, input);
    assert.deepEqual(result.record, record, input);
    assert.equal(result.note, note, input);
  }
});

test("okända värden för feltyp, orsak, tid och agentens id sparas inte", () => {
  const line = (fields: Record<string, unknown>) => JSON.stringify({ session_id: SESSION, ...fields });
  assert.deepEqual(parsed(line({ hook_event_name: "StopFailure", error_type: "Något hemligt gick fel" })), { ...base, event: "StopFailure" });
  assert.deepEqual(parsed(line({ hook_event_name: "SessionEnd", reason: "hemlig" })), { ...base, event: "SessionEnd" });
  const post = { ...base, event: "PostToolUse", tool_use_id: "toolu_1" } as const;
  assert.deepEqual(parsed(line({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_1", duration_ms: -1 })), { ...post, tool: "Read" });
  assert.deepEqual(parsed(line({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_1", tool_response: { agentId: "../x" } })), { ...post, tool: "Agent" });
});

const spikeRuns = fileURLToPath(new URL("../../spike/runs/", import.meta.url));

test(
  "inget från spike-körningarna innehåller kommandon, prompter, Grep-mönster eller hela adresser",
  { skip: existsSync(spikeRuns) ? false : "spike/runs/ checkas aldrig in" },
  () => {
    let checked = 0;
    for (const file of readdirSync(spikeRuns).filter((f) => f.endsWith(".jsonl"))) {
      for (const line of readFileSync(`${spikeRuns}${file}`, "utf8").trim().split("\n")) {
        const { at: _at, ...event } = JSON.parse(line) as Record<string, any>;
        const result = parseHook(JSON.stringify(event), NOW, HOME);
        if (!result.ok) continue;
        checked++;
        const saved = JSON.stringify(result.record);
        const input = event.tool_input ?? {};
        const forbidden = [
          input.command,
          input.prompt,
          event.tool_name === "Grep" ? input.pattern : undefined,
          input.query,
          input.url,
          event.prompt,
          event.last_assistant_message,
          event.transcript_path,
          event.agent_transcript_path,
          event.prompt_id,
        ];
        for (const value of forbidden) {
          if (typeof value !== "string" || value.length < 4) continue;
          assert.ok(!saved.includes(value.replace(/…$/, "")), `${file}: ${value.slice(0, 40)} får inte sparas`);
        }
      }
    }
    assert.ok(checked > 50, `${checked} händelser kontrollerades`);
  },
);
