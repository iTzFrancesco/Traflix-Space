# Traflix Jarvis — Fase 8

## Conversational Agent Control & Handoffs

La Fase 8 rende Jarvis un'interfaccia conversazionale sopra Traflix Space.
Jarvis è reattivo: esegue una richiesta esplicita dell'utente quando il piano è
chiaro e chiede una decisione quando manca un'informazione sostanziale. In
termini di ownership è **reactive, not proactive**.

Jarvis non è un orchestratore autonomo. Non parla quando un agente termina, non
propone review, non apre agenti spontaneamente, non schedula catene future e non
continua un workflow senza una nuova richiesta dell'utente.

## UX voice-first

La superficie normale di Jarvis è un'unica barra compatta flottante. Non esiste
un transcript drawer o una chat aperta durante l'uso vocale normale.

Il percorso primario è:

`click microfono → Listening… → silenzio naturale → Transcribing… → Thinking… → azione → Speaking… → Ready when you are`

Il click sul microfono avvia un turno. Il VAD locale rileva l'inizio del parlato
e la pausa di fine frase, ferma la registrazione e avvia automaticamente la
trascrizione. La trascrizione pronta viene inviata automaticamente al motore
conversazionale e la risposta viene letta con Edge TTS. Non esistono pulsanti
"trascrivi" o "invia alla chat" nel percorso normale.

L'inizio e la fine dell'ascolto hanno un breve cue audio locale. Durante
l'ascolto la barra cambia stato e mostra un meter legato al livello del
microfono. Il controllo attivo diventa uno stop esplicito, utile solo quando
l'utente vuole chiudere il turno prima del VAD.

Il widget si sposta soltanto con pressione prolungata seguita da movimento. Un
click o un piccolo movimento involontario non modifica la posizione.

Traflix Space è un'app desktop privata usata dal proprietario. I legacy consent
fields rimangono nello schema Rust per compatibilità, ma sono invarianti
interne: input vocale, invio automatico, VAD, modello e output vocale vengono
normalizzati in owner mode e non sono presentati come gate privacy nella UI.

Le Settings espongono soltanto configurazione utile: OpenCode Zen, Groq,
microfono, voce TTS, hotkey e tuning/diagnostica avanzata. Le API key vengono
salvate fuori da `settings.json`; il frontend riceve solo lo stato
configurata/non configurata.

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

## Desktop UI rework

Il frontend della Fase 8 usa una shell desktop compatta e gerarchica: sidebar,
workspace identity bar, terminal grid e right panel. I terminali restano il
contenuto dominante. Le superfici secondarie (Browser, Skills, Settings, wizard
nuovo workspace, modal e toast) usano gli stessi token, bordi sottili e controlli
compatti, evitando gradienti decorativi, card annidate, glow e pill non
necessarie.

## Validazione

La review corrente usa validazione mirata e review statica invece di usare
GitHub CI/CD come loop di sviluppo. I workflow automatici sulle pull request
sono stati disattivati e la build MSI è manuale, così failure infrastrutturali
non vengono confuse con regressioni del prodotto.

Sono stati ricontrollati staticamente i percorsi critici della Fase 8: binding
workspace/generation, risoluzione target, hard boundary delle clarification,
doppio launch frontend/backend, VAD/auto-stop, auto-submit transcript, TTS,
owner-mode settings e secret persistence. La UI normale non monta più il vecchio
pannello chat/transcript.

Questa review statica non sostituisce l'esecuzione reale su Windows. La
validazione end-to-end del microfono, cue audio, Groq, OpenCode Zen, Edge TTS,
WebView2 e delle PTY condivise resta **PENDING** finché il branch aggiornato non
viene eseguito sulla macchina Windows reale.

Vedere [PHASE-8-WINDOWS-VALIDATION.md](./PHASE-8-WINDOWS-VALIDATION.md).
