import { isAbsolute, relative, sep } from "node:path";

export const MAX_PATH = 240;
export const MAX_DESCRIPTION = 120;
export const MAX_HOST = 253;
export const MASKED = "[dolt]";

/** C0 and C1 control characters and every bidi control, including U+200E, U+200F and U+061C. U+200D stays. */
const CONTROL = /[\p{Cc}\p{Bidi_Control}]/gu;

/** Known secret formats. The last one keeps the key name and hides the value. */
const SECRETS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const KEY_VALUE = /\b((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|pwd|auth)\s*[:=]\s*)[^\s&"',;]+/gi;
/** Long runs of token characters that mix letters and digits, such as hashes and keys. */
const LONG_TOKEN = /[A-Za-z0-9_+=-]{32,}/g;

export function mask(text: string): string {
  let out = text;
  for (const pattern of SECRETS) out = out.replace(pattern, MASKED);
  out = out.replace(KEY_VALUE, (_match, key: string) => `${key}${MASKED}`);
  return out.replace(LONG_TOKEN, (token) => (/[A-Za-z]/.test(token) && /[0-9]/.test(token) ? MASKED : token));
}

/**
 * Removes control characters, masks secrets and shortens to max characters. Masking comes
 * before shortening, so a secret cut in half cannot slip past the patterns.
 */
export function cleanText(value: string, max: number): string | undefined {
  const text = mask(value.replace(CONTROL, "")).trim();
  if (text === "") return undefined;
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** Relative to the project when inside it, with ~ for the home directory, otherwise as given. */
export function displayPath(path: string, cwd: string | undefined, home: string): string {
  if (cwd !== undefined && isAbsolute(cwd) && isAbsolute(path)) {
    const rel = relative(cwd, path);
    if (rel === "") return ".";
    if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel;
  }
  if (isAbsolute(path) && home !== "/" && (path === home || path.startsWith(`${home}${sep}`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Only the host name of an http or https address. */
export function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
}
