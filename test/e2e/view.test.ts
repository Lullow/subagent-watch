import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dist = (file: string): string => readFileSync(fileURLToPath(new URL(`../../dist/${file}`, import.meta.url)), "utf8");

test("vyns bundle har inga externa resurser, ingen HTML från strängar och ingen dynamisk kod (S8, S9)", () => {
  const script = dist("view.js");
  const forbidden = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\b/, /\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /\bimport\(/, /setAttribute\("style"/];
  for (const pattern of forbidden) assert.doesNotMatch(script, pattern);
  const urls = new Set([...script.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((match) => match[0]));
  assert.deepEqual([...urls], ["http://www.w3.org/2000/svg"]);
});

test("vyns stil laddar inget utifrån och tar alla färger från temat (acceptanskriterium 11)", () => {
  const css = dist("view.css");
  assert.doesNotMatch(css, /url\(|@import|https?:/);
  // Masks use black only as opacity, never as a color on screen.
  const colors = css.replace(/(-webkit-)?mask-image:[^;]*;/g, "").match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g);
  assert.equal(colors, null, `färger utanför temat: ${colors?.join(", ")}`);
  assert.match(css, /vscode-reduce-motion/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /vscode-high-contrast/);
});

test("extensionens bundle använder inget nätverk, inga processer och ingen dynamisk kod (S6)", () => {
  const code = dist("extension.js");
  const modules = [...new Set([...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(modules, ["node:crypto", "node:fs", "node:os", "node:path", "vscode"]);
  for (const forbidden of [/\beval\(/, /new Function\b/, /\bimport\(/, /child_process/, /node:(net|http|https|http2|dns|tls|dgram)/, /\bfetch\(/, /WebSocket/]) {
    assert.doesNotMatch(code, forbidden);
  }
});
