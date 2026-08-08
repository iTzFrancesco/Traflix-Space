# Traflix Jarvis — Fase 2.1

## Obiettivo

Questa fase consolida la fondazione della Fase 2 prima di qualunque lavoro vocale. Non introduce widget, voce, modelli LLM, provider reali o operazioni mutative.

## Correzioni consolidate

- `ContextPackageV1` rimane raw e locale al Context Broker.
- `ModelContextViewV1` è una proiezione separata per un futuro modello: summary documentale senza contenuti completi, indice dei documenti, estratti Markdown richiesti esplicitamente e sessioni agent secondo `requestedDepth`.
- Gli estratti sono scelti per path relativo già presente nel package, rifiutano traversal e sono limitati a 8 KiB per documento.
- `context.refresh` mantiene la cache per workspace, ripete discovery e controllo metadata e rilegge soltanto nuovi o modificati. Il force rebuild esiste solo come primitiva Rust interna.
- File sorgente, manifest, configurazioni non Markdown e binari sono saltati silenziosamente. Omissioni e warning restano espliciti per dati sensibili, symlink bloccati, limiti ed errori.

## IPC aggiunti

- `jarvis_build_model_context`
- `jarvis_refresh_model_context`

Entrambi sono read-only, risolvono la workspace tramite registry backend e ricevono soltanto ID espliciti e una lista opzionale di path Markdown da proiettare.

## Verifica

La VPS ora dispone di Rust `1.97.1`, `rustfmt`, Node `22.22.1`, npm `9.2.0` e delle librerie GTK/WebKit per il check Linux. `npm ci` non è stato utilizzabile perché il lockfile esistente non contiene `@emnapi/core@1.11.3` e `@emnapi/runtime@1.11.3`; `npm install --ignore-scripts --package-lock=false` ha installato le dipendenze senza modificare il lockfile.

Controlli eseguiti con esito positivo:

- `cargo fmt --all -- --check`;
- `cargo check --lib` usando un target temporaneo Linux;
- `cargo test --lib jarvis --target-dir /var/tmp/traflix-jarvis-phase2-target -j 2`: 24 test passati, 0 falliti;
- `./node_modules/.bin/tsc --noEmit`;
- `git diff --check`.

Il `cargo check` del package completo raggiunge il codice ma il binario Tauri fallisce in `tauri::generate_context!` perché la configurazione punta a `../dist`, assente sulla VPS. Non è stata generata una build frontend per aggirare il problema, rispettando il divieto di build di produzione. La VPS Linux non dimostra il comportamento Windows di Tauri, ConPTY, IPC nativo, packaging MSI o integrazioni live degli agenti.

## Fuori scope

Restano fuori scope registry live Codex/OpenCode, adapter provider reali, voce, wake word, STT/TTS, LLM, widget, sidecar, vector database e tool spawn/write/abort/close/kill.
