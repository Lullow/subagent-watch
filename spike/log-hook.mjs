// Test: loggar vad hooks skickar, för att se hur subagenter syns.
// Långa strängar kortas, så att prompter och filinnehåll inte sparas i sin helhet.
import { appendFileSync } from "node:fs";

const MAX = 160;

const trim = (value) => {
  if (typeof value === "string") return value.length > MAX ? `${value.slice(0, MAX)}…` : value;
  if (Array.isArray(value)) return value.map(trim);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, trim(inner)]));
  }
  return value;
};

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const at = new Date().toISOString();
  let line;
  try {
    line = { at, ...trim(JSON.parse(raw)) };
  } catch {
    line = { at, parseError: true, raw: trim(raw) };
  }
  appendFileSync(new URL("./events.jsonl", import.meta.url), `${JSON.stringify(line)}\n`);
});
