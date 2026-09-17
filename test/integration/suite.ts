// Runs inside the VS Code extension host, started by scripts/integration.ts.
import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { TestApi } from "../../src/extension.ts";

const TIMEOUT_MS = 20_000;
const COMMANDS = ["subagentWatch.openView", "subagentWatch.deleteData"];

/** Refreshes run every second and the webview loads on its own, so tests wait for the state they expect. */
async function waitFor<T>(describe: () => string, read: () => T | null): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Väntade förgäves: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const tests: [string, (api: TestApi) => Promise<void>][] = [
  [
    "alla kommandon finns i VS Code",
    async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const command of COMMANDS) assert.ok(commands.includes(command), command);
    },
  ],
  [
    "statusfältet visar agenten som kör i fönstrets projekt (Q11)",
    async (api) => {
      await waitFor(
        () => `statusfältet visar "${api.statusBarText()}"`,
        () => (api.statusBarText() === "$(gear) 1" ? true : null),
      );
    },
  ],
  [
    "vyn öppnas, webbvyns skript laddas under säkerhetsreglerna och vyn får sessionen och statusraden",
    async (api) => {
      await vscode.commands.executeCommand("subagentWatch.openView");
      await waitFor(
        () => "webbvyns skript skickade aldrig ready",
        () => (api.webviewReady() ? true : null),
      );
      const snapshot = await waitFor(
        () => `vyns data är ${JSON.stringify(api.snapshot()?.status ?? null)}`,
        () => {
          const current = api.snapshot();
          return current !== null && current.sessions.length === 1 && current.status.kind === "active" ? current : null;
        },
      );
      const turn = snapshot.sessions[0]!.turns.at(-1)!;
      assert.deepEqual(
        turn.lanes.map((lane) => [lane.kind, lane.agentType, lane.description, lane.state]),
        [
          ["main", undefined, undefined, "running"],
          ["agent", "Explore", "Kartlägg hook-dokumentationen", "running"],
        ],
      );
    },
  ],
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<TestApi | undefined>("lullo.subagent-watch");
  assert.ok(extension, "extensionen lullo.subagent-watch finns inte");
  const api = await extension.activate();
  assert.ok(api, "extensionen gav inget API i testläget");

  const failures: string[] = [];
  for (const [name, test] of tests) {
    try {
      await test(api);
      console.log(`✔ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`✖ ${name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} av ${tests.length} integrationstester föll: ${failures.join("; ")}`);
}
