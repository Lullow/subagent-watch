import { join } from "node:path";
import { HOOK_EVENTS } from "../collector/record.ts";
import { sha256 } from "../secure/fs.ts";

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

export const PLUGIN_NAME = "subagent-watch";
export const PLUGIN_ID = `${PLUGIN_NAME}@skills-dir`;

/** .claude-plugin/plugin.json. Hooks are found in hooks/hooks.json without a manifest entry. */
export function manifestJson(): string {
  const manifest = {
    name: PLUGIN_NAME,
    description: "Samlar in hooks för subagent-watch i VS Code. Sparar bara tider, verktygsnamn och korta detaljer, aldrig prompter eller kommandon.",
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export const hooksJson = (nodePath: string, layout: Layout): string => `${JSON.stringify(hooksConfig(nodePath, layout), null, 2)}\n`;

export interface PlannedFile {
  path: string;
  mode: number;
  sha256: string;
}

export interface ConnectPlan {
  tool: "subagent-watch-connect";
  format: 1;
  action: "connect";
  uid: number;
  env: string;
  node: { path: string; version: string; sha256: string };
  /** Created in this order, or checked to be private when they already exist. */
  directories: { path: string; mode: number; mustBeNew: boolean }[];
  collector: PlannedFile & { replacesSha256: string | null };
  connection: { path: string; mode: number };
  manifest: PlannedFile;
  /** Written last: the plugin has no hooks until this file exists. */
  hooks: PlannedFile;
  warnings: string[];
}

export interface DisconnectPlan {
  tool: "subagent-watch-connect";
  format: 1;
  action: "disconnect";
  uid: number;
  connection: { path: string; sha256: string };
  /** Removed in this order: hooks.json first, so the plugin stops before anything else goes. */
  remove: { path: string; sha256: string }[];
  /** Left in place because the checksum no longer matches or the file is unsafe to read. */
  keep: { path: string; reason: string }[];
  /** Removed only if empty after the files. */
  directories: string[];
  /** connection.json stays while any changed file is left, so disconnect can run again. */
  removeConnection: boolean;
}

/** JSON with object keys sorted at every level, so equal plans hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Binds an approval to every path, mode, hash and warning in the plan. */
export const planHash = (plan: ConnectPlan | DisconnectPlan): string => sha256(canonicalJson(plan));

/**
 * Saved in ~/.subagent-watch/connection.json. Holds no paths except Node's: disconnect and
 * the status row derive the others from the home directory (Q36).
 */
export interface ConnectionState {
  format: 1;
  node: { path: string; version: string };
  collectorSha256: string;
  manifestSha256: string;
  hooksSha256: string;
  connectedAt: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const STATE_KEYS = new Set(["format", "node", "collectorSha256", "manifestSha256", "hooksSha256", "connectedAt"]);

function invalid(field: string): never {
  throw new Error(`connection.json har ett ogiltigt fält: ${field}.`);
}

export function parseConnectionState(text: string): ConnectionState {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("connection.json är inte giltig JSON.");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) invalid("(rot)");
  const o = data as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!STATE_KEYS.has(key)) invalid(key);
  if (o.format !== 1) invalid("format");
  const node = o.node as Record<string, unknown> | null;
  if (typeof node !== "object" || node === null || Object.keys(node).sort().join() !== "path,version") invalid("node");
  if (typeof node.path !== "string" || !COMMAND_PATH.test(node.path)) invalid("node.path");
  if (typeof node.version !== "string" || !/^\d+\.\d+\.\d+$/.test(node.version)) invalid("node.version");
  for (const key of ["collectorSha256", "manifestSha256", "hooksSha256"] as const) {
    if (typeof o[key] !== "string" || !HEX64.test(o[key])) invalid(key);
  }
  if (typeof o.connectedAt !== "number" || !Number.isFinite(o.connectedAt)) invalid("connectedAt");
  return {
    format: 1,
    node: { path: node.path, version: node.version },
    collectorSha256: o.collectorSha256 as string,
    manifestSha256: o.manifestSha256 as string,
    hooksSha256: o.hooksSha256 as string,
    connectedAt: o.connectedAt,
  };
}

export type InstalledFile =
  | { path: string; expected: string; state: "present"; sha256: string }
  | { path: string; expected: string; state: "missing" }
  | { path: string; expected: string; state: "unsafe"; reason: string };

/** Q22: only files whose checksum still matches are removed. */
export function planRemovals(files: readonly InstalledFile[]): Pick<DisconnectPlan, "remove" | "keep" | "removeConnection"> {
  const remove: DisconnectPlan["remove"] = [];
  const keep: DisconnectPlan["keep"] = [];
  for (const file of files) {
    if (file.state === "missing") continue;
    if (file.state === "unsafe") keep.push({ path: file.path, reason: file.reason });
    else if (file.sha256 === file.expected) remove.push({ path: file.path, sha256: file.sha256 });
    else keep.push({ path: file.path, reason: `har ändrats sedan anslutningen (sha256 ${file.sha256})` });
  }
  return { remove, keep, removeConnection: keep.length === 0 };
}
