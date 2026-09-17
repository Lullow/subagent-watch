import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanText, displayPath, hostOf, mask, MASKED } from "../../src/collector/text.ts";

const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

test("tar bort styrtecken och tecken som vänder textriktningen men behåller U+200D", () => {
  const [rlo, lrm, rlm, alm, nel, bel, lri, c1] = [0x202e, 0x200e, 0x200f, 0x061c, 0x0085, 0x0007, 0x2066, 0x009f].map((c) => ch(c));
  assert.equal(cleanText(`a${rlo}b${lrm}c${rlm}d${alm}e${nel}f${bel}g${lri}h${c1}i`, 120), "abcdefghi");
  const coder = ch(0x1f469, 0x200d, 0x1f4bb);
  assert.equal(cleanText(`${coder} klar`, 120), `${coder} klar`);
  assert.equal(cleanText(`  ${rlo}  `, 120), undefined);
});

test("maskerar kända nycklar och värden efter nyckelord", () => {
  assert.equal(mask("Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"), `Bearer ${MASKED}`);
  assert.equal(mask("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), MASKED);
  assert.equal(mask("nyckel AKIAABCDEFGHIJKLMNOP här"), `nyckel ${MASKED} här`);
  assert.equal(mask("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), MASKED);
  assert.equal(mask("password=hunter2 och token: abc"), `password=${MASKED} och token: ${MASKED}`);
  assert.equal(mask("-----BEGIN OPENSSH PRIVATE KEY-----"), MASKED);
});

test("maskerar långa strängar som blandar bokstäver och siffror men inte vanliga sökvägar", () => {
  assert.equal(mask("cache/3f9a2c1e7b4d4e0a9c551d2e8f6a7b90abcd/x"), `cache/${MASKED}/x`);
  assert.equal(mask("docs/insamlarens-sakerhetskontrakt.md"), "docs/insamlarens-sakerhetskontrakt.md");
  assert.equal(mask("kontrollsummor-for-alla-filer-i-projektet"), "kontrollsummor-for-alla-filer-i-projektet");
  assert.equal(mask("spike/runs/02-parallel.jsonl"), "spike/runs/02-parallel.jsonl");
});

test("kortar efter maskering, så att en avkortad nyckel inte slinker igenom", () => {
  const long = cleanText("x".repeat(130), 120);
  assert.equal([...(long ?? "")].length, 120);
  assert.ok(long?.endsWith("…"));
  assert.equal(cleanText(`Kör med sk-ant-${"a1".repeat(20)}`, 20), `Kör med ${MASKED}`);
  const smile = ch(0x1f600);
  assert.equal(cleanText(smile.repeat(5), 3), `${smile}${smile}…`);
});

test("sökvägar blir relativa projektet och hemmappen skrivs som ~", () => {
  const home = "/home/lullo";
  const cwd = "/home/lullo/projects/subagent-watch";
  assert.equal(displayPath(`${cwd}/src/a.ts`, cwd, home), "src/a.ts");
  assert.equal(displayPath(cwd, cwd, home), ".");
  assert.equal(displayPath("/home/lullo/projects/tokeniser/src/a.ts", cwd, home), "~/projects/tokeniser/src/a.ts");
  assert.equal(displayPath("/home/lullo/projects/subagent-watch-2/a.ts", cwd, home), "~/projects/subagent-watch-2/a.ts");
  assert.equal(displayPath("/home/lullo2/a.ts", cwd, home), "/home/lullo2/a.ts");
  assert.equal(displayPath("/etc/hosts", cwd, home), "/etc/hosts");
  assert.equal(displayPath("docs/**/*.md", cwd, home), "docs/**/*.md");
  assert.equal(displayPath(cwd, undefined, home), "~/projects/subagent-watch");
});

test("bara värdnamnet från http och https", () => {
  assert.equal(hostOf("https://code.claude.com/docs/en/hooks?token=abc#x"), "code.claude.com");
  assert.equal(hostOf("http://user:pass@example.se:8080/x"), "example.se");
  assert.equal(hostOf("file:///etc/passwd"), undefined);
  assert.equal(hostOf("inte en adress"), undefined);
});
