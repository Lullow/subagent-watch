# subagent-watch

VS Code-extension som visar Claude Codes subagenter medan de arbetar – bara från dokumenterade, lokala källor.

**Status:** bygget har börjat. Alla designbeslut finns i [docs/subagent-watch-sammanfattning.md](docs/subagent-watch-sammanfattning.md), och den godkända skissen i [docs/skiss/subagent-watch-skiss.html](docs/skiss/subagent-watch-skiss.html). Insamlaren är klar. Anslutningen, tolkningen och vyn återstår.

## Utveckling

Kräver Node 24.13 eller senare.

```sh
npm install
npm run build      # bygger dist/collector.js med esbuild
npm run typecheck
npm test           # enhetstester och tester av den byggda insamlaren
npm run testdata   # skapar test/fixtures/runs/ från spike/runs/, som aldrig checkas in (S11)
```

CI på GitHub (`.github/workflows/ci.yml`) kör typkontroll, enhetstester och tester från början till slut vid varje push till `main` och varje pull request. Arbetsflödet har bara läsrättighet, inga hemligheter och actions låsta till exakta commits.

## Insamlaren

`src/collector/` blir `~/.subagent-watch/bin/collector.cjs`. Claude Code kör den vid varje hook, i exec-form utan skal:

```
/usr/bin/env -i <node> --permission --allow-fs-read=<collector> --allow-fs-read=<sessions>/ --allow-fs-write=<sessions>/ <collector> --home=~/.subagent-watch
```

- **Sparar** bara fälten i tillåtelselistan i `src/collector/record.ts`, en rad per händelse i `sessions/<session_id>.jsonl` (0600 i en mapp med 0700).
- **Sparar aldrig** Bash-kommandon, prompter, `Grep`-mönster, sökfrågor, rapporter, felmeddelanden eller hela adresser. All text rensas från styrtecken, maskeras och kortas i `src/collector/text.ts`.
- **Skriver aldrig** till stdout eller stderr och avslutar alltid med kod 0.
- **Kastade händelser** räknas i `sessions/problems-ÅÅÅÅ-MM-DD.jsonl` med bara orsak och tid.
- **Rensning:** vid `SessionStart` tas filer bort vars senaste händelse är äldre än 24 timmar.
