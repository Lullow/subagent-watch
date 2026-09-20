# subagent-watch

VS Code extension that shows Claude Code's subagents while they work — from documented, local sources only.

**Status:** the build has started. All design decisions live in [docs/subagent-watch-sammanfattning.md](docs/subagent-watch-sammanfattning.md), and the approved mockup in [docs/skiss/subagent-watch-skiss.html](docs/skiss/subagent-watch-skiss.html). The first version is built: the collector, the connection, the interpretation and the view.

## Development

Requires Node 24.13 or later.

```sh
npm install
npm run build      # builds dist/collector.js with esbuild
npm run typecheck
npm test           # unit tests and tests of the built files
npm run test:integration  # launches VS Code 1.137.0 with synthetic data; needs a display (CI uses xvfb)
npm run testdata   # creates test/fixtures/runs/ from spike/runs/, which is never committed (S11)
```

Launch the extension in a development instance with F5 ("Run extension").

CI on GitHub (`.github/workflows/ci.yml`) runs type checking, unit tests, end-to-end tests and the VS Code integration tests, and packages a VSIX whose contents are verified, on every push to `main` and every pull request. The workflow has read-only permission, no secrets, and actions pinned to exact commits.

## The collector

`src/collector/` becomes `~/.subagent-watch/bin/collector.cjs`. Claude Code runs it on every hook, in exec form without a shell:

```
/usr/bin/env -i <node> --permission --allow-fs-read=<collector> --allow-fs-read=<sessions>/ --allow-fs-write=<sessions>/ <collector> --home=~/.subagent-watch
```

- **Stores** only the allow-listed fields in `src/collector/record.ts`, one line per event in `sessions/<session_id>.jsonl` (0600 inside a 0700 directory).
- **Never stores** Bash commands, prompts, `Grep` patterns, search queries, reports, error messages or full paths. All text is stripped of control characters, redacted and truncated in `src/collector/text.ts`.
- **Never writes** to stdout or stderr, and always exits with code 0.
- **Discarded events** are counted in `sessions/problems-YYYY-MM-DD.jsonl` with only a reason and a timestamp.
- **Cleanup:** on `SessionStart`, files whose most recent event is older than 24 hours are removed.

## Install

```sh
npm run package                                   # builds subagent-watch.vsix with only what the extension needs
code --install-extension subagent-watch.vsix      # from a WSL terminal: installs into the VS Code server in WSL
code --uninstall-extension lullo.subagent-watch   # removes it again
```

The view sits in the bottom panel under the subagent-watch tab and can be dragged next to the Terminal or into the side panel. The command "subagent-watch: Open in a tab", or the button in the view header, opens it as its own tab in the editor area, where the timeline gets full width. It has three shapes: wide with the timeline beside the names, narrow below 420 px with only the agent type, and portrait below 320 px where the timeline sits full width under each name. The `⚙ 2` status bar item appears only while agents are running in the window's project. The command "subagent-watch: Delete collected data" removes all session files after a confirmation.

## The interpretation

`src/model/` reads `sessions/` as untrusted data and builds what the view shows:

- `reader.ts` reads only complete new lines, rejects symlinks, hard links, wrong permissions and oversized files, and detects when a file has been replaced.
- `schema.ts` accepts only lines that exactly follow the collector's schema.
- `interpret.ts` builds turns, rows for the main session and the agents, chunks per category (Q26), parents, waiting-on-you, errors, cancelled agents and unknown state. File order governs, and timestamps are made monotonic.
- `window.ts` selects the sessions for the window's project (Q3, Q15, Q16) and summarises other projects.

## Connecting

```sh
npm run connect                                   # shows the plan and its hash, changes nothing
npm run connect -- --apply=<hash>                 # applies exactly that plan
npm run connect -- --disconnect                   # shows the disconnection plan
npm run connect -- --disconnect --apply=<hash>
```

Connecting creates the plugin `~/.claude/skills/subagent-watch/` with `.claude-plugin/plugin.json` and `hooks/hooks.json`, installs the collector, and records the checksums in `~/.subagent-watch/connection.json`. It never writes to `~/.claude/settings.json`. It aborts if the plugin directory already exists or is a symlink, if the directory chain can be modified by someone else, and on Node older than 24.13.0 or 25.0–25.2.

The plugin is named `subagent-watch@skills-dir` and loads in new sessions. In sessions that are already running it takes effect only after `/reload-plugins`.

Disconnecting removes only files whose checksum matches. A modified file is left in place, and `connection.json` is then also left behind so that disconnection can be run again. Collected data in `~/.subagent-watch/sessions/` is left untouched.
