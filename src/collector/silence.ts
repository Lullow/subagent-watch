// Imported first by main.ts (S5). A hook's stdout can block a tool or add text to Claude's
// context, so nothing may reach stdout or stderr, whatever happens later in the process.
const discard = (() => true) as typeof process.stdout.write;
process.stdout.write = discard;
process.stderr.write = discard;
process.on("uncaughtException", () => {
  process.exitCode = 0;
});
process.on("unhandledRejection", () => {
  process.exitCode = 0;
});
