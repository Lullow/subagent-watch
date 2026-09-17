import { join } from "node:path";
import { HOOK_EVENTS } from "../collector/record.ts";

export interface Layout {
  /** ~/.subagent-watch */
  home: string;
  bin: string;
  sessions: string;
  collector: string;
  connection: string;
  /** ~/.claude/skills/subagent-watch, a real directory (Q9, Q21) */
  plugin: string;
  manifestDir: string;
  manifest: string;
  hooksDir: string;
  hooks: string;
}

export function layoutFor(userHome: string): Layout {
  const home = join(userHome, ".subagent-watch");
  const plugin = join(userHome, ".claude", "skills", "subagent-watch");
  return {
    home,
    bin: join(home, "bin"),
    sessions: join(home, "sessions"),
    collector: join(home, "bin", "collector.cjs"),
    connection: join(home, "connection.json"),
    plugin,
    manifestDir: join(plugin, ".claude-plugin"),
    manifest: join(plugin, ".claude-plugin", "plugin.json"),
    hooksDir: join(plugin, "hooks"),
    hooks: join(plugin, "hooks", "hooks.json"),
  };
}

export const ENV_PATH = "/usr/bin/env";
export const HOOK_TIMEOUT_SECONDS = 3;

const COMMAND_PATH = /^\/[A-Za-z0-9_./-]*$/;

/** S7: only plain absolute paths may appear in the hook command. */
export function assertCommandPath(path: string): void {
  if (!COMMAND_PATH.test(path) || path.split("/").includes("..")) {
    throw new Error(`Sökvägen ${JSON.stringify(path)} har tecken som inte är tillåtna i hookens kommando.`);
  }
}

/**
 * The arguments to /usr/bin/env in exec form (Q23). The collector runs with an empty
 * environment, so NODE_OPTIONS cannot widen the permissions, and with Node's permission
 * model as defense in depth: read access to its own file, read and write access to sessions/.
 */
export function collectorArgs(nodePath: string, layout: Layout): string[] {
  for (const path of [nodePath, layout.home, layout.collector, layout.sessions]) assertCommandPath(path);
  return [
    "-i",
    nodePath,
    "--permission",
    `--allow-fs-read=${layout.collector}`,
    `--allow-fs-read=${layout.sessions}/`,
    `--allow-fs-write=${layout.sessions}/`,
    layout.collector,
    `--home=${layout.home}`,
  ];
}

/** Every hook runs sync with a 3 s timeout (Q12), in exec form without a shell. */
export function hooksConfig(nodePath: string, layout: Layout): { hooks: Record<string, { hooks: object[] }[]> } {
  const hook = { type: "command", command: ENV_PATH, args: collectorArgs(nodePath, layout), timeout: HOOK_TIMEOUT_SECONDS };
  return { hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [hook] }]])) };
}

export const NODE_REQUIREMENT = "Node 24.13.0 eller senare (25.3.0 eller senare i 25-serien)";

/**
 * Only Node with the fix for CVE-2025-55130 refuses to create symlinks under the permission
 * model. The collector is only tested on Node 24, so older release lines are refused (S7).
 */
export function nodeVersionSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 24) return minor >= 13;
  if (major === 25) return minor >= 3;
  return major > 25;
}
