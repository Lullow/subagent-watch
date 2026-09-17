# subagent-watch – sammanfattning av grillningen

Grillningen gjordes 2026-09-17 med Claude Code 2.1.274. Frågorna Q1–Q36 besvarades av dig, och de tio antagandena bekräftades. Testerna som besluten vilar på finns i [verifierat-hooks.md](verifierat-hooks.md) och i `spike/runs/`.

---

## 1. Identitet

subagent-watch är en VS Code-extension som visar Claude Codes subagenter medan de arbetar, så att det går att förstå hur huvudsessionen och agenterna hänger ihop.

Principer:
1. **Bara dokumenterade, lokala källor.** Datan kommer från Claude Codes hooks och inget annat. Inga sessionsloggar, inget nätverk och inga tokens i version 1.
2. **Ärlig om det som är okänt.** Hooks säger bara när något börjar och slutar. Det som inte går att veta visas som okänt och gissas inte.
3. **Byggd för WSL och VS Code**, precis som Tokeniser.

| Beslut | Innehåll |
|---|---|
| Huvuduppgift (Q1) | **Förstå** vad agenterna gör och hur de hänger ihop med huvudsessionen. Övervakningen följer med på köpet. |
| Ambition (Q2) | Först ett personligt verktyg och lärprojekt. Publicering avgörs senare, som för Tokeniser. |
| Arbetsnamn | `subagent-watch` (`~/projects/subagent-watch`). |
| Förhållande till Tokeniser (Q5) | En separat extension med samma teknik och mönster, men ingen gemensam kod. Bra lösningar kopieras, till exempel `secure/fs.ts`, anslutningsplanen och CI. |

---

## 2. Verifierade fakta som besluten vilar på

Detaljer och tidslinjer finns i [verifierat-hooks.md](verifierat-hooks.md).

### Hooks och subagenter
- `SubagentStart` och `SubagentStop` ger `agent_id` och `agent_type`. Alla händelser inne i en agent har `agent_id` och `agent_type`.
- **Koppla beskrivning till agent:** `PreToolUse` på `Agent` (med `tool_input.description`) kom 31–44 ms före sin `SubagentStart`, i samtliga fem fall. `PostToolUse` på `Agent` bekräftar kopplingen med `tool_use_id` och `tool_response.agentId`. För förgrundsagenter kommer den först när agenten är klar, och för bakgrundsagenter direkt.
- **Förälder:** den yttre agentens `PreToolUse` på `Agent` har den yttre agentens `agent_id`. Hooks saknar fält för föräldern.
- **Slut:** en agent som blir klar ger `SubagentStop`. En bakgrundsagent ger `SubagentStop` när dess tur tar slut, och `TaskStop` efter det ger ingen händelse. En avbruten session (SIGINT) ger bara `SessionEnd`. Anrop som Claude Code blockerar innan de körs ger inga händelser alls.
- **Inga händelser för tänkande.** Mellan två verktygsanrop säger hooks ingenting.
- **Tidsstämplar:** klockan i WSL hoppade ibland bakåt ungefär 1 s. Ordningen i filen är pålitlig, tidsstämplarna är det inte.
- **Hooks får ingen tokendata** (dokumenterat).

### Dokumenterat om hooks och plugins
- Ett plugin i `~/.claude/skills/<namn>/` med `.claude-plugin/plugin.json` laddas i alla projekt utan installation och utan att något skrivs till `settings.json`. En vanlig `/plugin install` skriver däremot `enabledPlugins` till `~/.claude/settings.json`, som Tokeniser håller koll på med kontrollsumma. Tokeniser-sessionen ifrågasatte 2026-09-17 att plugins läses in från `skills/`, men dokumentationen säger det uttryckligen: en mapp med `.claude-plugin/plugin.json` laddas som `<namn>@skills-dir` från nästa session, och personliga plugins har inga extra begränsningar. Det är ännu inte provat i en riktig session (R4).
- `timeout` anges i sekunder. En `PreToolUse`-hook som överskrider tiden blockerar inte verktyget. Hooks för `SessionEnd` delar på en budget på 1,5 s.
- Kod 2 från en hook blockerar. För `SessionStart` och `UserPromptSubmit` läggs stdout till i Claudes kontext.
- `PermissionRequest` körs innan Claude frågar dig. Hooken kan fatta beslut, så vår hook får aldrig skriva något.
- `PostToolUseFailure` körs när ett verktyg misslyckas. Ett anrop som du nekar själv ger `PreToolUse` men sedan ingenting. `PermissionDenied` finns bara i auto-läge. `StopFailure` körs i stället för `Stop` vid API-fel.
- `disableAllHooks` stänger av även plugin-hooks, och därmed både Tokeniser och subagent-watch.
- Hooks ärver Claude Codes PATH. Hos dig hittas `node` via nvm, men utan nvm kan det bli Windows `node.exe`.

### Nodes behörighetsmodell (Node 24.14.1, testat 2026-09-17)
- Den nekar skrivning direkt utanför tillåtna mappar, läsning av andra filer och underprocesser.
- **Den följer länkar som redan finns.** Att skriva genom en befintlig fil- eller mapp-symlänk i en tillåten mapp når filer utanför. `O_NOFOLLOW` stoppar det för filer (`ELOOP`).
- **Den stoppar skapandet av länkar ut ur mappen.** Symlänkar, hårda länkar och `rename` utifrån gav `ERR_ACCESS_DENIED`.
- **Det gäller bara Node med rättelsen av CVE-2025-55130** från 13 januari 2026 (20.20.0, 22.22.0, 24.13.0 och 25.3.0). I äldre versioner kunde en relativ symlänk leda ut ur de tillåtna mapparna. Enligt Tokeniser-sessionens test i 24.14.1 nekas symlänkar nu helt, även inom de tillåtna mapparna, men hårda länkar mellan filer i de tillåtna mapparna går fortfarande att skapa.
- **Den stoppar inte nätverk** i Node 24.
- Skriptet får inte köra `lstat` ovanför de tillåtna mapparna.
- Filer skapas med 0644 om inget annat anges.

---

## 3. Fattade beslut

### Omfång
| # | Beslut |
|---|---|
| Q3 | **Sessioner:** sessioner i fönstrets projekt visas i detalj. Övriga sessioner sammanfattas på en rad, t.ex. "tokeniser · 1 agent kör". En session hör till fönstret om dess `cwd` vid `SessionStart` ligger i en av fönstrets arbetsytor. |
| Q6/Q28 | **Huvudsessionen** är roten, med samma färgade bitar som agenterna på sin rad. |
| Q7 | **Klara agenter** finns kvar tills sessionen tar slut. Äldre turer fälls ihop (Q27). |
| Q15 | **När sessionen har slutat** visas den kvar nedtonad med "Avslutad 14:32", tills en ny session startar i projektet. |
| Q16 | **Flera sessioner i samma projekt** blir egna rötter, med den senast aktiva överst. |

### Insamling
| # | Beslut |
|---|---|
| Q8, Q33, Q34 | **Vad som sparas:** agenttyp, tider, status, verktygsnamn, uppdragets `description`, Bash-anropens `description`, sökvägar för `Read`, `Edit`, `Write` och `NotebookEdit`, och mönster för `Glob`. Från `WebFetch` bara värdnamnet. **Sparas aldrig:** Bash-kommandon, `Grep`-mönster, sökfrågor från `WebSearch`, prompter, rapporter, `last_assistant_message`, felmeddelanden, `transcript_path` och `prompt_id`. All sparad text maskeras, så att strängar som liknar nycklar blir `[dolt]`. |
| Q12 | **Alla hooks körs sync** med `timeout` på 3 s. |
| Q13 | **Agenter som aldrig får ett stopp:** `SessionEnd` stänger öppna agenter som "avbruten". Kommer ingen händelse på 10 minuter visas agenten som "okänt läge, ingen signal sedan 14:32", men den tas inte bort. |
| Q17 | **Lagring:** en fil per session, som raderas 24 timmar efter sessionens senaste händelse. Ett kommando raderar allt direkt. |
| Q31 | **Väntar på dig:** tiden från `PermissionRequest` tills du har svarat är en egen kategori. Bara tid och verktygsnamn sparas. |
| Q32 | **Fel:** ett misslyckat anrop får en röd markering. En tur som slutar med API-fel märks med feltypen, t.ex. `rate_limit`, men inte felmeddelandet. En bit som aldrig får ett slut stängs när nästa händelse från samma agent kommer, och märks "okänt slut". |

### Plugin och installation
| # | Beslut |
|---|---|
| Q9, Q21 | **Plugin i skills-mappen:** `~/.claude/skills/subagent-watch/` med `.claude-plugin/plugin.json` och `hooks/hooks.json`. Mappen är en riktig mapp, inte en symlänk. Inget skrivs till `settings.json`. |
| Q22 | **Anslutning:** ett kommando (`npm run connect`) som visar exakt vilka filer som skapas och kräver bekräftelse med en hash, som i Tokeniser. När du kopplar bort tas bara filer bort vars kontrollsumma fortfarande stämmer. |
| Q23 | **Node:** en absolut sökväg skrivs in vid anslutningen, och skriptet körs med `/usr/bin/env -i <node> --permission` i exec-form (`command` plus `args`, utan skal). |
| Q24 | **Data:** `~/.subagent-watch/sessions/<session_id>.jsonl`, med mappar satta till 0700 och filer till 0600. |
| Q25 | **Rensning:** skriptet rensar gamla filer vid `SessionStart`. Ingen låsfil behövs. |
| Q36 | **Kontrollsumma:** statusraden jämför kontrollsumman för skriptet och `hooks.json` med det som sparades vid anslutningen. Om de skiljer visas "Insamlaren har ändrats". |

### Vyn
| # | Beslut |
|---|---|
| Q4 | **Placering:** en egen webbvy i bottenpanelen, som går att dra bredvid Terminal eller in i Tokenisers kolumn. |
| Q14 | **Form:** en tidslinje med verktygsrytm (C2) i layouten från din bild: en vänsterkolumn med sessioner och agenter, tidslinjen till höger och text i en detaljpanel längst ner. Linjerna för vem som startade vem (C3) visas bara för den markerade raden. Detaljerna bestäms i skissen och efter några dagars användning. |
| Q26 | **Kategorier:** Läsa (`Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`), Terminal (`Bash`), Skriva (`Edit`, `Write`, `NotebookEdit`), Vänta (på en egen agent), Väntar på dig (Q31), Tänka (tiden mellan två verktygsanrop under en tur) och Övrigt (grå). Legendens verktygstips förklarar att Tänka egentligen mäter tiden mellan anrop. |
| Q27 | **Tidsaxeln** visar den senaste turen, från din prompt tills Claude och alla agenter den startade är klara. Äldre turer fälls ihop till en rad var ("14:05 · 3 agenter · 2 min") och går att fälla ut, en i taget (skissen, avsnitt 9). |
| Q29 | **Detaljpanelen** visar den markerade raden, annars huvudsessionen: vad den gör just nu, tid och antal anrop. När musen hålls över en bit visas det anropet. Under panelen finns raden för andra sessioner och statusraden. |
| Q30 | **Vänsterkolumnen** har två rader per agent: typen i fetstil och beskrivningen avkortad, med hela texten i ett verktygstips. Djupet visas med indrag. Smalare än ungefär 420 px visas bara typen. |
| Q10 | **Rörelse** bara när något händer. Staplarna växer med tiden, och inget snurrar eller pulserar. Minskad rörelse respekteras. |
| Q11 | **Statusfältet:** en post, t.ex. `⚙ 2`, visas bara när agenter kör i fönstrets projekt. Ett klick öppnar vyn. |
| Q18 | **Statusrad i vyn:** "Pluginet aktivt · senaste händelse 14:32:05". Vid problem visas en kort förklaring och ett kommando att kopiera, samt kontrollsumman från Q36. |
| Q20 | **Inga aviseringar.** |
| – | **Färger** hämtas från VS Codes tema (`--vscode-*`) och fungerar i ljust och mörkt tema och i högkontrast. |

### Repo och process
| # | Beslut |
|---|---|
| Q19 | Git-repo, privat på GitHub (`Lullow/subagent-watch`). Enhetstester och tester från början till slut. CI vid varje push, bara med läsrättighet och med actions låsta till commits. Spike-körningarna blir rensade testdata. |
| Q35 | Test-hooks i `.claude/settings.local.json` togs bort direkt efter grillningen. De befintliga körningarna behålls. |
| – | Processen är sammanfattning, sedan klickbar skiss, sedan bygge. Inget byggs innan skissen är godkänd. |

---

## 4. Arkitektur

```
Claude Code-session (terminal i WSL)
   │  hooks från pluginet i ~/.claude/skills/subagent-watch/
   │  sync, timeout 3 s, exec-form utan skal
   ▼
/usr/bin/env -i <node> --permission  collector.cjs  --home=~/.subagent-watch
   │  sparar bara tillåtna fält, maskerar, kortar, skriver aldrig till stdout, avslutar alltid med 0
   ▼
~/.subagent-watch/sessions/<session_id>.jsonl      (0700/0600, raderas efter 24 h)
   │  alla VS Code-fönster läser, inget index och inget lås
   ▼
tolkning: agenter · verktygsbitar · föräldrar · turer · okänt/avbrutet
   │
   ▼
webbvy i bottenpanelen  ·  post i statusfältet  ·  statusrad med kontrollsumma
```

**Lagren:** allt ovanför ritningen är gemensamt för alla former av vyn. Därför kostar det lite att ändra ritningen senare (Q14).

### Hooks och vad som sparas

| Hook | Används till | Sparas utöver tid, `session_id` och eventuellt `agent_id`/`agent_type` |
|---|---|---|
| `SessionStart` | Session börjar, projekt (`cwd`), rensning | projektets sökväg |
| `UserPromptSubmit` | Ny tur, början på Tänka | inget (aldrig prompten) |
| `PreToolUse` / `PostToolUse` | Verktygsbitar, koppling till agent | verktygsnamn, `tool_use_id`, detalj enligt Q8/Q33/Q34, `run_in_background` och `description` för `Agent`, `agentId` från `tool_response` för `Agent` |
| `PostToolUseFailure` | Misslyckat anrop | verktygsnamn, `tool_use_id` |
| `PermissionRequest` | Väntar på dig | verktygsnamn (hooken skriver aldrig något) |
| `PermissionDenied` | Nekat i auto-läge | verktygsnamn, `tool_use_id` (aldrig `reason`) |
| `SubagentStart` / `SubagentStop` | Agentens start och slut | `agent_id`, `agent_type` (aldrig `last_assistant_message` eller sökvägar till transkript) |
| `Stop` / `StopFailure` | Turen klar eller avbruten av fel | feltyp för `StopFailure` (aldrig `error_details`) |
| `SessionEnd` | Sessionen slut, stänger öppna agenter | `reason` |

### Tolkningsregler
- **Förgrundsagent:** en `SubagentStart` kopplas till närmast föregående `PreToolUse` på `Agent` som ännu inte har kopplats, i samma session. Den första `PostToolUse` bekräftar kopplingen eller rättar den.
- **Bakgrundsagent:** kopplas via `tool_response.agentId`, oavsett ordning.
- **Förälder:** `agent_id` på `PreToolUse` för `Agent`. Saknas det är föräldern huvudsessionen.
- **Ordning:** raderna i filen styr ordningen. Tidsstämplar används bara för längder och klockslag.
- **Tur:** från `UserPromptSubmit` tills både `Stop` eller `StopFailure` har kommit och alla agenter som startades i turen är klara.

---

## 5. Säkerhet och integritet

### Hot
| Hot | Skydd |
|---|---|
| Innehåll från konversationen hamnar på disk | Tillåtelselista över fält (Q8, Q33, Q34), maskering, korta texter, 24 h lagring, 0600 |
| Skriptet blockerar Claude eller skjuter in text i kontexten | Ingen stdout (avstängd från första raden), alltid kod 0, alla fel fångas, timeout 3 s, tester för varje händelsetyp |
| Skriptet skriver utanför sin mapp | S1–S2 och behörighetsmodellen som skydd på djupet |
| Innehåll från ett repo du inte litar på kör kod i vyn | S8–S10 |
| Ändrad insamlare kör i alla sessioner | Kontrollsumma i statusraden (Q36). Anslutningen avbryts vid främmande mapp eller symlänk (S7). |
| Läckage via nätverk | Inga beroenden vid körning, statisk kontroll av den byggda koden (S6), CSP i vyn |
| Läckage via GitHub | S11 |

### Tekniska krav
| # | Krav |
|---|---|
| S1 | Filer öppnas med `O_NOFOLLOW` och läge 0600. Skriptet kontrollerar att `sessions/` är en riktig mapp som ägs av dig och har läge 0700, och den öppnade filen kontrolleras (ägare, en enda hård länk). Anslutningen kontrollerar hela mappkedjan, och statusraden gör om kontrollen. Rensningen tar bara bort vanliga filer med rätt namnmönster. `secure/fs.ts` kopieras från Tokeniser. |
| S2 | Strikt kontroll av `session_id` (UUID), `agent_id`, `tool_use_id`, verktygsnamn och händelsenamn (fast lista). Allt annat kastas. |
| S3 | Texter kortas (sökväg 240 tecken, beskrivning 120). Styrtecken och tecken som vänder textriktningen tas bort med `/[\p{Cc}\p{Bidi_Control}]/gu`. Det tar även U+200E, U+200F, U+061C och C1-tecknen U+0080–U+009F, men lämnar U+200D kvar så att emojier inte går sönder (provat i Node 24.14.1 av Tokeniser-sessionen). Sökvägar sparas relativt projektet, och hemmappen skrivs som `~`. |
| S4 | Varje rad är högst 2 KB och skrivs med ett enda anrop. Varje session har ett tak på 20 MB, och indata större än 64 MB kastas. Kastade händelser räknas och visas i statusraden. |
| S5 | Stdout stängs av först, alla fel fångas och koden är alltid 0. Tester kontrollerar tom stdout och kod 0 för varje händelsetyp och för trasig indata. |
| S6 | Inga beroenden vid körning. CI kontrollerar att den byggda insamlaren inte använder `net`, `http`, `https`, `http2`, `dns`, `tls`, `dgram`, `child_process`, `process.env`, `eval`, `new Function` eller `import()`. |
| S7 | Exec-form utan skal. Sökvägarna till Node och hemmappen kontrolleras mot en tillåtelselista. Anslutningen avbryts om `~/.claude/skills/subagent-watch` redan finns och inte är vår, eller om den är en symlänk. Den avbryts också med Node äldre än 24.13.0 eller med 25.0–25.2, och med Node 22 eftersom insamlaren bara testas med 24, som i Tokeniser. Planen visar versionen. |
| S8 | Webbvyn har CSP `default-src 'none'`, skript bara med nonce, ingen `connect-src`, `enableCommandUris: false`, och `localResourceRoots` bara för den byggda koden. |
| S9 | All text från händelser sätts med `textContent`. Tester förbjuder `innerHTML` och liknande i den byggda vyn (som i Tokeniser) och använder en fil som heter `<img src=x onerror=…>`. |
| S10 | Filerna läses som opålitliga: varje rad kontrolleras mot schemat, och symlänkar, fel ägare, fel rättigheter och för stora filer avvisas. Meddelanden från webbvyn måste stå på en tillåtelselista. Kommandon som kopieras är fasta strängar. |
| S11 | `spike/runs/` checkas aldrig in. Testdata skapas av ett skript som använder samma filtrering och maskering som insamlaren. |

### Kända luckor
1. **Nätverk stoppas inte av Node 24:s behörighetsmodell.** Skyddet är vår kod och den statiska kontrollen (samma lucka som i Tokeniser).
2. **Insamlaren kan inte kontrollera mappkedjan ovanför `sessions/` själv.** Anslutningen och statusraden gör det, men de upptäcker en ändring utan att hindra en skrivning under tiden.
3. **Kod som körs som din användare** kan ändra pluginet, datan och kontrollsummorna. Det ligger utanför hotmodellen, precis som i Tokeniser.
4. **Maskeringen är heuristisk.** Den missar hemligheter som inte liknar kända format, och kan ibland dölja ofarliga långa strängar.
5. **Nya länkar nekas bara av Node.** Länkar som redan finns stoppas av vår kod (`O_NOFOLLOW`, `lstat` och antal hårda länkar), men att nya länkar inte kan skapas beror på Node 24.13.0 eller senare. Versionen kontrolleras vid anslutningen och inte i statusraden. Efter det kan bara du eller root byta Node-filen.

---

## 6. Första versionen

### Ingår
- Plugin, insamlare och `npm run connect` med bortkoppling.
- Tolkning av agenter, verktygsbitar, föräldrar, turer, okänt läge, avbrutna agenter och fel.
- Vyn enligt Q14 och Q26–Q30, med statusrad, post i statusfältet och raden för andra sessioner.
- Kommandot "Radera insamlad data".
- Alla tekniska krav S1–S11 och tester mot de rensade spike-körningarna.

### Ingår inte (senare versioner)
- Tokens, t.ex. via OpenTelemetry, men bara per agenttyp.
- Historik över flera sessioner.
- En knapp för att ansluta i extensionen.
- Aviseringar.
- Stöd för annat än WSL.

## 7. Acceptanskriterier för första versionen
1. En Explore-agent i förgrunden och en general-purpose-agent i bakgrunden visas som egna rader under huvudsessionen, med rätt beskrivning, medan de kör.
2. En agent som startas av en agent visas med indrag, och dess förälder får en linje när raden markeras.
3. Verktygsbitar har rätt kategori och växer medan verktyget kör. Tiden mellan anrop visas som Tänka.
4. `SessionEnd` stänger öppna agenter som "avbruten". Utan händelser på 10 minuter visas "okänt läge".
5. Ett misslyckat anrop får en röd markering, och ett anrop du nekar får "okänt slut".
6. Inget i `~/.subagent-watch` innehåller Bash-kommandon, prompter, `Grep`-mönster eller hela adresser. Det kontrolleras med ett test mot alla spike-körningar.
7. Insamlaren skriver aldrig till stdout och avslutar alltid med kod 0, även vid trasig indata.
8. Filer har läge 0600 och mappar 0700, och symlänkar och hårda länkar avvisas. En ändrad insamlare som försöker skapa länkar ut ur mappen nekas, kontrollerat med ett test.
9. Den byggda koden har noll nätverksanrop, kontrollerat med ett test.
10. `~/.claude/settings.json` är byte för byte oförändrad efter anslutning och bortkoppling.
11. Vyn fungerar i ljust tema, mörkt tema och högkontrast, och utan animationer vid minskad rörelse.

---

## 8. Risker

| # | Risk | Hantering |
|---|---|---|
| R1 | **Otestat i interaktiva sessioner:** Esc under en agent, en session som dör utan `SessionEnd` och en agent som stoppas mitt i ett anrop. | Verifieras med pluginet i dina vanliga sessioner. Q13 och Q32 gör att vyn visar "okänt" i stället för något felaktigt. |
| R2 | **Koppling efter ordning är en slutsats**, inte dokumenterad. | Bekräftas och rättas av `PostToolUse` via `tool_use_id`. Tester med parallella agenter. |
| R3 | **Byte av Node-version** gör att den absoluta sökvägen slutar fungera. | Statusraden visar att inga händelser kommer och föreslår `npm run connect`. Anslutningen kontrollerar versionen igen (S7). |
| R4 | **Plugins i skills-mappen** har odokumenterade detaljer, t.ex. id för datamappen och symlänkar. | Vi använder varken `CLAUDE_PLUGIN_DATA` eller symlänkar. **Bekräftat 2026-09-17 med Claude Code 2.1.274:** efter anslutningen visar `claude plugin list` `subagent-watch@skills-dir` som laddat, och en `claude -p`-session med en Explore-agent gav alla tio händelser (från `SessionStart` till `SessionEnd`) via hook-kommandot i exec-form, med behörighetsmodellen och utan problem. Interaktiva sessioner återstår (R1). |
| R5 | **Claude Codes chattfönster i VS Code och Desktop** laddar kanske inte plugins från CLI. | Utanför målgruppen: du kör i terminalen. |
| R6 | **Två Node-processer per verktygsanrop** tar ungefär 70 ms. | Mäts i bygget. Kan ändras till async för `PostToolUse` om det märks, eftersom ordningen bara krävs vid `Agent`. |
| R7 | **Hooks-formatet ändras** i en ny version av Claude Code. | Schemakontroll i skriptet och vyn. Okänd data kastas och räknas i statusraden. |

## 9. Nästa steg
1. **Godkänd 2026-09-17:** klickbar skiss i `docs/skiss/subagent-watch-skiss.html`, med layouten från din bild och VS Codes utseende. Beslut från skissen:
   - **Tänka** visas som en hel bit.
   - **Linjerna** för den markerade raden går både till föräldern och till agenterna som raden startade. Huvudsessionen är markerad från början och har ingen förälder, så med bara föräldern skulle vyn börja utan linjer.
   - **Äldre turer** ligger ihopfällda under den utfällda turen, med den nyaste först. De går att fälla ut en i taget, och den utfällda turen tar över tidsaxeln. Klara agenter finns kvar tills sessionen slutar (Q7), och det är bara till nytta om de går att se.
   - **Tidsaxeln** växer i steg: 30 s, 1 min, 2 min, 3 min, 5 min, 10 min, 15 min, 30 min och 1 h, med 8 % luft efter steget. Den hoppar bara när turen passerar ett steg, så inget krymper varje sekund (Q10). Klockslaget står vid turens början, och resten av axeln visar tid efter start, t.ex. "+30 s". När en agent hamnar i okänt läge går axeln tillbaka till den senaste händelsen och slutar med klockslaget för nu.
   - **Statusfältet** (Q11) visar `⚙ ?` när den enda agenten är i okänt läge, och t.ex. `⚙ 1 ?` när en annan agent kör samtidigt.
   - **Huvudsessionens rad** har ingen beskrivning, eftersom prompten aldrig sparas. Den visar projektet och början på sessionens id.
   - **Markeringar:** en klar rad slutar med en fylld punkt, en avbruten med ✕ och texten "avbruten", och okänt läge med en streckad ring och texten "okänt läge · ingen signal sedan 14:32:20". Ett misslyckat anrop får en röd punkt och röd underkant, och en bit med okänt slut tonas ut.
2. **Bygge:** git-repo och CI, insamlare med plugin och `connect`, tolkning testad mot de rensade spike-körningarna, och sist vyn.
   - **Klart 2026-09-17:** git-repo med CI och insamlaren. Den sparar bara fälten enligt Q8, Q33 och Q34, rensar och maskerar all text (S3), har taken i S4 och rensar vid `SessionStart` (Q25). Testerna kör den byggda filen med exakt samma kommando som hooken och visar att behörighetsmodellen stoppar en ändrad insamlare, även från att skapa länkar. En hook tar i median 24 ms med behörighetsmodellen. Rensade testdata från spike-körningarna ligger i `test/fixtures/runs/` (S11). Beslut under bygget:
     - Insamlaren installeras i `~/.subagent-watch/bin/collector.cjs`, som i Tokeniser. Pluginmappen innehåller bara `plugin.json` och `hooks.json`.
     - `PostToolUse` och `PostToolUseFailure` sparar också `duration_ms`. Det räknas till tiderna i Q8 och är pålitligare än tidsstämplarna i WSL.
     - Detaljen för ett verktyg sparas bara vid `PreToolUse`, eftersom `PostToolUse` har samma `tool_use_id`.
     - Kastade händelser räknas per dygn i `sessions/problems-ÅÅÅÅ-MM-DD.jsonl`, med bara orsak och tid, och rensas som sessionerna.
   - **Klart 2026-09-17:** `npm run connect` med bortkoppling (Q22). Planen visar mappar, filer med kontrollsummor, Node-versionen och hela hook-kommandot, och den måste godkännas med sin hash. Anslutningen skriver aldrig till `settings.json` (acceptanskriterium 10, testat byte för byte) och avbryts enligt S7. Beslut under bygget:
     - Hooks gäller först i nya sessioner eller efter `/reload-plugins` (dokumenterat), och det står i utskriften.
     - `hooks.json` skrivs sist, så pluginet har inga hooks förrän allt annat är på plats. `connection.json` skrivs före pluginfilerna, så att en avbruten anslutning kan städas med `--disconnect`.
     - Bortkopplingen tar bort `hooks.json` först. Om en fil har ändrats lämnas den och `connection.json` kvar, så att bortkopplingen kan köras igen när du har tittat på filen.
     - Planen varnar om `disableAllHooks` är på eller om `subagent-watch@skills-dir` är avstängt i `enabledPlugins`. Dokumentationen säger att pluginet kan stängas av där.
   - **Klart 2026-09-17:** tolkningen i `src/model/`. Den läser filerna stegvis som opålitlig data (S10) och bygger turer, rader, bitar per kategori, föräldrar och lägen. Testerna täcker acceptanskriterierna 1–5 mot de rensade spike-körningarna och påhittade fall, bland annat fyra parallella agenter, en agent i en agent, klockhoppet i WSL och en koppling som rättas av `PostToolUse` (R2). En riktig session från `~/.subagent-watch` tolkades rätt. Beslut under bygget:
     - **Parallella anrop:** en rad kan ha flera öppna anrop, som huvudsessionen som väntar på fyra agenter. Därför stängs ett anrop utan slut inte av vilken händelse som helst från samma agent (Q32). Ett anrop som frågade om lov stängs med okänt slut när raden gör ett nytt anrop, eftersom frågan då är besvarad. Övriga öppna anrop stängs när agenten eller turen slutar.
     - **Väntar på dig** delas med `duration_ms`: frågan varar till `PostToolUse` minus anropets längd, och resten är verktyget.
     - **Efter Stop** väntar huvudsessionen på agenter som kör i bakgrunden. Fortsätter huvudsessionen utan en ny prompt, till exempel när en bakgrundsagent blir klar, hör det till samma tur, och tiden innan blir Tänka.
     - **Okänt läge:** en agent räknas som tyst bara om varken den eller någon agent den har startat har hörts av på 10 minuter. Huvudsessionen blir okänd när hela sessionen har varit tyst så länge.
     - **Start av en bakgrundsagent** är en omedelbar bit som vyn inte visar. Händelser utan `UserPromptSubmit` före sig, som i spike-körningarna, får en tur som börjar vid första händelsen.
     - **Andra projekt** räknas i raden för andra sessioner så länge de har agenter som kör eller har varit aktiva den senaste timmen. En avslutad session räknas inte.
     - **Läsningen** avvisar filer större än 20 MB plus 64 KB, och märker en fil som har återskapats med samma namn genom att jämföra de första byten.
   - **Klart 2026-09-17:** vyn enligt den godkända skissen: webbvy i bottenpanelen med förklaring, tidslinje, detaljpanel, raden för andra sessioner och statusraden, posten i statusfältet och kommandot "Radera insamlad data". Webbvyn har CSP utan inline-kod och `connect-src` (S8), bygger all text med `textContent` (S9) och tar bara emot kopiering av två fasta kommandon (S10). Testerna kontrollerar att vyns stil bara tar färger från temat och har regler för högkontrast och minskad rörelse (acceptanskriterium 11). Integrationstesterna i VS Code 1.137.0 körs i CI, eftersom VS Code saknar systembibliotek i WSL. Beslut under bygget:
     - **Flera sessioner i projektet** (Q16) får var sin tidsaxel, med den senast aktiva överst.
     - **En utfälld äldre tur** ligger kvar när en ny tur startar. Den nya turen syns ihopfälld med texten "pågår".
     - **En agent utan känd beskrivning** visas med "ingen beskrivning" i stället för en gissning.
     - **Klockan** i webbvyn följer extensionens klocka i WSL, så att bitarna växer rätt även om Windows och WSL går olika.
     - **Längder under en sekund** visas i millisekunder.
     - **Uppdatering:** vyn läser nya rader varje sekund och kontrollsummorna var femte sekund. Webbvyn får data bara när något har ändrats, och bitarna växer bara medan en tur pågår (Q10).
     - **Radera insamlad data** bekräftas i VS Codes egen dialog och tar bara bort sessions- och problemfiler. Pluginet och insamlaren ligger kvar.
   - **Rättat 2026-09-17 efter första blicken i VS Code:** vyn fungerar nu också avlång. Q30 sa bara att en smal vy visar agenttypen, men i praktiken är varje plats utom hela bottenpanelen smal och hög.
     - **Tre former:** bred (tidslinje bredvid namnen), smal under 420 px (bara agenttypen) och stående under 320 px, där typ och beskrivning står ovanför en tidslinje i full bredd. Linjerna mellan förälder och agent fungerar i alla tre.
     - **I den stående formen** visas också hur länge varje rad har hållit på, bredvid namnet.
     - **Ingen död yta:** raderna, detaljpanelen, raden för andra sessioner och statusraden ligger tätt ihop. I panelen och sidopanelen ligger de mot nederkanten, så att raderna sitter intill detaljpanelen, och tomrummet hamnar överst.
     - **Brett läge (tillägg till Q4):** kommandot "Öppna i en flik" öppnar vyn som en egen flik i editorytan, där tidslinjen får full bredd. Panelvyn finns kvar. I fliken ligger innehållet mot överkanten.
   - **Prövat i en riktig session 2026-09-17** med en agent i förgrunden, en i bakgrunden som startade en egen agent, ett långsamt Bash-anrop och ett som misslyckades. Två fynd:
     - **En agent som startas av en bakgrundsagent** svarar direkt med `PostToolUse` och `agentId`, men utan `run_in_background` i anropet. Tolkningen räknar därför ett Agent-anrop som slutar långt före sin agent som en start i bakgrunden, inte som väntan.
     - **När en bakgrundsagent blir klar kommer en ny `UserPromptSubmit`**, alltså en ny tur, inte en fortsättning på den gamla. Beslutet i tolkningen om att huvudsessionen kan fortsätta i samma tur gäller fortfarande, men i praktiken blir det oftast en ny tur med bara Tänka och ett svar.

## Källor
- Hooks: https://code.claude.com/docs/en/hooks
- Plugins: https://code.claude.com/docs/en/plugins-reference (bland annat skills-directory plugins, scopes och miljövariabler)
- Subagenter: https://code.claude.com/docs/en/sub-agents
- OpenTelemetry (för senare tokens): https://code.claude.com/docs/en/monitoring-usage
- Node-rättelsen för symlänkar (CVE-2025-55130): https://nodejs.org/en/blog/vulnerability/december-2025-security-releases
- Tokeniser: `~/projects/tokeniser/docs/tokeniser-sammanfattning.md` och `docs/insamlarens-sakerhetskontrakt.md`
