import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sessionFile } from "../../src/collector/store.ts";
import { collectorArgs, ENV_PATH, hooksConfig, layoutFor, manifestJson, parseConnectionState } from "../../src/connect/plan.ts";
import { sha256 } from "../../src/secure/fs.ts";

const script = fileURLToPath(new URL("../../scripts/connect.ts", import.meta.url));
const bundle = fileURLToPath(new URL("../../dist/collector.js", import.meta.url));
const SETTINGS = `{\n  "model": "opus",\n  "enabledPlugins": {\n    "tokeniser@local": true\n  }\n}\n`;
const SESSION = "3f9a2c1e-7b4d-4e0a-9c55-1d2e8f6a7b90";
const fixtureLines = (): string[] =>
  readFileSync(new URL("../fixtures/hooks/session.jsonl", import.meta.url), "utf8").trim().split("\n");

type HookFile = { hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]> };

const settingsOf = (home: string): string => join(home, ".claude", "settings.json");
const mode = (path: string): number => statSync(path).mode & 0o7777;

function setup(settings = SETTINGS): string {
  const home = mkdtempSync(join(tmpdir(), "subagent-watch-connect-"));
  mkdirSync(join(home, ".claude", "skills", "annan-skill"), { recursive: true, mode: 0o755 });
  writeFileSync(settingsOf(home), settings);
  chmodSync(settingsOf(home), 0o644);
  return home;
}

function connect(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 60_000,
  });
}

function hashFrom(output: string): string {
  const match = /Planens hash: ([0-9a-f]{64})/.exec(output);
  assert.ok(match, output);
  return match[1]!;
}

function approve(home: string, ...args: string[]) {
  const dry = connect(home, ...args);
  assert.equal(dry.status, 0, dry.stderr);
  const applied = connect(home, ...args, `--apply=${hashFrom(dry.stdout)}`);
  assert.equal(applied.status, 0, applied.stderr);
  return { dry: dry.stdout, applied: applied.stdout };
}

test("anslut och koppla från: rätt rättigheter, fungerande hooks och settings.json byte för byte oförändrad", () => {
  const home = setup();
  const layout = layoutFor(home);
  const dry = connect(home);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!existsSync(layout.home), "torrkörningen får inte skapa något");
  assert.ok(!existsSync(layout.plugin), "torrkörningen får inte skapa något");

  const applied = connect(home, `--apply=${hashFrom(dry.stdout)}`);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /subagent-watch@skills-dir laddas i nya sessioner/);
  assert.match(applied.stdout, /\/reload-plugins/);

  for (const dir of [layout.home, layout.bin, layout.sessions, layout.plugin, layout.manifestDir, layout.hooksDir]) assert.equal(mode(dir), 0o700, dir);
  for (const file of [layout.collector, layout.connection, layout.manifest, layout.hooks]) assert.equal(mode(file), 0o600, file);
  assert.ok(lstatSync(layout.plugin).isDirectory());
  assert.deepEqual(readdirSync(layout.plugin).sort(), [".claude-plugin", "hooks"]);
  assert.equal(readFileSync(layout.manifest, "utf8"), manifestJson());
  assert.deepEqual(readFileSync(layout.collector), readFileSync(bundle));

  const nodePath = realpathSync(process.execPath);
  const hooksText = readFileSync(layout.hooks, "utf8");
  assert.deepEqual(JSON.parse(hooksText), hooksConfig(nodePath, layout));
  const hook = (JSON.parse(hooksText) as HookFile).hooks.PreToolUse![0]!.hooks[0]!;
  const state = parseConnectionState(readFileSync(layout.connection, "utf8"));
  assert.equal(state.hooksSha256, sha256(readFileSync(layout.hooks)));
  assert.equal(state.collectorSha256, sha256(readFileSync(layout.collector)));
  assert.equal(state.node.path, nodePath);

  assert.equal(hook.command, ENV_PATH);
  assert.deepEqual(hook.args, collectorArgs(nodePath, layout));
  for (const line of fixtureLines()) {
    const run: SpawnSyncReturns<string> = spawnSync(hook.command, hook.args, { input: line, encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, "");
  }
  assert.equal(readFileSync(sessionFile(layout.home, SESSION), "utf8").trim().split("\n").length, fixtureLines().length);

  const off = approve(home, "--disconnect");
  assert.match(off.dry, /Tas bort, eftersom kontrollsumman stämmer/);
  assert.match(off.applied, /Frånkopplad\./);
  assert.ok(!existsSync(layout.plugin));
  assert.ok(!existsSync(layout.bin));
  assert.ok(!existsSync(layout.connection));
  assert.ok(existsSync(sessionFile(layout.home, SESSION)), "insamlad data lämnas kvar");
  assert.deepEqual(readdirSync(join(home, ".claude", "skills")), ["annan-skill"]);
  assert.equal(readFileSync(settingsOf(home), "utf8"), SETTINGS);
  assert.equal(mode(settingsOf(home)), 0o644);
});

test("planen måste godkännas med exakt hash", () => {
  const home = setup();
  const layout = layoutFor(home);
  const wrong = connect(home, `--apply=${"0".repeat(64)}`);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /stämmer inte med hashen/);
  const short = connect(home, "--apply=abc");
  assert.equal(short.status, 1);
  assert.match(short.stderr, /fullständiga hash/);
  assert.ok(!existsSync(layout.home));
  assert.ok(!existsSync(layout.plugin));
});

test("anslutningen avbryts när pluginmappen redan finns eller är en symlänk", () => {
  const existing = setup();
  mkdirSync(layoutFor(existing).plugin, { mode: 0o700 });
  const result = connect(existing);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /finns redan men har inte anslutits/);
  assert.ok(!existsSync(layoutFor(existing).home));

  const linked = setup();
  const elsewhere = mkdtempSync(join(tmpdir(), "subagent-watch-elsewhere-"));
  symlinkSync(elsewhere, layoutFor(linked).plugin);
  const linkedResult = connect(linked);
  assert.equal(linkedResult.status, 1);
  assert.match(linkedResult.stderr, /symbolisk länk/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("anslutningen avbryts när subagent-watch redan är ansluten", () => {
  const home = setup();
  approve(home);
  const again = connect(home);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /redan ansluten/);
});

test("bortkoppling tar bara bort filer vars kontrollsumma stämmer", () => {
  const home = setup();
  const layout = layoutFor(home);
  approve(home);
  writeFileSync(layout.hooks, '{ "hooks": {} }\n');

  const off = approve(home, "--disconnect");
  assert.match(off.dry, /Lämnas kvar/);
  assert.match(off.dry, /hooks\.json: har ändrats sedan anslutningen/);
  assert.match(off.applied, /Delvis frånkopplad/);
  assert.equal(readFileSync(layout.hooks, "utf8"), '{ "hooks": {} }\n');
  assert.ok(!existsSync(layout.manifest));
  assert.ok(!existsSync(layout.collector));
  assert.ok(existsSync(layout.connection), "connection.json finns kvar så att bortkopplingen kan köras igen");

  const again = connect(home, "--disconnect");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /hooks\.json: har ändrats/);
});

test("bortkopplingen avbryts utan anslutning och rör inget", () => {
  const home = setup();
  const result = connect(home, "--disconnect");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ingen connection\.json/);
});

test("planen varnar när disableAllHooks är på eller pluginet är avstängt", () => {
  const home = setup(`{\n  "disableAllHooks": true,\n  "enabledPlugins": { "subagent-watch@skills-dir": false }\n}\n`);
  const dry = connect(home);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /disableAllHooks är på/);
  assert.match(dry.stdout, /subagent-watch@skills-dir är avstängt/);
});
