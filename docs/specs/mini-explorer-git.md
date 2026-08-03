# Mini Explorer + Git Changes

## Obiettivo

Aggiungere a Traflix Space un pannello laterale destro, coerente con la sidebar
esistente, che mostri l'albero dei file della workspace e lo stato Git nello
stesso albero. Le modifiche non devono diventare una schermata separata:
devono essere visibili come colore, badge e indicatori sulle cartelle/file.

Il pannello è un'estensione della workspace attiva, non del terminale attivo.
Il cambio di directory di un terminale non cambia la root dell'explorer.

## Lettura delle schermate di riferimento

- Le schermate “Open file” mostrano il pattern utile: nome progetto, campo
  filtro, directory espandibili, file ordinati sotto le cartelle e stato vuoto
  chiaro.
- Le schermate “Git changes” mostrano il pattern utile: titolo, filtro,
  messaggio “nessuna modifica” e area dedicata alla review.
- In Traflix questi due concetti vanno uniti: un solo albero con un filtro
  `Tutti` / `Solo modifiche`, senza duplicare la navigazione.
- Il pannello deve usare i token già presenti (`neutral-surface`, bordi sottili,
  arancione primario), con resize dal bordo sinistro e apertura dalla rail
  destra.

## Proposta UX

### Struttura

```text
TitleBar
  Sidebar workspace | WorkspaceView / terminal grid | Right rail / Explorer
```

Quando è chiuso resta una rail stretta con l'icona Explorer e un contatore
opzionale delle modifiche. Quando è aperto diventa un pannello da circa 320–360
px, ridimensionabile e persistito nello `uiStore`. La vista iniziale è
`explorer`; il modello consente future viste senza accorpare la logica nel
componente `App`.

Header del pannello:

1. nome workspace e path abbreviato;
2. branch Git, stato repository e pulsante refresh;
3. filtro file;
4. controllo compatto `Tutti` / `Solo modifiche`.

Righe dell'albero:

- cartelle prima dei file, sort case-insensitive;
- espansione lazy, una chiamata per directory e stato loading/error locale;
- file: icona tipo, nome, badge `A`, `M`, `D`, `R`, `?` o conflitto;
- cartella: dot aggregato se un discendente è cambiato;
- colori consigliati: verde added/staged, arancione modified, rosso deleted,
  viola/azzurro renamed, rosso intenso conflict;
- tooltip sul badge con distinzione `index/staged` e `worktree/unstaged`.

Interazioni consigliate:

- click: seleziona e conserva il path;
- doppio click: apre il file con l'app associata di Windows nella prima fase,
  oppure il preview/diff interno quando verrà implementato;
- click su file modificato: può caricare il diff lazy nel contenuto centrale,
  senza materializzare tutti i patch;
- ricerca: filtra le righe note; in modalità `Solo modifiche` costruisce solo
  i parent necessari ai path cambiati;
- refresh manuale sempre disponibile, anche se il watcher è in errore.

## Contratto dati frontend

Lo `workspaceStore` continua a contenere metadata e configurazione della
workspace. Serve uno store separato, ad esempio `projectStore`, indicizzato per
`workspaceId`, con selettori individuali.

```ts
type ExplorerNode = {
  path: string          // relativo al workspace, slash '/'
  name: string
  kind: "file" | "directory"
  ignored: boolean
  loaded?: boolean
  git?: {
    index: "clean" | "added" | "modified" | "deleted" | "renamed" | "conflict"
    worktree: "clean" | "added" | "modified" | "deleted" | "renamed" | "conflict"
    renameFrom?: string
    untracked?: boolean
    binary?: boolean
  }
}
```

`expanded`, `loaded`, `loading`, `error`, `selectedPath` e `filter` sono stato
UI per workspace e non proprietà persistenti del backend. L'identità logica è
il path relativo normalizzato; il path assoluto resta confinato all'IPC.

Il backend deve conservare separati `workspaceRoot` e `repositoryRoot`. Se la
workspace è una sottocartella del repository, entrano nell'albero solo i file
sotto `workspaceRoot`; i path Git vengono convertiti prima di arrivare al
frontend.

## IPC e backend Rust

Creare un modulo dedicato, ad esempio `src-tauri/src/project/`, e registrare
comandi Tauri specifici. I comandi ricevono `workspaceId` e path relativo,
non un path assoluto arbitrario; il root viene risolto da `WorkspaceRegistry`.

- `project_list_directory(workspace_id, relative_dir)` → figli immediati;
- `project_git_status(workspace_id)` → branch, HEAD, upstream/ahead/behind e
  record `XY` per i path cambiati;
- `project_git_diff(workspace_id, relative_path, side)` → metadata e patch
  solo su richiesta;
- futuro `project_git_stage/unstage/commit/push` → da abilitare dopo aver
  definito il confine delle azioni mutanti.

Per Git usare `git -C <repositoryRoot> status --porcelain=2 -z --branch` e
parser Rust NUL-delimitato. Non parsare output colorato o human-readable. Per
diff usare `--name-status`, `--numstat` e patch lazy; i binari devono restituire
`binary: true` senza tentare di decodificare la patch.

Il backend deve usare processi async, timeout, `GIT_TERMINAL_PROMPT=0`,
`GCM_INTERACTIVE=Never` e `CREATE_NO_WINDOW` su Windows. L'azione Git deve
essere una allowlist di comandi costruiti dal backend, mai una shell arbitraria
proveniente dal frontend.

## Aggiornamento live

Riutilizzare `notify` in Rust, già presente nel progetto, con watcher debounced
per workspace attive. Il watcher deve distinguere:

- eventi del worktree → invalida la directory caricata e pianifica un nuovo
  snapshot Git coalescato;
- eventi `.git/HEAD`, refs e index → aggiorna branch/status;
- rename/delete ambiguo, overflow o errore watcher → marca lo snapshot stale e
  forza un refresh completo.

Gli eventi Tauri devono solo invalidare, per esempio:

```ts
type ProjectFilesChanged = {
  workspaceId: string
  paths: string[]
  gitMetadataChanged: boolean
  revision: number
}
```

Il frontend scarta risposte con `revision` precedente, così un refresh lento non
sovrascrive lo stato di una workspace già cambiata. Debounce iniziale: 500 ms,
coerente con il watcher skills e con il pattern osservato in Warp.

## Fasi di implementazione

### Fase 1 — Explorer + Git read-only

- `RightPanel`/rail e resize collegati allo `uiStore` già predisposto;
- `projectStore` e albero lazy;
- snapshot branch/status con badge e colori;
- filtro `Tutti` / `Solo modifiche`;
- refresh manuale, error/loading states e path validation;
- apertura esterna del file o selezione del path.

### Fase 2 — Review diff

- diff lazy working tree/index e index/HEAD;
- contenuto centrale o modal read-only;
- statistiche additions/deletions e gestione binari/patch grandi;
- tastiera, focus, selection e virtualizzazione per alberi grandi.

### Fase 3 — Git actions controllate

- stage/unstage selezionato;
- commit con message e validazione;
- discard solo con conferma esplicita;
- branch, pull e push solo quando repository remoto e autenticazione sono
  chiaramente rappresentati.

“GitHub changes” va chiamato “Git changes”: `git status` è locale; GitHub è
solo uno dei possibili remote. Il push non deve gestire token in Traflix e deve
delegare le credenziali al credential manager/configurazione Git già presente.

## Rischi e contromisure

- Repository grandi: listing lazy, status coalesced, patch on-demand e
  virtualizzazione.
- Path Windows con spazi/Unicode: path relativo normalizzato e output Git `-z`.
- Junction/symlink/traversal: canonicalizzazione e verifica che il target resti
  sotto la root autorizzata; policy esplicita per symlink.
- Stato `MM`, rename, conflict e untracked: non ridurre `XY` a un solo colore;
  conservare entrambe le colonne nel DTO.
- Git assente/non-repository/unborn/detached: stati UI distinti e nessun errore
  generico “nessun file”.
- Watcher rumoroso o perso: debounce, revisioni monotone, invalidazione mirata
  e refresh completo di fallback.
- Azioni mutanti: prima read-only; allowlist Rust, conferme e errori mostrati
  senza nascondere stderr.

## Criteri di accettazione della fase 1

- Cambiando workspace, l'explorer cambia root senza seguire il CWD dei terminali.
- L'espansione di una cartella carica solo i figli immediati e non blocca la UI.
- Un repository Git mostra branch e badge coerenti per added/modified/deleted,
  rename, untracked, conflict e combinazioni staged+unstaged.
- Il filtro `Solo modifiche` mantiene i parent necessari e non crea una seconda
  navigazione separata.
- Un file con spazi, Unicode o path annidato viene mostrato e identificato
  correttamente.
- Un evento filesystem aggiorna il parent già caricato; un evento `.git` aggiorna
  status/branch; un errore watcher lascia un refresh manuale funzionante.
- Nessun comando Git arbitrario è eseguibile dal frontend e nessun segreto viene
  letto o memorizzato dall'app.

## Riferimenti

- [Mappa Wayfinder](../wayfinder/mini-explorer-git-map.md)
- [Report di ricerca](../research/file-explorer-git-research.md)
- [VS Code Source Control API](https://code.visualstudio.com/api/extension-guides/scm-provider)
- [Tauri File System](https://v2.tauri.app/plugin/file-system/)
- [Tauri Shell](https://v2.tauri.app/plugin/shell/)
- [Tauri IPC](https://v2.tauri.app/concept/inter-process-communication/)
- [Git status](https://git-scm.com/docs/git-status)
- [Git diff](https://git-scm.com/docs/git-diff)
