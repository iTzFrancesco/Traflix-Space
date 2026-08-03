# Ricerca tecnica: mini file explorer integrato con Git changes

**Progetto:** Traflix Space (Tauri 2 / React 19 / Rust)
**Data:** 3 agosto 2026
**Scopo:** definire pattern affidabili per un file explorer locale con stato Git e diff, mantenendo watcher, IPC e UI prevedibili su Windows.

## Perimetro e metodo

Ricerca non invasiva basata su:

- codice locale di Traflix Space, OpenCode (`opencode/`) e Warp (`warp/`);
- documentazione ufficiale VS Code Extension API/Source Control;
- documentazione ufficiale Tauri 2 filesystem, shell e IPC/eventi;
- documentazione ufficiale Git.

Non sono stati letti file `.env`, non è stato eseguito codice applicativo né una build, e non sono state modificate sorgenti applicative. L’unica modifica prevista è questo report.

## Sintesi operativa

Il pattern più solido è un modello a due livelli:

1. **snapshot iniziale via comando Tauri**: il backend risolve il workspace, elenca soltanto la directory richiesta e restituisce metadati di file/cartella;
2. **aggiornamenti via eventi coalescati**: il watcher Rust emette path e tipo di evento, mentre il frontend invalida solo il file aperto e la directory già caricata;
3. **Git come sorgente separata**: `git status --porcelain=2 -z` fornisce lo stato macchina, `git diff` fornisce statistiche e patch; il file tree non deve dedurre lo stato Git dagli eventi filesystem;
4. **stesso modello per due viste**: Explorer gerarchico e Changes flat/grouped condividono path normalizzati e chiavi stabili, ma hanno proiezioni UI diverse;
5. **fallback esplicito**: perdita del watcher, overflow, repository non Git o Git non disponibile devono produrre uno stato `stale/error` e una refresh completa manuale o automatica.

Questa separazione combina i pattern già presenti in OpenCode e Warp con i contratti documentati da VS Code, Tauri e Git.

## Fatti osservati

### 1. File tree: lazy loading, path stabili e virtualizzazione

OpenCode mantiene per ogni directory uno stato distinto (`expanded`, `loaded`, `loading`, `error`, `children`), deduplica le richieste in volo e ignora il risultato se lo scope del workspace è cambiato durante la richiesta. La lista aggiornata rimuove anche i discendenti di directory scomparse. [OpenCode `tree-store.ts`](../../opencode/packages/app/src/context/file/tree-store.ts#L4-L127)

Il componente V2 normalizza separatori e slash iniziali/finali, conserva `originalPath` per il percorso effettivo e costruisce una lista piatta soltanto delle righe visibili. Directory e file sono ordinati separatamente, le righe hanno chiavi basate sul path e il rendering usa una virtualizer con overscan. [OpenCode `file-tree-v2-model.ts`](../../opencode/packages/app/src/components/file-tree-v2-model.ts#L15-L76) · [OpenCode `file-tree-v2.tsx`](../../opencode/packages/app/src/components/file-tree-v2.tsx#L124-L190)

Lo stesso componente supporta un albero completo e un sottoinsieme di path già noto, utile per una vista Changes. La ricerca passa invece a una lista piatta virtualizzata, con navigazione da tastiera, `role=listbox`, `aria-selected` e `aria-activedescendant`. [OpenCode `file-tree-v2.tsx`](../../opencode/packages/app/src/components/file-tree-v2.tsx#L124-L141) · [OpenCode `session-file-list-v2.tsx`](../../opencode/packages/app/src/pages/session/v2/session-file-list-v2.tsx#L10-L35) · [OpenCode `session-file-list-v2.tsx`](../../opencode/packages/app/src/pages/session/v2/session-file-list-v2.tsx#L37-L166)

Warp usa una struttura analoga: stato per root, set di cartelle espanse, lista piatta per il rendering e stato interattivo conservato per path. L’identificatore di riga include root e indice, mentre la UI espone azioni esplicite per apertura, copia path, rename, delete, drag-and-drop e contesto. [Warp `file_tree/view.rs`](../../warp/app/src/code/file_tree/view.rs#L73-L142) · [Warp `file_tree/view.rs`](../../warp/app/src/code/file_tree/view.rs#L218-L255)

### 2. Watcher: invalidazione mirata, non reload indiscriminato

OpenCode traduce gli eventi nativi in `add`, `change` e `unlink`, applica pattern di ignore e gestisce separatamente la directory di lavoro e il Git directory. Su Windows seleziona un backend dedicato; per Git osserva anche la directory interna ma ignora gli elementi rumorosi lasciando passare `HEAD`. [OpenCode `watcher.ts`](../../opencode/packages/core/src/filesystem/watcher.ts#L38-L49) · [OpenCode `watcher.ts`](../../opencode/packages/core/src/filesystem/watcher.ts#L86-L123)

Nel client, un evento su un file ricarica il contenuto soltanto se il file è già noto o aperto. Un cambio di directory aggiorna la directory solo se è già caricata; create/delete aggiornano il parent caricato. Gli eventi sotto `.git/` sono filtrati dalla vista file. [OpenCode `file/watcher.ts`](../../opencode/packages/app/src/context/file/watcher.ts#L18-L53)

Warp esplicita due fasi: I/O filesystem in background per calcolare mutazioni leggere, poi applicazione sincrona al tree model. Le mutazioni comprendono remove, add-file, add-subtree e add-empty-directory. [Warp `local_model.rs`](../../warp/crates/repo_metadata/src/local_model.rs#L304-L326) · [Warp `local_model.rs`](../../warp/crates/repo_metadata/src/local_model.rs#L580-L690)

Warp inoltre usa debounce di 500 ms per il watcher della repository e, quando arrivano aggiornamenti remoti frequenti, ricostruisce solo la root interessata per evitare flicker e lavoro sulle altre root. [Warp `watcher.rs`](../../warp/crates/repo_metadata/src/watcher.rs#L24-L26) · [Warp `file_tree/view.rs`](../../warp/app/src/code/file_tree/view.rs#L595-L610)

La documentazione VS Code conferma che i watcher distinguono create/change/delete, vanno smaltiti con `dispose()` e che i watcher ricorsivi sono costosi; segnala inoltre che delete/move di una directory può arrivare come un singolo evento e che casing e symlink richiedono attenzione su Windows. [VS Code API: `createFileSystemWatcher`](https://code.visualstudio.com/api/references/vscode-api#workspace.createFileSystemWatcher) · [VS Code API: watcher behavior](https://code.visualstudio.com/api/references/vscode-api#FileSystemWatcher)

### 3. Git changes: stato, statistiche e patch sono contratti distinti

Warp usa `git status --untracked-files=all --branch --porcelain=2 -z` per lo stato completo e NUL-delimitato. Per confronti tra branch usa `git diff --name-status -z`, aggiunge gli untracked con `git status`, poi usa `git diff --numstat` per riconoscere binari e calcolare additions/deletions. [Warp `diff_state/local.rs`](../../warp/app/src/code_review/diff_state/local.rs#L1763-L1810) · [Warp `diff_state/local.rs`](../../warp/app/src/code_review/diff_state/local.rs#L2015-L2051)

OpenCode applica lo stesso principio: usa output `-z` per path e distingue status, numstat, patch, binari e file untracked; per una patch di untracked usa `git diff --no-index` e tratta correttamente il codice di uscita `1` come “differenze trovate”. [OpenCode `git.ts`](../../opencode/packages/core/src/git.ts#L550-L617) · [OpenCode `git.ts`](../../opencode/packages/core/src/git.ts#L729-L786)

La documentazione Git definisce `--porcelain` come formato stabile per parser e `-z` come formato senza quoting dei path, indispensabile per nomi con spazi, Unicode o caratteri speciali. Porcelain v2 aggiunge branch headers, stato `XY`, rename/copy e unmerged entries. [Git `status`](https://git-scm.com/docs/git-status#_porcelain_format_version_2) · [Git `status`, `-z`](https://git-scm.com/docs/git-status#_pathname_format_notes_and_z)

Git documenta inoltre `--name-status` per ottenere solo path e tipo di cambiamento, `--numstat` per un output adatto al consumo macchina e `--no-index` per confrontare file fuori dall’indice Git. [Git `diff`](https://git-scm.com/docs/git-diff#Documentation/git-diff.txt---name-status) · [Git `diff`, `--numstat` e `-z`](https://git-scm.com/docs/git-diff#Documentation/git-diff.txt---numstat) · [Git `diff --no-index`](https://git-scm.com/docs/git-diff#_synopsis)

### 4. UX Git: Index e Working Tree non sono lo stesso stato

La Source Control API di VS Code modella un provider come gruppi di resource states. Nell’esempio Git ufficiale, `Index` e `Working Tree` sono gruppi separati e lo stesso `README.md` può apparire in entrambi quando è staged e poi modificato di nuovo. [VS Code Source Control API](https://code.visualstudio.com/api/extension-guides/scm-provider#source-control-model)

OpenCode espone badge `A`, `D`, `M` sulle righe del tree e riusa lo stesso tree per l’elenco dei soli file cambiati. [OpenCode `file-tree-v2.tsx`](../../opencode/packages/app/src/components/file-tree-v2.tsx#L42-L52) · [OpenCode `review-panel-v2.tsx`](../../opencode/packages/app/src/pages/session/v2/review-panel-v2.tsx#L60-L81)

La review OpenCode mantiene la selezione per path, carica il diff in modo asincrono e non rimonta il preview solo perché l’oggetto diff è stato aggiornato. [OpenCode `review-panel-v2.tsx`](../../opencode/packages/app/src/pages/session/v2/review-panel-v2.tsx#L82-L101) · [OpenCode `review-panel-v2.tsx`](../../opencode/packages/app/src/pages/session/v2/review-panel-v2.tsx#L141-L165)

### 5. Tauri 2: filesystem, shell e IPC hanno responsabilità diverse

Tauri FS offre `readDir`, metadata (`stat`/`lstat`) e `watch`/`watchImmediate`; il watch normale è debounced, il watch immediato notifica subito, il watch directory non è ricorsivo di default e la modalità ricorsiva richiede esplicita configurazione. Le API pericolose e gli scope sono bloccati di default e vanno abilitati nelle capabilities. [Tauri FS: directory e watch](https://v2.tauri.app/plugin/file-system/#watching-changes) · [Tauri FS: permissions](https://v2.tauri.app/plugin/file-system/#permissions)

Il plugin shell può eseguire processi figli, ma `shell:allow-execute` senza scope è ampio; la documentazione mostra invece una capability con comando, nome e validatore degli argomenti. [Tauri Shell](https://v2.tauri.app/plugin/shell/#permissions)

Tauri distingue i comandi, adatti a richieste/risposte con argomenti, risultati ed errori, dagli eventi, che sono asincroni, fire-and-forget, non type-safe e con payload JSON. [Tauri IPC](https://v2.tauri.app/concept/inter-process-communication/) · [Tauri calling Rust](https://v2.tauri.app/develop/calling-rust/#event-system)

Traflix ha già FS, shell e dialog plugin installati e ha capability `shell:allow-execute`, `shell:allow-spawn` e permessi FS di lettura/scrittura/listing senza scope per-directory. [Traflix `Cargo.toml`](../../src-tauri/Cargo.toml#L9-L16) · [Traflix `default.json`](../../src-tauri/capabilities/default.json#L16-L27)

Traflix possiede già un watcher Rust basato su `notify`, ricorsivo e debounced a 500 ms, ma emette soltanto `skills-changed` senza path o tipo di evento. È quindi un precedente utile per lifecycle e cleanup, non un contratto sufficiente per il file explorer. [Traflix `skills/watcher.rs`](../../src-tauri/src/skills/watcher.rs#L18-L67)

Il comando workspace attuale canonicalizza i path Windows, rimuove il prefisso `\\?\` e restituisce children ordinati, nascondendo le entry che iniziano con `.`. [Traflix `workspace/commands.rs`](../../src-tauri/src/workspace/commands.rs#L13-L20) · [Traflix `workspace/commands.rs`](../../src-tauri/src/workspace/commands.rs#L162-L197)

## Implicazioni per Traflix Space

### Contratto backend consigliato

Per ogni workspace attivo, introdurre concettualmente questi contratti Rust/Tauri:

- `file_tree_list(root, dir)` → children immediati con `path`, `name`, `kind`, `size`/metadata opzionali, `loaded` e `ignored` se disponibili;
- `git_status(root, scope)` → branch/head e record `XY` NUL-parsed, mantenendo separati `indexStatus`, `worktreeStatus`, `renameFrom`, `untracked` e `conflict`;
- `git_diff(root, path, side)` → metadata lazy (status, additions, deletions, binary) e patch richiesta solo per il file selezionato;
- evento `workspace-files-changed` → `{ workspaceId, root, paths, kinds, revision }`, con batch/coalescing;
- evento `workspace-git-changed` oppure invalidazione unica `workspace-files-changed` con `gitMetadataChanged: true` per `.git/HEAD`, refs e index/worktree rilevanti.

Il comando deve essere la fonte di snapshot coerenti; l’evento deve soltanto invalidare. A ogni refresh il frontend deve poter scartare eventi precedenti tramite `revision` o `generation`, così un risultato lento non sovrascrive un workspace ormai cambiato.

### Modello frontend consigliato

Usare path relativi al repository, normalizzati a `/`, come identità logica; mantenere separato l’absolute path per IPC. Il nodo può avere questa forma concettuale:

```ts
type ExplorerNode = {
  path: string
  name: string
  kind: "file" | "directory"
  ignored: boolean
  loaded?: boolean
  git?: {
    index: GitStatus
    worktree: GitStatus
    additions?: number
    deletions?: number
    binary?: boolean
  }
}
```

Conservare `expanded`, `loaded`, `loading` ed `error` per directory. Caricare i figli all’espansione, deduplicare richieste per directory, e aggiornare solo il parent interessato da add/delete. La lista Changes deve essere una proiezione flat dei path Git; non deve materializzare l’intero repository.

### Mapping UX Git

La vista Explorer dovrebbe mostrare badge sintetici e un indicatore aggregato sulle directory. La vista Changes dovrebbe avere almeno due gruppi mutuamente leggibili: **Staged / Index** e **Changes / Working Tree**, con possibilità che lo stesso path compaia in entrambi. Per una prima versione read-only, click/double-click apre il diff; stage, unstage, discard e commit restano domande separate.

Non ridurre `XY` a un solo `A/M/D`: uno stato staged e unstaged simultaneo, conflict, rename/copy e type change sono informazione utile. I binari devono mostrare “binary” e statistiche non testuali, senza tentare di renderizzare una patch UTF-8.

### Watcher e Git refresh

Su Windows il watcher dovrebbe osservare il worktree con ignore configurabile e mantenere una sottoscrizione mirata alla Git directory per branch/refs. Gli eventi filesystem aggiornano il tree; gli eventi Git aggiornano status/branch/diff metadata. Non serve ricaricare tutti i file aperti dopo ogni evento.

Il comportamento di `notify` già usato da Traflix suggerisce 500 ms come debounce iniziale. Va però aggiunto un batch per root e un refresh completo quando il backend segnala errore, perdita eventi o evento ambiguo (per esempio directory spostata). Un refresh manuale deve essere sempre disponibile.

### Sicurezza e boundary Tauri

Non esporre al frontend un comando shell arbitrario. Preferire un comando Rust con executable/argomenti costruiti dal backend e pathspec separati, oppure una capability shell strettamente scoped se si usa il plugin. Ridurre progressivamente i permessi FS globali a scope per il workspace scelto; `deny` deve avere precedenza su `allow` secondo la documentazione Tauri.

La risoluzione del root Git, il parsing porcelain e la gestione di encoding/errori Git appartengono al backend. Il frontend deve ricevere DTO già validati e non interpretare output testuale di `git`.

### Performance e affidabilità UI

- virtualizzare le righe visibili e usare il path come chiave;
- preservare scroll, espansione e selezione per path durante gli update;
- aggiornare solo la root/dir invalidata;
- caricare la patch soltanto dopo la selezione;
- limitare dimensione dei file e diff, con stato binary/too-large;
- separare loading del tree, loading di Git status e loading della patch;
- se una directory non è ancora caricata, mostrare uno stato esplicito invece di assumere che sia vuota.

## Domande aperte

1. La prima release deve essere read-only oppure includere stage, unstage, discard, rename e commit? Le operazioni mutanti cambiano capability, conferme UI e modello di errore.
2. Il workspace può contenere più root, worktree Git, submodule, junction o symlink? Il contratto dei path e il routing degli eventi devono dichiararlo.
3. Le entry dot-prefixed, `.gitignore` e file ignorati devono essere nascosti sempre, mostrati con toggle, o esclusi soltanto dalla vista Git changes?
4. Qual è il limite accettabile per file tree, untracked e patch? Serve una soglia per diff e lettura contenuto prima di introdurre paginazione.
5. Come deve reagire Traflix quando Git non è installato, il path non è un repository, `HEAD` è unborn/detached o il repository è in conflitto?
6. Il watcher deve vivere per ogni workspace aperto o soltanto per quello attivo? Quante root possono essere osservate contemporaneamente senza impatto su Windows?
7. È preferibile usare `notify` in Rust, già presente, oppure abilitare il watch del plugin Tauri FS? La decisione dipende da scope dinamici, lifecycle delle subscription e necessità di ricevere path/tipi evento.
8. Serve una sincronizzazione ordinata ad alta frequenza tra più webview? Se sì, il contratto dovrebbe includere revisioni monotone o un canale più adatto degli eventi JSON fire-and-forget.
9. Il diff deve confrontare `working tree ↔ index`, `index ↔ HEAD` e `working tree ↔ HEAD` separatamente? Questo determina quali comandi e quali file mostrare per ogni gruppo.
10. Quale strategia di test è obbligatoria per nomi con Unicode/spazi, rename, delete directory, file binari, Git index lock, branch switch e aggiornamenti concorrenti?

## Fonti locali principali

- Traflix Space: `src-tauri/src/workspace/commands.rs`, `src-tauri/src/skills/watcher.rs`, `src-tauri/capabilities/default.json`.
- OpenCode: `packages/app/src/components/file-tree-v2.tsx`, `file-tree-v2-model.ts`, `context/file/tree-store.ts`, `context/file/watcher.ts`, `packages/core/src/filesystem/watcher.ts`, `packages/core/src/git.ts`, `packages/app/src/pages/session/v2/review-panel-v2.tsx`.
- Warp: `app/src/code/file_tree/view.rs`, `app/src/code/file_tree/view/render.rs`, `app/src/code_review/diff_state/local.rs`, `crates/repo_metadata/src/local_model.rs`, `file_tree_store.rs`, `file_tree_update.rs`, `watcher.rs`, oltre alle specifiche `warp/specs/APP-3788/`.

## Fonti ufficiali esterne

- [VS Code Extension API — Source Control API](https://code.visualstudio.com/api/extension-guides/scm-provider)
- [VS Code API — `createFileSystemWatcher` e `FileSystemWatcher`](https://code.visualstudio.com/api/references/vscode-api#workspace.createFileSystemWatcher)
- [Tauri 2 — File System plugin](https://v2.tauri.app/plugin/file-system/)
- [Tauri 2 — Shell plugin](https://v2.tauri.app/plugin/shell/)
- [Tauri 2 — Inter-Process Communication](https://v2.tauri.app/concept/inter-process-communication/)
- [Tauri 2 — Calling Rust / Event System](https://v2.tauri.app/develop/calling-rust/)
- [Git — `git status`](https://git-scm.com/docs/git-status)
- [Git — `git diff`](https://git-scm.com/docs/git-diff)
