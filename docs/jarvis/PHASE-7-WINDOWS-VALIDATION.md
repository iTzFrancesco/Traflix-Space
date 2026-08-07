# Fase 7 — checklist Windows

Questa checklist **non è stata eseguita** nell'ambiente corrente.

**Stato owner (2026-08-07): PENDING.** La validazione manuale Windows non è
attualmente eseguibile. La review statica della Fase 7 è stata completata sul
branch remoto, ma questa pagina non certifica né test hardware Windows né
l'esecuzione delle suite locali/VPS: tali risultati vanno considerati provati
solo quando esiste un output reale verificabile.

- [ ] avviare Tauri Windows con una workspace e un agente TUI reale (Codex o
      OpenCode) nella stessa PTY;
- [ ] aprire l'agente manualmente e verificare che la barra compatta, mentre
      Jarvis è inattivo, resti **`Ready when you are`** anche se l'agente sta
      lavorando; nessun nome/conteggio/stato agent deve diventare monitoraggio
      persistente nella barra;
- [ ] scrivere un prompt utente e premere Enter: il task corrente della
      sessione viene rilevato senza trasformare ogni keypress in un task;
- [ ] verificare che il task corrente abbia `source: user`, confidence ridotta
      e `untrusted: true`;
- [ ] usare backspace e bracketed paste: la riga affidabile viene ricostruita;
- [ ] usare frecce/Home/End/editing non ricostruibile e poi continuare a
      digitare: né la riga originale né un suffisso devono diventare un task;
- [ ] superare il limite del buffer input: nessun suffisso troncato deve essere
      registrato come task; la riga successiva pulita deve funzionare;
- [ ] `/model`, `/help`, `/clear` dopo un completion non sostituiscono il task
      e non trasformano da soli la sessione `waiting` in `working`;
- [ ] Ctrl+C utente: attività `interrupted`, nessun task completato senza prova;
- [ ] far completare un task: `completed_at` valorizzato, sessione `waiting`
      (non `exited`) e activity `completion_observed`/`result_available` quando
      disponibile;
- [ ] chiudere il processo: attività `exited` e stato `exited`;
- [ ] chiedere a Jarvis di controllare un agente: la barra può mostrare
      temporaneamente checkpoint come `Checking Codex…` / `Reading last result…`
      e poi torna a `Ready when you are`;
- [ ] chiedere a Jarvis di preparare un'operazione: la strip espansa mostra
      checkpoint correnti/recenti come `Preparing message…` e
      `Waiting for confirmation…` (max 3 righe);
- [ ] rifiutare una Pending Action: nessun vecchio
      `Waiting for confirmation…` resta bloccato nella barra/strip;
- [ ] confermare `agent.send`: la stessa TUI visibile riceve il testo; la UI
      passa da `Writing to Codex…` a un checkpoint completato come `Sent.`; il
      task ha `source: jarvis` soltanto dopo una scrittura PTY riuscita;
- [ ] confermare `agent.abort`: attività `interrupted` con source `jarvis`,
      senza completare artificialmente il task;
- [ ] fallimento di scrittura, terminale morto o generation cambiata: nessun
      task Jarvis registrato;
- [ ] cambio workspace: activity, conversazione e task restano isolati; i PTY
      restano vivi;
- [ ] tool `agent.activity` con limit 8/16 restituisce la timeline bounded;
- [ ] nessun dashboard agent nella UI normale; diagnostica solo in
      Impostazioni → Advanced;
- [ ] nessun `codex app-server`, `opencode serve` o processo agent nascosto
      avviato da Jarvis;
- [ ] nessun terminalId, generation, IPC o JSON nelle label dei checkpoint;
- [ ] nessun task, timeline o checkpoint persistito su disco.
