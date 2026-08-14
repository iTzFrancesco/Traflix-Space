# Traflix Jarvis — ascolto, VAD ed endpointing

## Comportamento

Jarvis mantiene una singola cattura mentre l'utente parla, respira o fa una
pausa. Il VAD locale non invia audio né trascrizioni durante una pausa: la
ripresa cancella la finestra di endpointing e conserva il preroll e il draft
nella stessa richiesta. La trascrizione viene consegnata a STT soltanto quando
il watchdog conferma la fine reale del turno.

Le fasi esposte al widget sono:

- `standby`: microfono armato, calibrazione/rumore filtrato, nessun parlato;
- `speaking`: parlato confermato;
- `pause`: pausa naturale; l'ascolto continua;
- `breath`: energia bassa ma sopra il rumore stimato, trattata come respiro;
- `micro_interruption`: possibile ripresa o impulso isolato, sottoposto a
  debounce;
- `finalizing`: VAD ha confermato silenzio stabile, ma la finestra finale è
  ancora aperta e l'utente può riprendere senza perdere la frase.

## Parametri

| Parametro | Default | Limiti | Scopo |
| --- | ---: | ---: | --- |
| `endpointGraceMs` / `endpoint_grace_ms` | 6.500 ms | 3.500–15.000 ms | Silenzio finale dall'inizio della pausa prima dello stop automatico |
| `vadPostSpeechMs` / `vad_post_speech_ms` | 3.000 ms | 100–5.000 ms | Candidato VAD di silenzio stabile; non è più il timer finale di invio |
| `vadStartFrames` | 5 | 4–60 | Debounce per confermare l'attacco vocale |
| `vadSilenceFrames` | 16 | 1–120 | Debounce della transizione verso silenzio |
| `vadPreRollMs` | 500 ms | 0–1.000 ms | Protezione della prima sillaba |
| ripresa dopo pausa | 3 blocchi | fisso | Isteresi/debounce contro click e impulsi singoli |

Il vecchio default `endpointGraceMs = 1.200` viene migrato a 6.500 ms; valori
personalizzati diversi restano configurabili e vengono solo limitati al range
sicuro.

Il rumore di fondo viene stimato nei primi 300 ms e seguito lentamente anche
quando il microfono è armato. Il gate usa `1.1 × noiseFloor`, attenua i campioni
sotto soglia senza tagliare quelli sopra soglia, mentre il livello UI usa RMS
smussato con attacco `0.45` e rilascio `0.20`. Il VAD mantiene soglia adattiva,
isteresi sul rilascio (`25%` del picco) e debounce separato dall'indicatore.

## Verifica

Test automatici aggiunti/aggiornati:

- parlato continuo e attacco confermato;
- pausa naturale, respiro e micro-interruzione con ripresa;
- silenzio lungo e stop soltanto dopo la finestra finale;
- rumore fisso sopra la soglia assoluta, rumore introdotto dopo la calibrazione
  e gate del payload STT;
- caption `standby/speaking/pause/breath/micro_interruption/finalizing` e
  indicatore volume;
- invio finale, coda quando chat è occupata, conservazione del draft e guardia
  anti-doppio invio.

Comandi:

```text
node --test scripts/jarvis-voice-endpointing.test.mjs
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml --lib jarvis::voice
```

La build di produzione non fa parte della verifica automatica del fix.
