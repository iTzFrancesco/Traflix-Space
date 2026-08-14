# Jarvis: invio prompt e lifecycle del turn

## Sintomo e causa

Il blocco osservato era una combinazione di due lifecycle locali che potevano
divergere dallo stato reale del provider:

1. Un checkpoint `writing` veniva emesso come `Running` anche dopo che la
   scrittura nel PTY era terminata. Per gli agenti avviati tramite PTY non
   esiste un evento provider-level affidabile equivalente a `turn/started`,
   quindi quel checkpoint poteva rimanere aperto per sempre quando il provider
   non produceva output o l'audio era muto. La receipt restava correttamente
   `submission_unconfirmed`, ma la barra UI la trattava come elaborazione viva.
2. Una shell PowerShell/ConPTY poteva restare viva dopo la terminazione del
   processo figlio dell'agente. Il vecchio controllo vedeva la shell viva e
   riutilizzava un binding con generazione/sessione non più valido: il prompt
   veniva quindi indirizzato a un runtime inattivo o non più associato.

L'apertura delle Impostazioni non era una soluzione: monta una superficie UI
che richiama bootstrap e refresh dei thread e cambia il timing delle
subscription/render. Questo poteva chiudere o mascherare la race, ma il
dispatch non deve dipenderne.

## Correzione

- `TerminalAgentSnapshot` distingue `process_alive` della shell da
  `agent_process_alive` del processo provider. Il valore `None` conserva il
  comportamento retrocompatibile quando l'osservatore non ha ancora dati.
- Prima di un `agent_send` viene validata l'identità esatta
  workspace/terminale/generazione/processo e viene aggiornato il rilevamento
  del processo figlio. Un binding stale o un provider osservato come assente
  riapre lo stesso terminale visibile, attende `wait_until_ready` e invia il
  prompt solo al nuovo runtime. Il vecchio binding non viene riusato dopo la
  riattivazione.
- Dopo una scrittura PTY riuscita, il checkpoint locale `writing` è `Done`.
  La receipt rimane `pty_write_accepted`, `prompt_submitted`,
  `submission_unconfirmed`: non viene inventato un `turn_started` che il PTY
  non può confermare.
- `ThreadRegistry::clear_active_turn` è idempotente e accetta l'id atteso del
  turn. Cancel, timeout e perdita del waiter ripuliscono anche la mappa dei
  request id. Una notifica terminale in ritardo con un turn id diverso non può
  chiudere un turn più recente; payload vecchi senza id mantengono la semantica
  precedente.
- Il timeout esterno di `jarvis_chat` interrompe best-effort il turn App Server
  prima di restituire l'errore e pubblica un checkpoint `Failed`, così le fasi
  aperte non lasciano la barra in stato `Running`.

## Scenari coperti

| Scenario | Comportamento atteso |
| --- | --- |
| Sessione nuova | Spawn PTY, launch provider, readiness, prompt automatico. |
| Sessione esistente attiva | Verifica dell'identità; invio sullo stesso PTY. |
| Sessione inattiva con figlio assente | Rilevamento `Some(false)`, restart del runtime e nuovo binding. |
| Sessione longeva con binding stale | Nessun write sul vecchio binding; riattivazione e readiness prima dell'invio. |
| Invio forzato/manuale | Stesso percorso validato, senza dipendenza dal pannello Impostazioni. |
| Nessun output o utente muto | La scrittura termina localmente; la barra non resta busy indefinitamente. |
| Cancel/timeout | Interrupt best-effort, cleanup locale e stato terminale `Failed`/cancelled. |
| Evento duplicato o tardivo | Cleanup idempotente; un evento vecchio non chiude un turn nuovo. |

## Test e verifica

- `npm run test:jarvis`: test statici e di stato per invio PTY, sessioni nuove,
  sessioni stale/inattive, cleanup, eventi tardivi e compatibilità dei payload.
- `rustfmt --check` è stato eseguito sui file Rust interessati.
- La compilazione/test Rust nativa va eseguita nell'ambiente Windows con la
  toolchain disponibile. Se il test binary non parte con
  `STATUS_ENTRYPOINT_NOT_FOUND`, il limite è dell'ambiente/runtime Windows e
  non un fallimento di asserzioni del codice.
- Non è stato eseguito un collaudo contro un Codex App Server di produzione:
  la verifica end-to-end disponibile in repository è quindi statica/unitaria;
  resta da validare il caso con il processo App Server reale e il relativo
  audio/TTS.

## Limiti residui

`submission_unconfirmed` descrive intenzionalmente una scrittura accettata dal
PTY, non la conferma che il provider abbia iniziato il turn. Se il provider è
irraggiungibile, la UI non resta bloccata, ma l'utente può ricevere una receipt
di consegna non confermata. Un App Server realmente corrotto o bloccato può
richiedere il normale restart del runtime; il cleanup locale evita comunque
che il solo stato UI impedisca i tentativi successivi.
