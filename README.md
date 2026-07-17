# Traflix Space

Traflix Space è un ambiente desktop per lavorare con più progetti e agenti AI
in un'unica finestra. Ogni workspace raccoglie la cartella di un progetto, i
terminali necessari e gli agenti che vuoi usare: puoi affiancare più sessioni,
cambiare workspace senza chiudere i processi e mantenere il contesto mentre
lavori.

L'app è pensata per chi usa strumenti da riga di comando come Codex, Claude
Code, Gemini o OpenCode ma preferisce un'interfaccia organizzata, con terminali
multi-pannello, cronologia persistente e drag-and-drop dei file.

## Funzionalità principali

- **Workspace multipli** — crea, rinomina, elimina e riapri i progetti dalle
  cartelle locali. Le workspace preferite sono salvate nei dati utente di
  Windows (AppData), non dentro la cartella del progetto.
- **Terminali affiancati** — fino a otto terminali per workspace, con layout
  regolabile e sessioni PTY mantenute durante il cambio di workspace.
- **Integrazione con agenti AI** — avvia agenti configurati direttamente nel
  terminale e invia prompt o file tramite drag-and-drop.
- **Output leggibile** — scrollback conservato, ripristino dello schermo dopo
  un cambio di workspace e scorrimento automatico durante l'output dell'agente,
  senza impedire lo scroll manuale quando l'agente ha finito.
- **Clipboard e immagini** — incolla testo, immagini e percorsi di file nel
  terminale con le scorciatoie standard di Windows.
- **System tray** — chiudendo la finestra in versione release l'app resta
  disponibile nella tray e può essere riaperta rapidamente.

## Tecnologia

Traflix Space è una desktop app Windows costruita con:

- React 19 e TypeScript per l'interfaccia;
- Tauri 2 e Rust per il runtime nativo e i comandi IPC;
- xterm.js e ConPTY per i terminali reali;
- Zustand per lo stato locale;
- Tailwind CSS v4 per lo stile.

La separazione tra frontend e backend permette all'interfaccia di rimanere
reattiva mentre Rust gestisce processi, filesystem, terminali e persistenza.

## Requisiti

- Windows 10/11;
- Node.js e npm;
- Rust stable con Cargo;
- WebView2 (normalmente già installato su Windows 10/11).

## Avvio

Installa il file `.msi` dalla release più recente e avvia **Traflix Space** dal
menu Start di Windows. Al primo avvio scegli la cartella del progetto da usare
come workspace; in seguito potrai riaprirla direttamente dall'app.

## Build

Gli artefatti Rust vengono scritti in `D:\rust\target` tramite
[`.cargo/config.toml`](.cargo/config.toml), così il disco di sistema non viene
occupato dai file di compilazione.

```bash
npm run build       # typecheck + build frontend
npm run tauri build # pacchetto MSI di produzione
```

Le cache su `D:\rust` vanno mantenute: consentono di riutilizzare dipendenze e
artefatti già compilati. Se serve liberare spazio sul disco C, rimuovi solo le
cache generate localmente e verificate (ad esempio `src-tauri\target` legacy o
`dist`), senza toccare il contenuto di `D:\rust`.

## Struttura essenziale

```
Traflix-Space/
  src/                  # interfaccia React e componenti terminale
  src-tauri/src/        # backend Rust e comandi Tauri
  src-tauri/            # configurazione Tauri e Cargo
  .cargo/config.toml    # target Rust su D:\rust\target
  scripts/              # script di versione e manutenzione
```

Per i dettagli operativi destinati agli agenti (architettura, IPC, store,
convenzioni e regole di manutenzione) consulta [`AGENTS.md`](AGENTS.md).

## Progetti correlati

- [Traflix](https://traflix.it) — piattaforma di video-making sociale.
- [Traflix Voice](../Traflix-Voice) — dettatura vocale locale con Whisper.
