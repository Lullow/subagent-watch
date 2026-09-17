import assert from "node:assert/strict";
import { test } from "node:test";
import { interpretSession } from "../../src/model/interpret.ts";
import type { SessionModel } from "../../src/model/types.ts";
import { expandHome, inFolders, OTHERS_RECENT_MS, windowView } from "../../src/model/window.ts";
import { at, T } from "../helpers/records.ts";

const HOME = "/home/lullo";
const FOLDERS = ["/home/lullo/projects/subagent-watch"];

function session(id: string, project: string | undefined, start: number, options: { agent?: boolean; endAt?: number } = {}): SessionModel {
  const records = [
    at(start, "SessionStart", project === undefined ? {} : { project }),
    at(start + 1, "UserPromptSubmit"),
    ...(options.agent ? [at(start + 2, "SubagentStart", { agent_id: `${id}agent`, agent_type: "Explore" })] : []),
    ...(options.endAt === undefined ? [] : [at(options.endAt, "SessionEnd", { reason: "other" })]),
  ];
  return interpretSession(id, records, T(start + 10));
}

test("en session hör till fönstret när projektet ligger i en av dess mappar", () => {
  assert.equal(expandHome("~/projects/x", HOME), "/home/lullo/projects/x");
  assert.ok(inFolders("~/projects/subagent-watch", FOLDERS, HOME));
  assert.ok(inFolders("~/projects/subagent-watch/src", FOLDERS, HOME));
  assert.ok(inFolders("/home/lullo/projects/subagent-watch", [`${FOLDERS[0]}/`], HOME));
  assert.ok(!inFolders("~/projects/subagent-watch-2", FOLDERS, HOME));
  assert.ok(!inFolders("~/projects", FOLDERS, HOME));
  assert.ok(!inFolders(undefined, FOLDERS, HOME));
});

test("sessioner i fönstret sorteras efter senaste aktivitet och räknar agenter", () => {
  const older = session("a", "~/projects/subagent-watch", 0, { agent: true });
  const newer = session("b", "~/projects/subagent-watch/src", 100, { agent: true });
  const view = windowView([older, newer], FOLDERS, HOME, T(110));
  assert.deepEqual(view.sessions.map((s) => s.id), ["b", "a"]);
  assert.deepEqual([view.running, view.unknown], [2, 0]);
});

test("en avslutad session ligger kvar tills en ny session startar i projektet", () => {
  const ended = session("a", "~/projects/subagent-watch", 0, { endAt: 50 });
  assert.deepEqual(windowView([ended], FOLDERS, HOME, T(60)).sessions.map((s) => s.id), ["a"]);
  const next = session("b", "~/projects/subagent-watch", 100);
  assert.deepEqual(windowView([ended, next], FOLDERS, HOME, T(110)).sessions.map((s) => s.id), ["b"]);
});

test("andra projekt sammanfattas per projekt, utan avslutade och gamla sessioner", () => {
  const running = session("a", "~/projects/tokeniser", 0, { agent: true });
  const recent = session("b", "~/projects/tokeniser", 5);
  const ended = session("c", "~/projects/dotfiles", 0, { endAt: 8 });
  const stale = session("d", "~/projects/gammal", 0);
  const unknownProject = session("e", undefined, 5, { agent: true });
  const now = T(20) + OTHERS_RECENT_MS;
  const view = windowView([running, recent, ended, stale, unknownProject], FOLDERS, HOME, now);
  assert.deepEqual(view.others, [
    { name: "okänt projekt", running: 1, unknown: 0 },
    { name: "tokeniser", running: 1, unknown: 0 },
  ]);
  assert.deepEqual(view.sessions, []);
});
