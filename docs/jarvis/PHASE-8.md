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
un transcript drawer o una chat aperta durante l'uso vocale normale. I vecchi
componenti frontend del drawer testuale, transcript card, agent list e Pending
Action card sono stati rimossi dal tree: non sono semplicemente nascosti via
CSS. I contratti backend legacy necessari alla compatibilità restano separati
dalla UI normale.

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
microfono, voce TTS e tuning/diagnostica avanzata. Il tuning del turno
espone la sensibilità VAD e `vadPostSpeechMs` (silenzio prima dell'invio), non il
vecchio timeout di attesa del VAD armato. Le API key vengono salvate fuori da
`settings.json`; il frontend riceve solo lo stato configurata/non configurata.
Il backend normalizza inoltre gli eventuali spazi di copia/incolla ai bordi
della chiave e rifiuta valori vuoti, multilinea, NUL o oltre il limite.

Un transcript vocale rimane sempre legato alla workspace nella quale è stato
registrato. Se l'utente cambia workspace durante la trascrizione, Jarvis non lo
invia alla workspace nuova. Quando la workspace originale torna in focus il
draft può riprendere automaticamente, ma solo se Jarvis è abilitato e la chat
di quella workspace è libera. Il resume è deduplicato per `requestId` e ritenta
quando una richiesta concorrente termina; Jarvis nascosto non produce invii
invisibili.

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
Jarvis: Codex, OpenCode, Pi, Freebuff, Claude Code e Claudex. Non esiste network
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

Anche il launcher frontend dei terminali configurati manualmente è bounded: la
coda deduplica per terminale, prova al massimo due scritture e ripristina
`agentLaunched=false` se la PTY write non riesce. Questo evita uno stato falso
"agente lanciato" che impedirebbe un recovery successivo. Il percorso Jarvis
resta separato e autorevole perché il backend ha già lanciato il provider prima
di emettere `jarvis-agent-opened`.

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

Lo stato desktop persistito viene normalizzato in fase di hydration: le
larghezze sidebar/right-panel vengono ricondotte ai limiti supportati e vecchie
right-panel view non più esistenti vengono scartate. Anche i preset workspace
legacy vengono normalizzati prima dell'uso (1–8 terminali, conteggi agenti
bounded). In questo modo l'upgrade non richiede localStorage pulito.

La cache frontend delle workspace è solo una cache di configurazione, non il
proprietario delle PTY. L'eviction LRU non termina più terminali o agenti vivi.
Il candidato viene deciso con la workspace attiva al momento effettivo del
commit di stato, quindi un load asincrono non può espellere una workspace che
nel frattempo è diventata attiva. Se per churn una config attiva manca dalla
cache, il loader la ricostruisce automaticamente dalla registry backend e la
PTY esistente viene reidratata. Anche un load completato in ritardo può popolare
la cache, ma non può rubare `activeTerminalId` alla workspace ora in focus.

I modal condivisi applicano focus trap, Esc e restore focus. Toast di
success/info e warning/error espongono semantica `status`/`alert` senza una
seconda live region duplicata.

Nel pannello Git lo stesso path può comparire sia in `Staged` sia in `Changes`:
la selezione conserva esplicitamente il lato del diff, quindi una riga staged
non apre per errore il worktree diff. Draft del commit, selezione lato e conferme
distruttive `Discard` vengono azzerati al cambio workspace per evitare che una
conferma aperta in A venga applicata in B.

## Guardrail di regressione

`npm run test:jarvis` include sia i test Jarvis esistenti sia
`scripts/ui-regression.test.mjs`. I guardrail statici verificano, tra l'altro,
che il vecchio drawer non venga reintrodotto, che il widget non riacquisti il
wiring morto, che modal e storage migration restino presenti, che il tuning
voice-first continui a usare `vadPostSpeechMs`, che i draft vocali riprendano
solo nella workspace corretta, che l'LRU non uccida PTY e che i lati Git
staged/worktree restino distinti.

La presenza di questi test nel repository **non significa che siano stati
eseguiti con successo sull'HEAD corrente**.

## Validazione

La review corrente usa review statica e test mirati disponibili nel repository,
senza usare GitHub CI/CD come loop di sviluppo. Il workflow automatico del
branch non è attivo; la build MSI resta manuale. Sull'HEAD corrente GitHub non
fornisce status CI utilizzabili come prova di validazione.

Sono stati ricontrollati staticamente i percorsi critici della Fase 8: binding
workspace/generation, risoluzione target, hard boundary delle clarification,
doppio launch frontend/backend, VAD/auto-stop, auto-submit transcript, recovery
cross-workspace dei draft, TTS, owner-mode settings, secret persistence, wiring
del widget, launcher frontend degli agenti, lifecycle/cache delle PTY e
migrazione dello stato UI persistito.

Non è disponibile un output completo e verificabile dell'HEAD corrente per
`npm run test:jarvis`, `npm run build`/TypeScript, `cargo check` o `cargo test`.
Questi controlli restano **PENDING** e non vengono considerati implicitamente
passati.

Questa review statica non sostituisce l'esecuzione reale su Windows. La
validazione end-to-end del microfono, cue audio, Groq, OpenCode Zen, Edge TTS,
WebView2 e delle PTY condivise resta **PENDING** finché il branch aggiornato non
viene eseguito sulla macchina Windows reale.

Vedere [PHASE-8-WINDOWS-VALIDATION.md](./PHASE-8-WINDOWS-VALIDATION.md).
