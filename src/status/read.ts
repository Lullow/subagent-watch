import { statSync } from "node:fs";
import { parseConnectionState, type Layout } from "../connect/plan.ts";
import { currentUid, readFileChecked, sha256, UnsafePathError, type FilePolicy } from "../secure/fs.ts";
import type { FileHash, InstallFacts } from "./health.ts";

const PRIVATE_POLICY: FilePolicy = { private: true, maxBytes: 4 * 1024 * 1024 };
const CONNECTION_POLICY: FilePolicy = { private: true, maxBytes: 64 * 1024 };

function hashOf(path: string, uid: number): FileHash {
  try {
    const file = readFileChecked(path, PRIVATE_POLICY, uid);
    return file === null ? { state: "missing" } : { state: "present", sha256: sha256(file.bytes) };
  } catch (error) {
    if (error instanceof UnsafePathError || (error as NodeJS.ErrnoException).code === "ENOTDIR") return { state: "unsafe" };
    throw error;
  }
}

/** Reads the connection and the installed files the same way the connect script checks them. */
export function readInstall(layout: Layout, uid = currentUid()): InstallFacts {
  let connection: InstallFacts["connection"];
  try {
    const file = readFileChecked(layout.connection, CONNECTION_POLICY, uid);
    connection = file === null ? { state: "missing" } : { state: "present", value: parseConnectionState(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") connection = { state: "missing" };
    else connection = { state: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  let nodeExists = false;
  if (connection.state === "present") {
    try {
      nodeExists = statSync(connection.value.node.path).isFile();
    } catch {
      nodeExists = false;
    }
  }
  return { connection, hooks: hashOf(layout.hooks, uid), collector: hashOf(layout.collector, uid), nodeExists };
}
