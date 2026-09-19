---
id: agent-handelser-kastas
status: done
created: 2026-09-19
updated: 2026-09-19
---

LÖST. Claude Codes interna agenter avslutar med SubagentStop där agent_type är en
tom sträng. Villkoret i parseHook krävde att båda identitetsfälten validerade, och
tom sträng faller på AGENT_TYPE — hela händelsen förkastades, intill varje turslut.
76 förlorade händelser.

Fix: fälten valideras var för sig, händelsen sparas oavsett. Saknat och tomt fält
räknas som normalt (interna agenter skickar tomt varje tur); bara ett ifyllt värde
som inte går att använda räknas som agent_identity. Statusradens vilseledande
"eftersom formatet var okänt" är omskriven. 101 test gröna. Driftsatt via
npm run connect, verifierat mot 133 verkliga payloads.

Rättelse mot den ursprungliga diagnosen: formatet hade INTE ändrats, och subagenter
spelades in korrekt. Nollorna berodde på att ingen subagent hade körts.

Kvar: SubagentHandback är okänt för tolkningen i src/view, och en ensam
SubagentStop utan SubagentStart behöver egen hantering där.
Se docs/fynd-agent-handelser-kastas.md.
