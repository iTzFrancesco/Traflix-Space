# Traflix Jarvis — Fase 8

## Conversational Agent Control & Handoffs

La Fase 8 rende Jarvis un'interfaccia conversazionale sopra Traflix Space.
Jarvis è reattivo: esegue una richiesta esplicita dell'utente quando il piano è
chiaro e chiede una decisione quando manca un'informazione sostanziale.
In termini di ownership è **reactive, not proactive**.

Jarvis non è un orchestratore autonomo. Non parla quando un agente termina, non
propone review, non apre agenti spontaneamente, non schedula catene future e non
continua un workflow senza una nuova richiesta dell'utente.

## Authority e scope

Ogni invocazione cattura `activeWorkspaceId` in `InvocationBinding`. Il backend
valida e mantiene quel vincolo per tutta la richiesta: discovery, letture,
spawn, scritture e handoff non attraversano implicitamente altre workspace.

Il modello produce soltanto un `ConversationalPlan` typed. Le operazioni sono
allowlisted (`respond`, `clarify`, `agent_report`, `agent_send`, `agent_open`,
`agent_handoff`, `agent_abort`, `terminal_close`, `terminal_restart`,
`draft_prompt`). Il backend valida provider, testo, target, workspace,
generation, liveness e identità prima di ogni effetto. Il modello non può
generare shell command arbitrari. Il backend accetta al massimo un piano
conversazionale side-effecting per turno del modello: eventuali tool call
successive nello stesso response non possono eseguire una seconda mutazione.

Le normali richieste esplicite sono authorization per la mutazione richiesta:
non compare una Pending Action card. Le ambiguità, il provider mancante, un
agente pertinente occupato e le operazioni distruttive contro sessioni working
producono una domanda nella normale conversazione. Lo stato pending è bounded,
workspace-scoped, cancellabile e non persistente. Una clarification o una
confirmation è un confine duro: nessuna operazione successiva dello stesso
piano viene eseguita finché l'utente non risponde. Le risposte brevi come
`"sì"`, `"usa quello"` o il nome del provider possono continuare l'intento
pending senza perdere il task originale; le conferme distruttive restano legate
all'esatto `terminalId + generation`.

## Discovery e target resolution

Prima di agire Jarvis usa il registry Fase 7, poi il titolo del terminale, il
task corrente e l'ultimo risultato. Il titolo è read-only e user-controlled,
ma è un segnale semantico valido per distinguere sessioni dello stesso
provider. Solo se questi segnali non bastano viene letto un tail bounded.
Jarvis non sceglie casualmente: un pareggio produce una domanda breve. Una
sessione storica non può essere associata a una generation corrente solo perché
riusa lo stesso terminal ID.

`agent.tail` restituisce al massimo 100 righe e 12 KiB, con default di 40 righe,
`untrusted=true` e provenance esplicita. Non legge l'intero scrollback, non
persiste il tail e non usa automaticamente il codice sorgente. Le letture
interne del tail ricontrollano workspace e generation prima di usare l'output.
Il Context Broker può fornire documentazione Markdown consentita, summary
workspace, registry, task e risultati bounded.

## PTY visibile e catalogo agenti

Il catalogo typed runtime supporta soltanto i provider conosciuti dal percorso
Jarvis: Codex, OpenCode, Pi, Freebuff e Claude Code. Non esiste network
discovery e non è previsto provider fallback silenzioso.

`agent.open` verifica la workspace, crea un normale terminale Traflix visibile,
avvia il comando del catalogo nella stessa PTY, aspetta una readiness bounded e
invia l'initial prompt nella stessa sessione soltanto dopo che la TUI è stata
dimostrata pronta. Il frontend registra la sessione tramite l'evento backend e
marca la PTY e il provider come già avviati dal backend, evitando che il normale
launcher del pane avvii una seconda copia dello stesso CLI. Il restart riusa lo
stesso pane visibile e riannuncia il runtime al frontend. Non vengono usati
`codex app-server`, `opencode serve` o server provider nascosti.

L'invio diretto e gli handoff usano `terminal_write` sulla PTY visibile e
registrano `observe_jarvis_send` solo dopo una scrittura riuscita. Un fallimento
ferma la catena corrente; non viene scelto un altro provider e non viene fatto
fallback creativo.

## Handoff e output

Un handoff preferisce `last_result`; usa il tail solo se necessario. Jarvis
sintetizza un prompt compatto e autosufficiente entro il budget previsto di
contesto derivato. Non trasferisce thinking o raw output completo e non
scansiona automaticamente il codice sorgente. Il destinatario può usare i
propri tool nella workspace.

## Checkpoint e risposta

I checkpoint sono effimeri e compaiono solo mentre Jarvis gestisce la richiesta:
`Checking agents…`, `Reading Codex…`, `Opening OpenCode…`, `Waiting for
OpenCode…`, `Preparing message…`, `Writing to OpenCode…`, `Done.`. Quando Jarvis
è inattivo la superficie compatta resta `Ready when you are`, anche se gli
agenti continuano a lavorare.

Le risposte sono brevi e voice-friendly. Un task semplice normalmente produce
una frase; report e failure restano compatti. Dopo `Fai implementare X a Codex`
Jarvis termina: un eventuale handoff successivo richiede una nuova richiesta.

## Validazione

Il repository contiene test/backend assertions per piani typed, isolamento
workspace, target resolution, busy clarification, tail bounded e regressioni
frontend/Jarvis. **La presenza dei test non equivale però a una suite completa
eseguita con successo.** Durante la validazione della Fase 8 sulla VPS lo spazio
disco è terminato prima di poter completare tutti i comandi previsti. In questa
review successiva non è disponibile un output completo e verificabile di
`cargo check`, `cargo test`, `npm run test:jarvis` e typecheck sul nuovo HEAD;
GitHub non espone inoltre status CI per il branch. Questi controlli restano
quindi **PENDING / da rieseguire quando c'è spazio sufficiente**, senza
considerarli implicitamente passati.

La review statica successiva ha corretto guardrail di lifecycle/routing,
correlazione per generation e doppio launch frontend/backend, ma non sostituisce
l'esecuzione delle suite.

La validazione Windows è ancora **PENDING** e non viene dichiarata superata.
Vedere [PHASE-8-WINDOWS-VALIDATION.md](./PHASE-8-WINDOWS-VALIDATION.md).