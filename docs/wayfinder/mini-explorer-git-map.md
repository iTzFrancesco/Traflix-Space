# Wayfinder — Mini Explorer + Git Changes

## Destination

Arrivare a una specifica UX e tecnica implementabile per un pannello laterale
destro di Traflix Space che esplori la root del workspace e renda visibili le
modifiche Git nello stesso albero, con un confine chiaro per le azioni Git.

Questa mappa deve chiudersi prima di iniziare l'implementazione applicativa.

## Notes

- Dominio: workspace locale Windows, filesystem, repository Git e terminali
  persistenti.
- Skill da consultare: `research`, `wayfinder`, `domain-modeling`,
  `grilling` e, prima dell'implementazione UI, `frontend-design`.
- Fonti locali di riferimento: `src/`, `src-tauri/src/`, `opencode/` e
  `warp/` presenti nel workspace.
- Nessun push GitHub automatico; questa fase non modifica codice applicativo.
- Il report delle fonti primarie viene raccolto in
  `docs/research/file-explorer-git-research.md`.

## Decisions so far

<!-- L'indice verrà aggiornato quando una decisione viene chiusa. -->

## Not yet specified

- Se il click su un file debba aprire un preview/editor interno, l'app
  associata di Windows o soltanto il terminale.
- Quali azioni Git scrivibili entrano nel primo rilascio: refresh e apertura
  diff, oppure stage, unstage, commit, branch, pull e push.
- Se il pannello debba avere tab `Files`/`Changes` oppure un solo albero con
  filtro e stato Git integrati; la proposta iniziale privilegia un solo albero
  con un controllo secondario per filtrare le modifiche.
- Strategia di aggiornamento: polling leggero, watcher filesystem con refresh
  Git, oppure un servizio Rust persistente per workspace.
- Limiti per repository molto grandi, symlink/junction, file ignorati e
  contenuti binari.
- Persistenza della selezione, cartelle espanse e filtro per workspace.

## Out of scope

- Editor di codice completo con salvataggio, undo/redo e linguaggi.
- Supporto a repository remoti o workspace SSH.
- Push su GitHub durante questa analisi o implementazione automatica.

## Open tickets

- [Explorer data contract and path policy](tickets/explorer-data-contract-and-path-policy.md)
- [Unified explorer and Git review interaction](tickets/unified-explorer-and-git-review-interaction.md)
- [Git action boundary and safety](tickets/git-action-boundary-and-safety.md)
- [Refresh, watcher and large-repository behavior](tickets/refresh-watcher-and-large-repository-behavior.md)
