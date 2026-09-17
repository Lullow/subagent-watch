# Verifierat: hur subagenter syns i hooks

Test 2026-09-17 med Claude Code 2.1.273, `claude -p --model haiku` och två Explore-agenter: en i förgrunden och en i bakgrunden. Hooks för `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse` och `Stop` loggade via `spike/log-hook.mjs` till `spike/events.jsonl`, som efteråt flyttades till `spike/runs/01-grund.jsonl`. Inställningarna ligger i `.claude/settings.local.json` och gäller bara sessioner som startas i den här mappen.

Beslut hittills: **bara hooks**, alltså bara dokumenterade källor, samma princip som Tokeniser.

## Händelserna i ordning

```
22:49:41.728  PreToolUse    Agent  "List spike files"    run_in_background: false
22:49:41.766  SubagentStart        a25fe… Explore
22:49:42.898  PreToolUse    Agent  "Read hook settings"  run_in_background: true
22:49:42.936  SubagentStart        ac376… Explore
22:49:42.936  PostToolUse   Agent  → status async_launched, agentId ac376…
22:49:45.521  PreToolUse    Read   agent_id ac376…
22:49:45.555  PostToolUse   Read   agent_id ac376…   duration_ms 3
22:49:46.457  PreToolUse    Bash   agent_id a25fe…
22:49:46.549  PostToolUse   Bash   agent_id a25fe…   duration_ms 56
22:49:47.984  SubagentStop         ac376…  (bakgrund)
22:49:48.331  SubagentStop         a25fe…  (förgrund)
22:49:48.363  PostToolUse   Agent  → status completed, agentId a25fe…
22:49:51.332  Stop
```

## Svar på de två öppna frågorna

1. **Verktygsanrop i bakgrundsagenter ger hooks.** `PreToolUse` och `PostToolUse` kom för `Read` i bakgrundsagenten, med `agent_id` och `agent_type`.
2. **Koppling mellan beskrivning och `agent_id`:**
   - **Bakgrund:** direkt. `PostToolUse` på `Agent` kommer samtidigt som `SubagentStart`, och `tool_response` har `agentId` och `description`.
   - **Förgrund:** `PostToolUse` på `Agent` kommer först när agenten är **klar**. Medan den körs finns bara ordningen: `PreToolUse` på `Agent` (med `description`) följdes 38 ms senare av `SubagentStart` (med `agent_id`). En `PreToolUse`-hook som inte är async blockerar tills den är klar, så ordningen bör hålla. Den kopplingen är en slutsats, inte dokumenterad.

## Övrigt som testet visade

- **Tillgängligt i dokumenterade fält:** `description`, `subagent_type` och `run_in_background` (i `tool_input` på `Agent`), `agent_id` och `agent_type` (i alla händelser inne i en agent), `tool_name` och `duration_ms` per verktyg, `agent_transcript_path` och `last_assistant_message` i `SubagentStop`.
- **Slutrapporten:** i Opus-sessioner kommer rapporten via verktyget `SubagentHandback` (`tool_input.message`), och `last_assistant_message` är då bara avslutningstexten (dokumenterat från v2.1.271). I testet användes inte `SubagentHandback`, så där stod rapporten i `last_assistant_message`.
- **Inga "tänker"-händelser.** Mellan `PostToolUse` och nästa `PreToolUse` syns ingenting. Rutan kan visa "kör verktyg X" eller "väntar på modellen", inget mer.
- **`background_tasks` i `SubagentStop`** listade bakgrundsagenten som `running`, trots att händelsen gällde just den agenten.
- **Tokens i `tool_response`, men odokumenterat.** För förgrundsagenter innehöll `tool_response` på `Agent` fälten `totalTokens`, `totalToolUseCount`, `totalDurationMs`, `usage` och `toolStats`. Enligt dokumentationen beror schemat för `tool_response` på verktyget, och det är inte beskrivet för `Agent`. `totalTokens` (10 986) är dessutom summan av det sista anropets input, cache och output, alltså kontextstorleken i slutet och inte förbrukningen. För bakgrundsagenter finns bara startsvaret.
- **Kostnad per hook:** varje anrop startar en ny Node-process. `SubagentStart` loggades 38 ms efter `PreToolUse`. Med hooks före och efter varje verktyg blir det två processer per verktygsanrop.

## Specialfall (test 2)

Test 2026-09-17 med Claude Code **2.1.274** och `claude -p --model haiku`. Loggarna ligger i `spike/runs/02-parallel`, `03a–c-stoppad`, `04-avbruten` och `05-nastlad` (`.jsonl`). För test 3 lades en `SessionEnd`-hook till i `.claude/settings.local.json`.

### Fyra agenter samtidigt (02)
- **Det gick att koppla ihop anrop och agent efter ordningen för alla fyra.** Varje `SubagentStart` kom 31–44 ms efter sin egen `PreToolUse` på `Agent` och före nästa. `tool_use_id` i den senare `PostToolUse` bekräftade varje par.
- **Svagt test:** alla fyra anrop låg i samma svar från modellen, men Claude Code startade dem ett i taget, ungefär 1 s isär, allteftersom de strömmade in. Ett verktygsanrop från en redan startad agent hamnade mellan två starter.
- **Koppla med `tool_use_id`, inte med beskrivningen.** `tool_response` för förgrundsagenter saknar `description`, men händelsen har `tool_input.description` och samma `tool_use_id`.
- **För bakgrundsagenter varierar ordningen** mellan `SubagentStart` och `PostToolUse` (`async_launched`). Ibland kom `PostToolUse` 1 ms före, men den har `agentId` direkt.

### Stoppad bakgrundsagent (03a–c)
- **`SubagentStop` kommer när agentens tur tar slut,** även om den har startat egna bakgrundsjobb. I `background_tasks` stod agenten fortfarande som `running`.
- **`TaskStop` efter det gav ingen händelse för agenten,** bara `PreToolUse` och `PostToolUse` för `TaskStop` själv (`task_id` = agentens id). Det enda tecknet på att agenten var borta var att `background_tasks` var tom i nästa `Stop`.
- **Blockerade anrop syns inte i hooks.** Claude Code stoppade `sleep 40`, både ensamt och med `&& echo`, innan `PreToolUse` kördes. Ett `TaskStop` på en uppgift som redan var klar misslyckades på samma sätt. `sleep` på 5–12 s gick bra.
- **Obesvarat:** vad som händer när en agent stoppas **mitt i** ett verktygsanrop.

### Avbruten session (04)
- Efter SIGINT till `claude -p`, medan en förgrundsagent körde `sleep 10`, kom **bara `SessionEnd`** (`reason: "other"`). Det kom ingen `SubagentStop`, ingen `PostToolUse` och ingen `Stop`.
- **Följd:** en öppen agent kan bara stängas av `SessionEnd` för samma `session_id`. Om inte ens den kommer, finns inget som stänger den.

### Agent som startar en agent (05)
- **Det fungerar.** Den inre agentens `SubagentStart` har bara `agent_id` och `agent_type`, utan fält för föräldern.
- **Föräldern går att räkna ut med hooks:** den yttre agentens `PreToolUse` på `Agent` har den yttre agentens `agent_id` och kom 33 ms före den inre `SubagentStart`. När den inre agenten är klar har `PostToolUse` på `Agent` den yttre som `agent_id` och den inre som `tool_response.agentId`.
- **Utanför hooks:** `subagents/agent-<id>.meta.json` har `parentAgentId`, `spawnDepth`, `description` och `toolUseId`. Filen skapas vid start, men den är inte dokumenterad.

### Klockan i WSL
- **Klockan hoppade ibland bakåt ungefär 1 s,** både i `at`, i transkripten och i `date`. **Ordningen i filen är pålitlig, men tidsstämplarna är det inte.**

## Ej testat än

- En agent som stoppas mitt i ett verktygsanrop.
- En session som dör utan att hinna köra `SessionEnd` (SIGKILL, krasch, stängd terminal).
- Interaktiva sessioner: vad som händer när du trycker Esc under en agent, och om allt ovan gäller utanför `-p`.
- Återupptagna agenter: enligt dokumentationen körs `SubagentStart` igen.
