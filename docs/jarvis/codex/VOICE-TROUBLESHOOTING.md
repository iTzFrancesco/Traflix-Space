# Jarvis voice troubleshooting

## Groq STT: HTTP 401

Il backend usa l'endpoint Groq ufficiale per le trascrizioni e invia la
credenziale con `Authorization: Bearer <chiave>`. Un `401 Unauthorized` significa
che Groq ha rifiutato la credenziale: la chiave può essere scaduta, revocata,
errata oppure incollata con un prefisso aggiuntivo.

In Impostazioni → Connessioni → Groq va inserita la chiave grezza `gsk_…`, senza
`Bearer ` e senza `GROQ_API_KEY=`. Il backend ora rimuove automaticamente un
eventuale prefisso `Bearer ` incollato per errore, senza mai esporre la chiave
nei log o nell'interfaccia.

Se il 401 continua, la chiave deve essere sostituita con una nuova chiave Groq;
non è un problema del microfono, del VAD o del formato WAV.

## Meter e rilevamento della voce

- Il meter usa RMS in dBFS, senza amplificazione artificiale dei picchi.
- Il livello viene filtrato con attacco rapido e rilascio più lento per evitare
  lo spasmo visivo tra i blocchi CPAL.
- Il VAD apprende il rumore ambientale, richiede almeno quattro blocchi
  consecutivi per iniziare e conserva il preroll per non tagliare la prima
  sillaba.
- La soglia di rilascio è più vicina al pavimento configurato: il rumore di
  fondo non deve mantenere aperta la registrazione dopo una frase.
- L'endpointing resta separato dal VAD: la pausa deve essere stabile prima
  dell'invio automatico.

Questa è una riduzione del falso positivo basata sull'energia. Un rumore
continuo con ampiezza simile alla voce non è distinguibile perfettamente da un
VAD RMS puro; per ambienti estremamente rumorosi servirebbe una soppressione
del rumore dedicata.

## Verifica locale

- `npm run test:jarvis`: regressioni frontend e statiche.
- `npx tsc --noEmit`: typecheck TypeScript.
- `cargo fmt --manifest-path src-tauri\\Cargo.toml -- --check`.
- `cargo test --manifest-path src-tauri\\Cargo.toml --no-run`: compilazione dei
  test Rust.
- `npm run test:strict`: suite completa; imposta automaticamente
  `TRAFLIX_RUST_TEST_MANIFEST=1`, necessario per incorporare il manifest
  common-controls nei test Windows.

Un `cargo test` lanciato senza `TRAFLIX_RUST_TEST_MANIFEST=1` può terminare con
`0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` prima dell'harness. Non è un errore
delle asserzioni: usare `npm run test:strict` oppure impostare la variabile
prima del comando Cargo.
