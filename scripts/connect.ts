// Development tool until the extension can connect by itself (Q22).
//   npm run connect                                  show the connect plan and its hash
//   npm run connect -- --apply=<hash>                carry out exactly that plan
//   npm run connect -- --disconnect                  show the disconnect plan and its hash
//   npm run connect -- --disconnect --apply=<hash>
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  collectorArgs,
  ENV_PATH,
  hooksJson,
  layoutFor,
  manifestJson,
  NODE_REQUIREMENT,
  nodeVersionSupported,
  parseConnectionState,
  planHash,
  planRemovals,
  PLUGIN_ID,
  type ConnectionState,
  type ConnectPlan,
  type DisconnectPlan,
  type InstalledFile,
} from "../src/connect/plan.ts";
import {
  assertPrivateDir,
  assertTrustedAncestors,
  currentUid,
  ensurePrivateDir,
  readFileChecked,
  readRegularFile,
  removeFileChecked,
  replaceFileAtomic,
  sha256,
  UnsafePathError,
  writeNewPrivateFile,
  type FilePolicy,
} from "../src/secure/fs.ts";

const KIB = 1024;
const MIB = 1024 * KIB;
const PRIVATE_POLICY: FilePolicy = { private: true, maxBytes: 4 * MIB };
const CONNECTION_POLICY: FilePolicy = { private: true, maxBytes: 64 * KIB };
const MISMATCH =
  "Planen stämmer inte med hashen du godkände, så ingenting har ändrats. Något har ändrats sedan granskningen. Kör kommandot utan --apply för att se den aktuella planen.";
const RELOAD = "Sessioner som redan körs behåller sina hooks tills de startas om eller du kör /reload-plugins.";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const uid = currentUid();
const userHome = homedir();
const layout = layoutFor(userHome);
const claudeDir = join(userHome, ".claude");
const skillsDir = join(claudeDir, "skills");
const settingsPath = join(claudeDir, "settings.json");
const collectorSource = resolve(import.meta.dirname, "..", "dist", "collector.js");

class Abort extends Error {}

function fail(message: string): never {
  throw new Abort(message);
}

const octal = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, "0");

function section(title: string, lines: string[]): void {
  console.log(`\n${title}`);
  for (const line of lines) console.log(`  ${line}`);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function decode(bytes: Uint8Array, path: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return fail(`${path} är inte giltig UTF-8.`);
  }
}

/** Checks the ancestors of ~/.subagent-watch and every subagent-watch directory that exists. */
function verifyStoreTree(): void {
  assertTrustedAncestors(layout.home, uid);
  for (const dir of [layout.home, layout.bin, layout.sessions]) if (exists(dir)) assertPrivateDir(dir, uid);
}

function verifyEnvBinary(): void {
  if (!exists(ENV_PATH)) fail(`${ENV_PATH} saknas.`);
  const st = lstatSync(ENV_PATH);
  if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0) {
    fail(`${ENV_PATH} måste vara en vanlig fil som ägs av root och inte kan skrivas av andra.`);
  }
  assertTrustedAncestors(ENV_PATH, uid);
}

/** Settings that would keep the hooks from running. Read only to warn, never trusted or changed. */
function settingsWarnings(): string[] {
  let settings: unknown;
  try {
    const bytes = readRegularFile(settingsPath, MIB);
    if (bytes === null) return [];
    settings = JSON.parse(decode(bytes, settingsPath));
  } catch {
    return [`${settingsPath} gick inte att läsa som JSON, så inställningarna för hooks kunde inte kontrolleras.`];
  }
  if (typeof settings !== "object" || settings === null) return [];
  const s = settings as { disableAllHooks?: unknown; enabledPlugins?: Record<string, unknown> };
  const warnings: string[] = [];
  if (s.disableAllHooks === true) warnings.push("disableAllHooks är på i settings.json, så inga hooks körs, inte heller subagent-watch.");
  if (typeof s.enabledPlugins === "object" && s.enabledPlugins !== null && s.enabledPlugins[PLUGIN_ID] === false) {
    warnings.push(`${PLUGIN_ID} är avstängt i enabledPlugins i settings.json.`);
  }
  return warnings;
}

// ---------- Connect ----------

interface ConnectWork {
  plan: ConnectPlan;
  collectorBytes: Buffer;
  manifestBytes: Buffer;
  hooksBytes: Buffer;
  nodeUserWritable: boolean;
}

function gatherConnect(): ConnectWork {
  if (!exists(claudeDir)) fail(`${claudeDir} saknas. Starta Claude Code en gång först.`);
  verifyStoreTree();
  if (exists(layout.connection)) {
    fail(`subagent-watch är redan ansluten enligt ${layout.connection}. Koppla från först med --disconnect.`);
  }

  const skillsExists = exists(skillsDir);
  assertTrustedAncestors(skillsExists ? layout.plugin : skillsDir, uid);
  if (skillsExists) {
    const st = lstatSync(skillsDir);
    if (!st.isDirectory()) fail(`${skillsDir} är inte en mapp.`);
  }
  if (exists(layout.plugin)) {
    fail(
      lstatSync(layout.plugin).isSymbolicLink()
        ? `${layout.plugin} är en symbolisk länk. Pluginet måste vara en riktig mapp, så ingenting har ändrats.`
        : `${layout.plugin} finns redan men har inte anslutits av det här skriptet. Kontrollera mappen och ta bort den för hand om den är en gammal installation.`,
    );
  }
  verifyEnvBinary();

  // The hooks run this very Node binary, so its version is the one that matters.
  const nodeVersion = process.versions.node;
  if (!nodeVersionSupported(nodeVersion)) {
    fail(`Node ${nodeVersion} stöds inte. Insamlaren kräver ${NODE_REQUIREMENT}, där behörighetsmodellen nekar att skapa symboliska länkar (CVE-2025-55130).`);
  }
  const nodePath = realpathSync(process.execPath);
  const nodeStat = lstatSync(nodePath);
  let collectorBytes: Buffer;
  try {
    collectorBytes = readFileSync(collectorSource);
  } catch {
    return fail("dist/collector.js saknas. Kör npm run build först.");
  }
  let hooksBytes: Buffer;
  try {
    collectorArgs(nodePath, layout);
    hooksBytes = Buffer.from(hooksJson(nodePath, layout));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const manifestBytes = Buffer.from(manifestJson());
  const existingCollector = readFileChecked(layout.collector, PRIVATE_POLICY, uid);

  const plan: ConnectPlan = {
    tool: "subagent-watch-connect",
    format: 1,
    action: "connect",
    uid,
    env: ENV_PATH,
    node: { path: nodePath, version: nodeVersion, sha256: sha256(readFileSync(nodePath)) },
    directories: [
      { path: layout.home, mode: 0o700, mustBeNew: false },
      { path: layout.bin, mode: 0o700, mustBeNew: false },
      { path: layout.sessions, mode: 0o700, mustBeNew: false },
      ...(skillsExists ? [] : [{ path: skillsDir, mode: 0o700, mustBeNew: true }]),
      { path: layout.plugin, mode: 0o700, mustBeNew: true },
      { path: layout.manifestDir, mode: 0o700, mustBeNew: true },
      { path: layout.hooksDir, mode: 0o700, mustBeNew: true },
    ],
    collector: {
      path: layout.collector,
      mode: 0o600,
      sha256: sha256(collectorBytes),
      replacesSha256: existingCollector === null ? null : sha256(existingCollector.bytes),
    },
    connection: { path: layout.connection, mode: 0o600 },
    manifest: { path: layout.manifest, mode: 0o600, sha256: sha256(manifestBytes) },
    hooks: { path: layout.hooks, mode: 0o600, sha256: sha256(hooksBytes) },
    warnings: settingsWarnings(),
  };
  return { plan, collectorBytes, manifestBytes, hooksBytes, nodeUserWritable: nodeStat.uid !== 0 || (nodeStat.mode & 0o022) !== 0 };
}

function printConnect(work: ConnectWork, hash: string): void {
  const { plan } = work;
  console.log("Plan: anslut subagent-watch till Claude Code");
  section("Kontrollerat", [
    `Mappkedjorna till ${layout.home} och ${layout.plugin}: inga symboliska länkar, rätt ägare, ingen annan kan skriva.`,
    `${layout.plugin} finns inte än.`,
    `${ENV_PATH} ägs av root.`,
    `${settingsPath} ändras inte.`,
  ]);
  section(
    "Mappar (0700)",
    plan.directories.map((d) => `${d.path}${d.mustBeNew ? " (ny)" : " (skapas eller kontrolleras)"}`),
  );
  section("Insamlare", [
    `${plan.collector.path} (${octal(plan.collector.mode)})`,
    `sha256 ${plan.collector.sha256}`,
    plan.collector.replacesSha256 === null ? "ny fil" : `ersätter fil med sha256 ${plan.collector.replacesSha256}`,
  ]);
  section("Node", [
    plan.node.path,
    `version ${plan.node.version}`,
    `sha256 ${plan.node.sha256}`,
    ...(work.nodeUserWritable ? ["Obs: filen kan ändras av din användare, till exempel av nvm."] : []),
  ]);
  section(`Anslutningsuppgifter`, [`${plan.connection.path} (${octal(plan.connection.mode)})`]);
  section(`Plugin: ${plan.manifest.path} (${octal(plan.manifest.mode)}, sha256 ${plan.manifest.sha256})`, work.manifestBytes.toString("utf8").trimEnd().split("\n"));
  const hooks = JSON.parse(work.hooksBytes.toString("utf8")) as { hooks: Record<string, { hooks: { command: string; args: string[]; timeout: number }[] }[]> };
  const hook = Object.values(hooks.hooks)[0]![0]!.hooks[0]!;
  section(`Hooks: ${plan.hooks.path} (${octal(plan.hooks.mode)}, sha256 ${plan.hooks.sha256})`, [
    `Händelser: ${Object.keys(hooks.hooks).join(", ")}`,
    `Samma kommando för alla, sync med timeout ${hook.timeout} s, i exec-form utan skal:`,
    `  ${hook.command}`,
    ...hook.args.map((arg) => `    ${arg}`),
  ]);
  if (plan.warnings.length > 0) section("Varningar", plan.warnings);
  console.log(`\nPlanens hash: ${hash}`);
  console.log(`\nInget har ändrats. Godkänn exakt den här planen med:\n  npm run connect -- --apply=${hash}`);
}

function applyConnect(work: ConnectWork): void {
  const { plan } = work;
  const done: string[] = [];
  const writeChecked = (path: string, bytes: Buffer, expected: string) => {
    writeNewPrivateFile(path, bytes, uid);
    const written = readFileChecked(path, PRIVATE_POLICY, uid);
    if (written === null || sha256(written.bytes) !== expected) throw new Error(`${path} innehåller inte det som skrevs.`);
    done.push(`skrev ${path}`);
  };
  try {
    for (const dir of plan.directories) {
      if (dir.mustBeNew) {
        mkdirSync(dir.path, { mode: dir.mode });
        assertPrivateDir(dir.path, uid);
        done.push(`skapade ${dir.path}`);
      } else {
        ensurePrivateDir(dir.path, uid);
      }
    }
    replaceFileAtomic(
      plan.collector.path,
      work.collectorBytes,
      { mode: plan.collector.mode, exactMode: true, durable: true, expectedSha256: plan.collector.replacesSha256, currentPolicy: PRIVATE_POLICY },
      uid,
    );
    done.push(`installerade ${plan.collector.path}`);

    // Written before the plugin files, so a failed write can still be cleaned up with --disconnect.
    const state: ConnectionState = {
      format: 1,
      node: { path: plan.node.path, version: plan.node.version },
      collectorSha256: plan.collector.sha256,
      manifestSha256: plan.manifest.sha256,
      hooksSha256: plan.hooks.sha256,
      connectedAt: Date.now(),
    };
    writeNewPrivateFile(plan.connection.path, Buffer.from(`${JSON.stringify(state, null, 2)}\n`), uid);
    done.push(`sparade ${plan.connection.path}`);

    writeChecked(plan.manifest.path, work.manifestBytes, plan.manifest.sha256);
    writeChecked(plan.hooks.path, work.hooksBytes, plan.hooks.sha256);
  } catch (error) {
    if (done.length > 0) console.error(`Hann utföra:\n${done.map((d) => `  ${d}`).join("\n")}\nKör --disconnect för att städa upp.`);
    throw error;
  }
  console.log(`Planens hash stämmer. Ansluten:\n${done.map((d) => `  ${d}`).join("\n")}`);
  console.log(`\nPluginet ${PLUGIN_ID} laddas i nya sessioner av Claude Code. ${RELOAD}`);
}

// ---------- Disconnect ----------

function inspect(path: string, expected: string): InstalledFile {
  try {
    const file = readFileChecked(path, PRIVATE_POLICY, uid);
    return file === null ? { path, expected, state: "missing" } : { path, expected, state: "present", sha256: sha256(file.bytes) };
  } catch (error) {
    if (error instanceof UnsafePathError) return { path, expected, state: "unsafe", reason: error.message };
    throw error;
  }
}

function gatherDisconnect(): DisconnectPlan {
  verifyStoreTree();
  const connection = readFileChecked(layout.connection, CONNECTION_POLICY, uid);
  if (connection === null) fail("Ingen connection.json hittades, så det finns inget att koppla från.");
  const state = parseConnectionState(decode(connection.bytes, layout.connection));

  if (exists(layout.plugin)) {
    assertTrustedAncestors(layout.plugin, uid);
    for (const dir of [layout.plugin, layout.manifestDir, layout.hooksDir]) if (exists(dir)) assertPrivateDir(dir, uid);
  }
  const files = [inspect(layout.hooks, state.hooksSha256), inspect(layout.manifest, state.manifestSha256), inspect(layout.collector, state.collectorSha256)];
  return {
    tool: "subagent-watch-connect",
    format: 1,
    action: "disconnect",
    uid,
    connection: { path: layout.connection, sha256: sha256(connection.bytes) },
    ...planRemovals(files),
    directories: [layout.hooksDir, layout.manifestDir, layout.plugin, layout.bin],
  };
}

function printDisconnect(plan: DisconnectPlan, hash: string): void {
  console.log("Plan: koppla från subagent-watch");
  section("Tas bort, eftersom kontrollsumman stämmer", plan.remove.length === 0 ? ["(inga filer)"] : plan.remove.map((f) => `${f.path} (sha256 ${f.sha256})`));
  if (plan.keep.length > 0) {
    section("Lämnas kvar", [...plan.keep.map((f) => `${f.path}: ${f.reason}`), "Kontrollera filerna och ta bort dem för hand. Kör sedan --disconnect igen."]);
  }
  section("Mappar som tas bort om de är tomma", plan.directories);
  section("Anslutningsuppgifter", [plan.removeConnection ? `${plan.connection.path} tas bort` : `${plan.connection.path} lämnas kvar tills alla filer är borta`]);
  section("Rörs inte", [`insamlad data i ${layout.sessions}`, settingsPath]);
  console.log(`\nPlanens hash: ${hash}`);
  console.log(`\nInget har ändrats. Godkänn exakt den här planen med:\n  npm run connect -- --disconnect --apply=${hash}`);
}

function applyDisconnect(plan: DisconnectPlan): void {
  for (const file of plan.remove) removeFileChecked(file.path, file.sha256, PRIVATE_POLICY, uid);
  for (const dir of plan.directories) {
    try {
      if (lstatSync(dir).isDirectory()) rmdirSync(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  }
  if (plan.removeConnection) removeFileChecked(plan.connection.path, plan.connection.sha256, CONNECTION_POLICY, uid);
  console.log(`Planens hash stämmer. ${plan.removeConnection ? "Frånkopplad." : "Delvis frånkopplad: ändrade filer lämnades kvar."}`);
  console.log(RELOAD.replace("behåller sina hooks", "försöker köra hooks och visar fel"));
}

// ---------- Main ----------

function parseArgs(args: string[]): { disconnect: boolean; approved: string | null } {
  let disconnect = false;
  let approved: string | null = null;
  for (const arg of args) {
    if (arg === "--disconnect") {
      disconnect = true;
    } else if (arg.startsWith("--apply")) {
      const match = /^--apply=([0-9a-f]{64})$/.exec(arg);
      if (match === null) fail("--apply kräver planens fullständiga hash: --apply=<64 hexadecimala tecken>.");
      approved = match[1] ?? null;
    } else {
      fail(`Okänt argument: ${arg}`);
    }
  }
  return { disconnect, approved };
}

function main(): void {
  const { disconnect, approved } = parseArgs(process.argv.slice(2));
  if (disconnect) {
    const plan = gatherDisconnect();
    const hash = planHash(plan);
    if (approved === null) return printDisconnect(plan, hash);
    if (hash !== approved) fail(MISMATCH);
    return applyDisconnect(plan);
  }
  const work = gatherConnect();
  const hash = planHash(work.plan);
  if (approved === null) return printConnect(work, hash);
  if (hash !== approved) fail(MISMATCH);
  applyConnect(work);
}

try {
  main();
} catch (error) {
  console.error(`Avbrutet: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
