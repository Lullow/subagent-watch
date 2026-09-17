import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const context = await esbuild.context({
  bundle: true,
  sourcemap: false,
  minify: production,
  logLevel: "info",
  outdir: "dist",
  entryPoints: { collector: "src/collector/main.ts" },
  format: "cjs",
  platform: "node",
  target: "node24",
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
