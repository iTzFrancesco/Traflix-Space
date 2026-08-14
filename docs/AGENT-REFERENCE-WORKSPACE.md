# Organizzazione della workspace e checkout agenti

## Checkout esterni

Le basi sorgente degli agenti esterni sono raccolte in:

```text
agenti-riferimento/
├── cline/
├── codebuff/
├── codex/
├── opencode/
├── pi/
└── warp/
```

Queste directory non fanno parte dell'app Traflix Space e restano escluse da
Git tramite `.gitignore` e dal watcher Vite tramite `server.watch.ignored`.
Questo evita che i symlink/reparse point gestiti da OneDrive dentro i checkout
interrompano il dev server o interferiscano con la workspace di lavoro.

I file di supporto già tracciati in `.agents`, `.playwright-mcp` e `.wayfinder`
sono rimasti nella posizione originale per non alterare la documentazione e le
modifiche recenti della workspace destra.

## File `.env`

I file `.env` e `.env.*` restano visibili nell'esplora-file della workspace.
L'anteprima è consentita per facilitare l'ispezione della struttura, ma i
valori dopo `=` vengono sostituiti con `<REDACTED>` prima di arrivare al
frontend. Commenti e nomi delle variabili restano visibili; i segreti non
vengono mostrati nell'interfaccia.

Il file `.env` resta escluso da Git e non va incluso in commit, log o report.

## Artefatti archiviati

Gli artefatti importanti precedentemente lasciati nel root sono stati spostati
in `docs/`, inclusi il patch delle impostazioni voce, lo screenshot delle
impostazioni dev e la documentazione dell'integrazione Codex App Server.
