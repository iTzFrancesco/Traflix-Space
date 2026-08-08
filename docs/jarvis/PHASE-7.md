# Traflix Jarvis — Fase 7

La Fase 7 aggiunge l'intelligenza della sessione agente e la UX di
collaborazione sopra il registry terminal-based della Fase 3 e la chat Fase 4.
Jarvis resta un collaboratore che osserva la stessa TUI visibile all'utente e
continua a scrivere nel PTY condiviso tramite Pending Actions confermate: non
esistono sessioni agent nascoste o parallele, nessun `codex app-server`, nessun
`opencode serve` e nessun adapter provider in questa fase.

## 1. Principi architetturali

- **PTY-first**: l'utente resta l'operatore primario. Jarvis osserva la stessa
  TUI (Codex, OpenCode, Pi, Freebuff…) e non crea sessioni agent invisibili.
- **Provenance sincera**: ogni task registrato ha `source` (`user`, `jarvis`,
  `system`), `confidence` e `untrusted`. Un task di Jarvis viene registrato
  soltanto DOPO una scrittura PTY riuscita; una ricostruzione non affidabile
  non produce mai un task inventato.
- **Nessuna persistenza**: task, timeline e attività sono effimeri in memoria;
  nessun nuovo file su disco.

## 2. Task tracking

- Ogni sessione ha al più un `current_task` con testo bounded a 2048 byte,
  sorgente, inizio, eventuale completamento, confidence e flag untrusted.
- L'InputTracker ricostruisce soltanto la riga di input corrente per
  `(terminalId, generation)`: caratteri UTF-8 stampabili, backspace, Enter
  (commit), bracketed paste (`\x1b[200~` … `\x1b[201~`), Ctrl+C e Delete
  (`\x1b[3~`). Frecce, Home/End, sequenze Alt, altri controlli non
  ricostruibili e buffer oltre 8 KiB invalidano l'intera riga fino al
  successivo Enter/Ctrl+C: non si riprende mai a raccogliere un suffisso che
  potrebbe diventare un task falso.
- Solo l'input committed (Enter) diventa un task. Output del terminale non
  raggiunge mai il tracker. I comandi di lancio agent (rilevati da
  `detect_from_command`) sono startup della sessione, non task.
- I comandi locali `/model`, `/help`, `/clear` diventano attività ma non
  sostituiscono mai il task corrente e non cambiano da soli `waiting` in
  `working`.

## 3. Timeline delle attività

- Timeline bounded a 32 eventi per sessione. Ogni evento ha kind
  (`prompt_submitted`, `working`, `completion_observed`, `result_available`,
  `interrupted`, `exited`), source, timestamp, excerpt bounded, confidence e
  untrusted.
- L'osservazione dell'output aggiorna `lastActivityAt` con throttle di 1s;
  un'attività `working` richiede un gap di almeno 10s dalla precedente.
- `agent.activity` (read-only, limit default 8, max 16) espone la timeline
  bounded al modello; nessun testo grezzo di scrollback.
- La panoramica agenti nel Context Package è compatta: al massimo le 8
  sessioni più recenti e un budget serializzato di 6 KiB; le sessioni più
  vecchie restano nel registry per identità e riconciliazione ma non
  raggiungono il modello.

## 4. Semantica di completamento

- Un completion osservato imposta `completed_at` sul task corrente, porta la
  sessione a `waiting` e aggiunge `completion_observed` (+ `result_available`
  se presente un risultato). Non chiude la sessione.
- L'uscita del processo aggiunge `exited` e stato `exited`.
- Un'interruzione (Ctrl+C utente o `agent.abort` confermato) registra
  `interrupted` ma NON completa mai il task senza prova.

## 5. Provenance Jarvis

- `agent.send` confermato usa `write_typed(…, JarvisPrompt)`; dopo il
  successo, il backend registra `observe_jarvis_send` (source `jarvis`,
  confidence 0.95, trusted). Generazione cambiata, terminale morto, rifiuto o
  scrittura fallita → nessuna registrazione.
- `agent.abort` confermato usa `write_typed(…, JarvisAbort)` e poi
  `observe_abort` (interruzione, task non completato).

## 6. Checkpoint `jarvis://activity`

- Il backend emette checkpoint deterministici intorno ai tool e alle scritture
  (`checking_agents`, `checking_agent`, `reading_result`, `reading_activity`,
  `preparing_message`, `waiting_confirmation`, `writing`, `interrupting`,
  `sent`). Le label sono leggibili e non contengono mai terminalId, generation,
  IPC o JSON.
- Gli eventi sono generati dal backend, mai dal modello, e non sono persistiti.
- Una fase nuova supersede i checkpoint aperti più vecchi della stessa
  richiesta. Un `waiting_confirmation` è considerato attivo solo finché esiste
  davvero la corrispondente Pending Action, così rifiuto/conferma non possono
  lasciare la UI bloccata su uno stato stale.

## 7. Widget collassato

La barra compatta rappresenta **Jarvis**, non il registry degli agenti. Non
legge lo stato `working`, `waiting` o `starting` per decidere il testo mostrato:
un Codex può lavorare per minuti mentre Jarvis resta semplicemente disponibile.

Priorità: errore voce → nessuna workspace → voce → checkpoint Jarvis →
conferma richiesta → Jarvis thinking → TTS → idle.

L'idle è esattamente:

`Ready when you are`

Durante il lavoro può mostrare label deterministiche come `Checking Codex…`,
`Reading last result…`, `Preparing message…`, `Waiting for confirmation…`,
`Writing to Codex…`, poi torna all'idle. Nessun nome/conteggio agente viene
mostrato come monitoraggio persistente.

## 8. Pannello espanso

- Strip attività effimera con al massimo 3 checkpoint correnti/recenti sopra
  la conversazione. Può mostrare anche un recente `done`/`failed` (es. `✓ Sent.`)
  ma non è un log persistente.
- I checkpoint non diventano messaggi della conversazione.

## 9. Diagnostica

- Nessun dashboard agent nella UI normale. Il pannello Advanced resta visibile
  solo in Impostazioni → Advanced.

## 10. Fuori scope

- `codex app-server`, `opencode serve`, adapter provider strutturati,
  persistenza, dashboard agent nella UI normale, autonomia agent e Fase 8.
