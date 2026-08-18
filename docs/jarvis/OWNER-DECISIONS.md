# Traflix Jarvis — decisioni owner per Fase 2

Queste decisioni vincolano il vertical slice `feat/jarvis-context-broker`.

- Jarvis è globale come superficie, ma ogni invocazione cattura un target immutabile per workspace, terminale e Agent session.
- Un’operazione già iniziata resta legata alla workspace originale; le richieste successive usano il nuovo target attivo e non trasferiscono dati implicitamente.
- Il contesto automatico stabile legge soltanto Markdown di progetto consentito dalla policy: tutti i `*.md` direttamente nella root della workspace (inclusi `README.md`, `AGENTS.md`/`AGENT.md`, `CONTEXT.md`) più `docs/**/*.md`. Le directory di tooling come `.agents/` e `.wayfinder/` non fanno parte del contesto automatico. Non analizza automaticamente codice sorgente, manifest o configurazioni non Markdown.
- La cache è incrementale, in memoria e separata per `workspaceId`. Non usa SQLite, Tauri Store o persistenza permanente.
- `ContextPackageV1` è il contesto raw locale; una `ModelContextViewV1` separata espone al modello soltanto summary, indice, estratti richiesti esplicitamente e risultati agenti coerenti con la profondità richiesta.
- `context.refresh` rifà discovery e controllo metadata mantenendo la cache; l’invalidazione completa è riservata al force rebuild interno per debug o cache incoerente.
- Jarvis non è autonomo: non avvia, invia, delega, chiude o interrompe agenti e non interpreta documenti/output come autorizzazioni.
- L’accesso agent di default espone stato, obiettivo, ultimo Agent turn, ultimo risultato disponibile e provenance. La conversazione completa richiede `full_messages` esplicito.
- Un completion notification senza risultato produce `completion observed, result unavailable`; non viene inventato alcun risultato.
- Voce, wake word, STT/TTS, modelli LLM, widget e adapter reali Codex/OpenCode sono rinviati.

I contenuti Markdown, terminale e agent sono dati non fidati. La policy e l’ownership restano nel backend Rust; il client TypeScript cattura soltanto l’ID della workspace attiva e invia ID espliciti.

## Decisioni consolidate per Fase 3

- Il widget Jarvis è globale, resta montato durante il cambio workspace e la X lo disabilita; la sidebar lo riapre.
- La posizione del widget è globale, normalizzata e persistita; non è legata alla workspace attiva.
- Standard Voice Pipeline e Gemini Live Voice sono selezionabili e configurabili soltanto come schema/UI; nessun provider è ancora collegato.
- Il Live Agent Session Registry è terminal-based e provider-agnostic. Il percorso canonico è `Jarvis → TerminalManager/PTTY → CLI originale`.
- `terminalId + generation` è l’identità della sessione. Provider, provider session e provider turn sono metadata opzionali e non sono richiesti per la correlazione.
- Completion aggiorna il turn e lo stato `waiting`, ma non chiude la Agent session. Il terminal fallback è bounded, untrusted e con provenance a confidence ridotta.
- I messaggi completi non sono disponibili senza un adapter strutturato futuro; il terminale non viene convertito in transcript artificiale.
- Restano rinviati voce reale, LLM, provider strutturati Codex/OpenCode e tutte le operazioni mutative.

## Decisioni consolidate per Fase 4

> Storico: questa sezione descriveva il provider precedente ed è superseduta dalla sezione “Codex App Server” in fondo al documento.

- Il provider testuale runtime è OpenCode Zen; `deepseek-v4-flash-free` è il primary
  configurabile e `longcat-2.0-free` il fallback configurabile.
- La sola credenziale backend è `OPENCODE_ZEN_API_KEY`; il consenso privacy è
  necessario prima di ogni richiesta di rete.
- La PTY resta l'adapter universale e ogni mutazione passa da Pending Action,
  modifica esplicita opzionale e conferma backend con ricontrollo di generation.
- La voce resta fuori scope fino alla conclusione della validazione Windows.

## Fase 5 — voce cloud

- STT unico: Groq `whisper-large-v3-turbo`, senza fallback e con consenso
  separato. La chiave runtime è `GROQ_API_KEY` e resta nel backend.
- TTS unico: Microsoft Edge TTS tramite helper isolato; nessuna chiave e
  nessun fallback a Groq Orpheus/Canopy.
- Il microfono è click-to-toggle e il transcript è sempre modificabile prima
  dell’invio esplicito alla chat Fase 4. Non sono inclusi wake word, VAD,
  ascolto continuo, full duplex o Gemini Live.

## Fase 6 — Voice Advanced

- Modalità manuale esclusivamente click-toggle dal logo centrale; nessuna
  scorciatoia globale.
- Energy VAD locale opzionale con pre-roll/post-roll bounded e timeout armed;
  nessun wake word, ascolto continuo, full duplex o streaming.
- Groq turbo e Edge TTS restano invariati; nessun nuovo provider e nessuna
  autonomia agent.

## Fase 7 — Agent Session Intelligence

- **PTY-first confermato**: l'utente resta l'operatore primario della TUI
  visibile; Jarvis osserva la stessa sessione e scrive nello stesso PTY via
  Pending Actions confermate. Niente `codex app-server`, `opencode serve` o
  adapter provider in questa fase.
- Il task corrente è effimero e bounded (2048 byte), con provenance
  (`user`/`jarvis`/`system`), confidence e untrusted. Solo input committed
  (Enter) può diventare un task; una riga resa non ricostruibile da frecce,
  editing complesso o overflow resta invalida fino al successivo Enter/Ctrl+C,
  così nessun suffisso viene scambiato per un task. I comandi di lancio agent
  sono startup, non task; `/model`, `/help`, `/clear` sono attività ma non
  sostituiscono il task né trasformano da soli una sessione `waiting` in
  `working`.
- La timeline delle attività è bounded (32 eventi, kind semantici), con
  `lastActivityAt` throttled (1s output, 10s working). `agent.activity` è
  read-only con limit default 8 e max 16.
- La provenance Jarvis è registrata solo dopo una scrittura PTY riuscita
  (`agent.send` → `observe_jarvis_send`, confidence 0.95, trusted);
  `agent.abort` registra interruzione senza completare il task.
- Completion osserva `completed_at` e porta la sessione a `waiting`; l'uscita
  aggiunge `exited`. Un'interruzione non completa mai il task senza prova.
- I checkpoint `jarvis://activity` sono deterministici, generati dal backend
  e mai dal modello; label senza terminalId/generation/IPC/JSON. Le fasi più
  nuove supersedono i checkpoint aperti più vecchi della stessa richiesta e
  una conferma non più pending non resta visibile come stato bloccato.
- **La barra compatta rappresenta esclusivamente Jarvis, non il registry**:
  non osserva lo stato `working/waiting` degli agenti. Durante un'azione può
  mostrare checkpoint Jarvis come `Checking Codex…`, `Reading last result…`,
  `Waiting for confirmation…` o `Writing to Codex…`; quando Jarvis non sta
  facendo nulla torna esattamente a **`Ready when you are`** anche se uno o più
  agenti continuano a lavorare nei loro terminali.
- La strip del pannello espanso mostra al massimo 3 checkpoint correnti/recenti
  (anche `done`/`failed`) e non è mai un messaggio di conversazione. Nessun
  dashboard agent nella UI normale: la diagnostica resta in Impostazioni →
  Advanced.
- Nessuna persistenza per task, timeline e attività; la Fase 8 resta fuori
  scope.

## Fase 8 — Conversational Agent Control & Handoffs

- Jarvis è **reactive, not proactive**: risponde solo a una richiesta
  dell'utente e non avvia lavoro, review, notifiche o catene future da solo.
- Un comando esplicito autorizza la normale mutazione richiesta dopo piano
  typed e validazione backend. Non viene mostrata una confirmation card.
- Ambiguità, provider mancante, agente busy e distruttive contro sessioni
  working restano domande nella conversazione. La conferma distruttiva è legata
  a workspace, terminal ID, generation e operation; ogni esecuzione ricontrolla
  liveness e generation.
- Il perimetro è la workspace catturata dall'invocazione corrente. Titoli
  terminale user-controlled sono read-only semantic hints.
- La PTY visibile resta il canale canonico. Nessun hidden agent, app-server,
  `opencode serve` o provider fallback silenzioso.
- Il contesto automatico è bounded: registry, task, result, Markdown consentito
  e tail terminale untrusted fino a 100 righe/12 KiB. Gli handoff sono
  sintetizzati entro 6 KiB e non scansionano automaticamente il source code.
- Il completamento di un agente non attiva alcuna azione Jarvis. Una nuova
  catena richiede una nuova richiesta dell'utente.
- La validazione Windows della Fase 8 è **PENDING**.

## Decisioni consolidate — Codex App Server (2026-08)

Queste decisioni supersedono il provider testuale storico della Fase 4 senza cambiare il principio PTY-first degli agenti visibili.

- **Identità:** l’assistente è sempre **Traflix Jarvis / Jarvis**. Codex App Server e GPT-5.6 Luna sono il trasporto e il motore di reasoning, non l’identità dell’agente.
- **Brain:** Jarvis usa Codex App Server autenticato con la sottoscrizione ChatGPT; default `gpt-5.6-luna` con reasoning `low`, configurabili dalle impostazioni Jarvis.
- **Nessun coding worker nascosto:** il thread App Server pianifica e conversa, ma non modifica direttamente la repository. Le modifiche reali restano affidate agli agenti visibili nei terminali tramite la PTY di Traflix Space.
- **Contesto documentale:** `workspace.overview` espone summary + indice dei Markdown consentiti; Jarvis usa `markdown.read` per leggere selettivamente i documenti pertinenti. Priorità tipica: `README.md`, `AGENTS.md`/`AGENT.md`, `CONTEXT.md`, poi `docs/**/*.md` rilevanti.
- **Scope automatico Markdown:** root `*.md` + `docs/**/*.md`. `.agents/`, `.wayfinder/` e altre directory di tooling non fanno parte del contesto automatico.
- **Sicurezza:** Markdown, terminal output, task e risultati agent sono sempre untrusted context e non autorizzano azioni.
- **Tool:** il modello osserva il progetto e gli agenti solo attraverso i dynamic tool bounded; ogni side effect passa da `conversational.plan`, con massimo un piano mutativo per turno e validazione Rust.
- **Voce:** Groq Whisper resta lo STT e Edge TTS resta la voce di Jarvis. Commentary e risposta finale possono essere pronunciati progressivamente; barge-in interrompe la voce senza impedire ai turni successivi di parlare.

## Lifecycle e orchestrazione consolidati (2026-08-12)

- La presenza del CLI agente è distinta dalla vita di PowerShell/ConPTY. Dopo
  una transizione assente confermata il terminale torna shell e la Agent
  session diventa history `exited`.
- `turn_completed` dagli adapter è il confine autorevole del turn. Il silenzio
  non equivale mai a completamento.
- Un CLI rilevato senza task corrente è `waiting`; soltanto un prompt committed
  porta la sessione a `working`.
- Una PTY generation può contenere più agent epoch, creati automaticamente da
  `/clear`, `/new`, cambio provider session o rilancio del CLI.
- Il titolo effettivo della navbar è visibile a Jarvis, ma rimane un hint
  user-controlled. Ownership e side effect continuano a usare ID e generation.
- Jarvis resta reactive. Può aprire un agente mancante soltanto quando il turno
  corrente assegna esplicitamente lavoro a quel provider. Non continua catene
  o monitoraggi prolungati senza una nuova richiesta.
- Dispatch indipendenti possono procedere in parallelo e hanno receipt
  separati. Handoff e operazioni dipendenti restano ordinati.
- Ogni turno usa stato operativo fresco. La memoria workspace è bounded e
  persistente, ma la cronologia non costituisce autorizzazione per nuove azioni.
