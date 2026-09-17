# subagent-watch

VS Code-extension som visar Claude Codes subagenter medan de arbetar – bara från dokumenterade, lokala källor.

**Status:** bygget har börjat. Alla designbeslut finns i [docs/subagent-watch-sammanfattning.md](docs/subagent-watch-sammanfattning.md), och den godkända skissen i [docs/skiss/subagent-watch-skiss.html](docs/skiss/subagent-watch-skiss.html). Insamlaren, anslutningen och tolkningen är klara. Vyn återstår.

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

## Tolkningen

`src/model/` läser `sessions/` som opålitlig data och bygger det vyn visar:

- `reader.ts` läser bara hela nya rader, avvisar symlänkar, hårda länkar, fel rättigheter och för stora filer, och märker när en fil har ersatts.
- `schema.ts` godkänner bara rader som exakt följer insamlarens schema.
- `interpret.ts` bygger turer, rader för huvudsessionen och agenterna, bitar per kategori (Q26), föräldrar, väntan på dig, fel, avbrutna agenter och okänt läge. Ordningen i filen styr, och tidsstämplarna görs monotona.
- `window.ts` väljer sessionerna för fönstrets projekt (Q3, Q15, Q16) och sammanfattar andra projekt.

## Ansluta

```sh
npm run connect                                   # visar planen och dess hash, ändrar ingenting
npm run connect -- --apply=<hash>                 # utför exakt den planen
npm run connect -- --disconnect                   # visar planen för bortkoppling
npm run connect -- --disconnect --apply=<hash>
```

Anslutningen skapar pluginet `~/.claude/skills/subagent-watch/` med `.claude-plugin/plugin.json` och `hooks/hooks.json`, installerar insamlaren och sparar kontrollsummorna i `~/.subagent-watch/connection.json`. Den skriver aldrig till `~/.claude/settings.json`. Den avbryts om pluginmappen redan finns eller är en symlänk, om mappkedjan kan ändras av någon annan och med Node äldre än 24.13.0 eller 25.0–25.2.

Pluginet heter `subagent-watch@skills-dir` och laddas i nya sessioner. I sessioner som redan körs gäller det först efter `/reload-plugins`.

Bortkopplingen tar bara bort filer vars kontrollsumma stämmer. En ändrad fil lämnas kvar, och då ligger `connection.json` också kvar så att bortkopplingen kan köras igen. Insamlad data i `~/.subagent-watch/sessions/` rörs inte.
