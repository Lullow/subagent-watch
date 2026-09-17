// Runs the integration tests in real VS Code, against a temporary home directory with made-up data.
//   npm run test:integration      needs a display; CI runs it through xvfb-run
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";
import { build, stop } from "esbuild";
import { initStore, sessionFile } from "../src/collector/store.ts";
import { hooksJson, layoutFor, manifestJson, type ConnectionState } from "../src/connect/plan.ts";
import { ensurePrivateDir, sha256 } from "../src/secure/fs.ts";

/** The lowest version in engines.vscode. */
const VSCODE_VERSION = "1.137.0";
const root = resolve(import.meta.dirname, "..");
const suite = join(root, "dist", "integration", "suite.cjs");
export const SESSION_ID = "3f9a2c1e-7b4d-4e0a-9c55-1d2e8f6a7b90";

/** A connected subagent-watch and a session in ~/projects/demo where an Explore agent is reading a file. */
function fixtureHome(): { home: string; project: string } {
  const home = mkdtempSync(join(tmpdir(), "subagent-watch-integration-"));
  const layout = layoutFor(home);
  initStore(layout.home);
  ensurePrivateDir(layout.bin);
  const collector = readFileSync(join(root, "dist", "collector.js"));
  writeFileSync(layout.collector, collector, { mode: 0o600 });

  const nodePath = realpathSync(process.execPath);
  mkdirSync(layout.manifestDir, { recursive: true, mode: 0o700 });
  mkdirSync(layout.hooksDir, { mode: 0o700 });
  const manifest = manifestJson();
  const hooks = hooksJson(nodePath, layout);
  writeFileSync(layout.manifest, manifest, { mode: 0o600 });
  writeFileSync(layout.hooks, hooks, { mode: 0o600 });
  const state: ConnectionState = {
    format: 1,
    node: { path: nodePath, version: process.versions.node },
    collectorSha256: sha256(collector),
    manifestSha256: sha256(manifest),
    hooksSha256: sha256(hooks),
    connectedAt: Date.now(),
  };
  writeFileSync(layout.connection, JSON.stringify(state), { mode: 0o600 });

  const project = join(home, "projects", "demo");
  mkdirSync(project, { recursive: true });
  const now = Date.now();
  const agent = { agent_id: "a25fe1c0d2e3f4a5b", agent_type: "Explore" };
  const records = [
    { time: now - 60_000, event: "SessionStart", project: "~/projects/demo" },
    { time: now - 50_000, event: "UserPromptSubmit" },
    { time: now - 40_000, event: "PreToolUse", tool: "Agent", tool_use_id: "toolu_1", detail: "Kartlägg hook-dokumentationen" },
    { time: now - 39_900, event: "SubagentStart", ...agent },
    { time: now - 5_000, event: "PreToolUse", ...agent, tool: "Read", tool_use_id: "toolu_2", detail: "docs/<img src=x onerror=alert(1)>.md" },
  ];
  writeFileSync(sessionFile(layout.home, SESSION_ID), records.map((r) => `${JSON.stringify({ v: 1, ...r })}\n`).join(""), { mode: 0o600 });
  return { home, project };
}

async function main(): Promise<void> {
  await build({
    entryPoints: [join(root, "test", "integration", "suite.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
    outfile: suite,
    logLevel: "warning",
  });
  // esbuild keeps a helper process alive, which would keep the test run hanging after VS Code exits.
  stop();
  const { home, project } = fixtureHome();
  try {
    await runTests({
      version: VSCODE_VERSION,
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      extensionTestsEnv: { HOME: home },
      launchArgs: [project, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

main()
  .catch((error: unknown) => {
    console.error(`Integrationstesterna föll: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  // VS Code leaves handles behind, so the script says when it is done instead of waiting for them.
  .finally(() => process.exit(process.exitCode ?? 0));
