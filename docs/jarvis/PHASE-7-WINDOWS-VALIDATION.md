# Fase 7 — checklist Windows

Questa checklist non è stata eseguita sulla VPS Linux.

**Stato owner (2026-08-07): **PENDING** — validazione manuale Windows non
eseguibile perché al momento non è disponibile un ambiente fisico Windows. La
Fase 7 è code-complete e validata con test Rust, test frontend, typecheck e
test Python, ma nessun punto seguente deve essere considerato superato finché
non viene provato realmente su Windows.**

- [ ] avviare Tauri Windows con una workspace e un agente TUI reale (Codex o
      OpenCode) nella stessa PTY;
- [ ] scrivere un prompt utente e premere Enter: il widget collassato mostra
      "L'agente sta lavorando…" senza nomi/conteggi;
- [ ] verificare che il task corrente della sessione abbia `source: user`,
      confidence 0.65 e `untrusted: true`;
- [ ] usare backspace, frecce e incolla con bracketed paste: nessun task
      inventato dopo editing non ricostruibile;
- [ ] Ctrl+C utente: attività `interrupted`, nessun task completato;
- [ ] far completare un task: `completed_at` valorizzato, sessione `waiting`
      (non `exited`) e activity `completion_observed`/`result_available`;
- [ ] chiudere il processo: attività `exited` e stato `exited`;
- [ ] chiedere a Jarvis di preparare un'operazione: la strip espansa mostra
      "Preparing message…" poi "Waiting for confirmation…" (max 3 righe);
- [ ] confermare `agent.send`: la strip mostra "Writing to Codex…" poi
      "Sent."; il task della sessione ha `source: jarvis`, confidence 0.95 e
      `untrusted: false`;
- [ ] confermare `agent.abort`: attività `interrupted` con source `jarvis`;
- [ ] fallimento di scrittura o generazione cambiata: nessun task jarvis
      registrato e checkpoint "Scrittura non riuscita.";
- [ ] widget collassato a riposo: "Pronto quando vuoi";
- [ ] cambio workspace: strip e conversazione isolate; i PTY restano vivi;
- [ ] tool `agent.activity` con limit 8/16 restituisce la timeline bounded;
- [ ] nessun dashboard agent nella UI normale; diagnostica solo in
      Impostazioni → Advanced;
- [ ] nessun `codex app-server`, `opencode serve` o processo agent nascosto
      avviato da Jarvis;
- [ ] nessun terminalId, generation, IPC o JSON nelle label della strip;
- [ ] nessun task, timeline o checkpoint persistito su disco.
