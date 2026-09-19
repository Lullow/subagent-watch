# Fynd: händelser kastas när identiteten är halv

Upptäckt 2026-09-19 under arbete i ett annat projekt, efter att panelen visade
"39 händelser kastades eftersom formatet var okänt". Reviderat samma kväll efter
att den ursprungliga slutsatsen visade sig vara fel. Inte åtgärdat — det här är
underlaget för att ta vid.

> **Rättelse.** Första versionen av det här dokumentet drog slutsatsen att
> subagent-payloaden hade ändrats mellan Claude Code 2.1.273 och 2.1.278, och att
> verktygets kärnfunktion därför varit död. Det stämmer inte. Formatet är
> oförändrat, och parsern klarar subagenter i 2.1.278. Bevisen för den slutsatsen
> var nollor som hade en mycket enklare förklaring — se "Vad nollorna faktiskt
> betydde". Buggen i villkoret är däremot verklig, och träffar något annat.

## Sammanfattning

Claude Codes egna interna agenter avslutar med `SubagentStop` där `agent_type` är
en **tom sträng**. Villkoret i `parseHook` krävde att båda identitetsfälten
validerade, och en tom sträng faller på `AGENT_TYPE` — så hela händelsen
förkastades. Det skedde intill varje turslut i de sessioner där interna agenter
kördes. 76 händelser gick förlorade.

Subagenter spelas in korrekt, och formatet har inte ändrats. Det var aldrig
problemet.

Åtgärdat och driftsatt — se "Åtgärdat".

## Vad nollorna faktiskt betydde

Mätt på `~/.subagent-watch/sessions/`, 48 sessioner:

| | |
|---|---|
| Inspelade händelser | 998 |
| Varav med `agent_id` eller `agent_type` | 0 |
| `SubagentStart` / `SubagentStop` inspelade | 0 |
| `PreToolUse` på verktyget `Agent` | 0 |
| Kastade händelser | 65, **alla** med orsak `agent` |

Nollorna såg ut som total dataförlust. De var det inte. Varje sessionsfil i lagret
kontrollerades mot sitt transkript i `~/.claude/projects/`:

```
sessioner i lagret: 48   transkript hittade: 47
sessioner med Agent-anrop eller sidechain: 0
```

**Ingen subagent hade körts.** Noll `SubagentStart` är exakt vad man ska förvänta
sig när noll subagenter startats. Nollorna mätte frånvaron av subagenter, inte
frånvaron av inspelning.

## Beviset att formatet är oförändrat

Två oberoende kontroller, båda på 2.1.278.

**Schemat i binären.** Claude Code bär sina egna zod-scheman för hook-payloaden:

```
SubagentStart: agent_id: string, agent_type: string
SubagentStop:  stop_hook_active, agent_id, agent_transcript_path,
               agent_type, last_assistant_message?
```

Båda fälten finns kvar, båda obligatoriska strängar. Samma namn, samma typer som
i 2.1.273.

**En levande subagent.** En trivial agent startades med kollektorn installerad:

```
SubagentStart   agent_id=<17 tecken>  agent_type="general-purpose"   inspelad
SubagentStop    samma identitet                                      inspelad
PreToolUse/PostToolUse inuti agenten, båda fälten satta              inspelade
PostToolUse/Agent med spawned_agent_id satt                          inspelad
kastade: 65 → 65 (oförändrat)
```

Sju agent-poster, noll kastningar. Parsern gör rätt på nuvarande Claude Code.

Notera ett nytt verktygsnamn i flödet, `SubagentHandback`, som agenten anropar när
den lämnar tillbaka. Det passerar `TOOL_NAME` utan problem, men tolkningen i
`src/view` känner inte till det.

## Var det slår

`src/collector/record.ts:132`:

```ts
const isAgentEvent = event === "SubagentStart" || event === "SubagentStop";
if (data.agent_id !== undefined || data.agent_type !== undefined || isAgentEvent) {
  if (!matches(data.agent_id, AGENT_ID) || !matches(data.agent_type, AGENT_TYPE))
    return { ok: false, reason: "agent" };
  record.agent_id = data.agent_id;
  record.agent_type = data.agent_type;
}
```

Båda fälten krävs så fort ettdera finns. Saknas det ena förkastas hela händelsen,
inte bara identiteten. En händelse som mycket väl hade kunnat sparas utan identitet
går förlorad i sin helhet.

Att fältet kan komma ensamt är inte en avvikelse — Claude Code dokumenterar det
själv, i bas-schemat för alla hook-payloads:

> `agent_id`: *"Present only when the hook fires from within a subagent. Absent for
> the main thread, even in --agent sessions. Use this field (not agent_type) to
> distinguish subagent calls from main-thread calls."*
>
> `agent_type`: *"Present when the hook fires from within a subagent (alongside
> agent_id), **or on the main thread of a session started with --agent (without
> agent_id)**."*

Det dokumenterade fallet `agent_type` utan `agent_id` räcker för att villkoret ska
kasta varje händelse i en sådan session.

## Grundorsaken

Fångad rå payload, 2.1.278:

```
SubagentStop  agent_id="aeb2dac0ae11aae38"  agent_type=""
```

`agent_type` saknas inte — den är tom. Det passerar Claude Codes eget schema, där
fältet bara är `string()`, men faller på `AGENT_TYPE`, som kräver minst ett tecken:

```
AGENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,79}$/
```

Utkastets andra hypotes var närmast — "bara det ena fältet skickas" — men fältet
skickas, tomt, vilket är en annan sak än `undefined` och kräver en annan fix.

**Det är Claude Codes interna agenter.** De skiljer sig från dem man startar själv:

```
SubagentStop utan föregående SubagentStart:
   a6df062579436d28e   agent_type=""                effort: ja
   aeb2dac0ae11aae38   agent_type=""                effort: ja

SubagentStop med SubagentStart:
   a2cf0ede396577c96   agent_type="general-purpose"  effort: nej
```

De fyrar alltså **bara** `SubagentStop`, aldrig `SubagentStart`, har ingen typ och
bär ett `effort`-fält. Det förklarar hela mönstret på en gång:

- varför kastningarna låg intill `Stop` — den interna agenten blir klar när turen gör det
- varför bara vissa sessioner drabbades — interna agenter körs inte i alla
- varför spike-korpusen från 2.1.273 var ren — den innehöll bara egenstartade agenter, med riktiga typer

**En fälla att känna till på vägen dit:** kollektorn är installerad globalt, så
`problems-*.jsonl` är en enda fil delad av alla Claude Code-sessioner på maskinen.
Vid mätningen körde fyra samtidigt. En kastning kan därför inte tillskrivas den
session man råkar titta på — ett första försök gav mönstret "mellan `Stop` och
nästa `UserPromptSubmit`", vilket bara speglade att den observerade sessionen stod
stilla medan en annan arbetade. Korrelerat snävt mot alla sessioner samtidigt låg
27 av 28 kastningar i stället intill ett `Stop`, vilket var ledtråden som höll.

## Fångsten, om den behövs igen

`spike/log-hook.mjs` registrerad via `.claude/settings.local.json` i repot, på
kollektorns tolv händelser, skrivande till `spike/events.jsonl`. Den laddas om i
pågående session — ingen omstart behövs. Det var så den råa payloaden ovan kom
fram.

Den är borttagen nu, eftersom den loggar början av prompter (kortat till 160
tecken). `spike/events.jsonl` ligger kvar som bevis och är gitignorerad.

## Åtgärdat

**Identiteten är nu valfri metadata.** Fälten valideras var för sig: det som
passerar sparas, det som inte gör det tas bort som fält, och händelsen skrivs
oavsett.

Vad som räknas som en förlust är skärpt efter fyndet ovan. Ett **saknat** fält och
ett **tomt** fält betyder båda "ingen identitet här", och är normalt — interna
agenter skickar tom `agent_type` varje tur, så att anmärka på det vore ett
falsklarm varje tur. Bara ett **ifyllt värde som inte går att använda** räknas, som
`agent_identity` i `problems-*.jsonl`: det är den form som säger att formatet
flyttat sig under oss.

Verifierat mot de 133 verkliga payloads som fångades:

```
133 av 133 sparade, 0 problem
   SubagentStop  agent_id="aeb2dac0…"                      sparad, ingen anmärkning
   SubagentStop  agent_id + agent_type="general-purpose"   sparad, ingen anmärkning
```

Samtliga interna `SubagentStop` hade tidigare gått förlorade i sin helhet.

**Statusraden säger det rakt ut.** "kastades eftersom formatet var okänt" var fel
på två sätt: formatet var inte okänt, och formuleringen fick läsaren att tro att
kärnfunktionen var död. Nu står det `N händelser kastades` med varningsikon *och
syns inte här*, medan oanvändbara identiteter redovisas separat som `N händelser
utan agentidentitet` — utan varningsikon, eftersom händelsen finns.

Ändrat: `src/collector/record.ts`, `src/collector/main.ts`, `src/model/reader.ts`,
`src/status/health.ts`, `src/extension.ts`, `src/view/webview/text.ts`.
81 unit-test och 20 e2e-test gröna.

**Driftsatt** med `npm run connect` (frånkoppling och anslutning, båda godkända med
planens hash). Kontrollsumman i `connection.json` stämmer mot filen på disk.
`hooks.json` blev byte-identisk med den gamla, så redan körande sessioner fick
fixen direkt, utan omstart.

## Kvar att göra

- `SubagentHandback` är ett verktygsnamn som tolkningen i `src/view` inte känner
  till. Det passerar `TOOL_NAME`, så inget kastas, men det syns som ett okänt anrop.
- Interna agenter har varken typ eller `SubagentStart`. Tolkningen bygger rader av
  start/stopp-par, så en ensam `SubagentStop` behöver en egen hantering.
- Överväg om `dropped > 0` ska vara ett fel snarare än en statusrad.

## Fotnot om hooks.json

Vid felsökning: lägg **inte** tillfälliga hooks i
`~/.claude/skills/subagent-watch/hooks/hooks.json`. Subagent-Watch checksummar
filen (`hooksSha256` i `~/.subagent-watch/connection.json`) och betraktar sig som
frånkopplad om den ändras. Detsamma gäller `collector.cjs` (`collectorSha256`).
Använd `.claude/settings.local.json` i repot.
