# Jarvis voice streaming and endpointing

## Causa

Il percorso corretto è:

```text
Codex App Server notification
  -> account bridge / stream_events_from_notification
  -> jarvis://chat-stream
  -> applyCodexChatStream (stato visibile)
  -> completedCodexSpeechItem (testo completo dell'item)
  -> FIFO Edge TTS queue
  -> JarvisGlobalOverlay worker
  -> jarvis_tts_speak -> worker Edge TTS persistente -> playback
```

Gli eventi intermedi non erano persi tutti nello stesso punto:

- la UI accumulava correttamente i `message_delta`, ma il listener TTS
  controllava solo `payload.text` di `message_completed`; il protocollo può
  chiudere un item senza ripetere il body, quindi un commento era visibile ma
  non veniva pronunciato;
- la coda scartava messaggi sotto 8 caratteri/meno di due parole e troncava
  silenziosamente la FIFO a otto elementi;
- `codexStreamFinal` veniva aggiornato a ogni messaggio concluso, quindi un
  intermedio poteva essere trattato come finale dal fallback TTS;
- `listen` di Tauri è asincrono: un turn molto rapido poteva iniziare prima
  che il listener `jarvis://chat-stream` fosse pronto.

## Correzioni streaming

- Lo stato visibile viene ridotto prima di risolvere l'audio. Per un
  completamento senza testo si usa il testo accumulato dai delta dello stesso
  `itemId`.
- Ogni messaggio naturale non vuoto è eleggibile al TTS, inclusi step brevi.
  La normalizzazione tecnica (markdown, JSON/tool payload, URL) resta al
  confine Rust Edge TTS.
- La coda mantiene tutti gli item completati in ordine FIFO e deduplica solo
  per `itemId`.
- Il finale viene registrato soltanto dopo `turn/completed`, quando l'ultimo
  messaggio completato è stato marcato `final`; il fallback legacy può quindi
  intervenire solo se il flusso streaming non ha consegnato il finale.
- L'invio di un turno attende la registrazione del listener chat-stream.
- Il widget compatto mostra l'ultimo messaggio Codex accumulato, mentre la
  coda Edge TTS pronuncia gli intermedi in sequenza.

## Fine parlato e pause naturali

La cattura resta nello stesso request finché il VAD e l'endpointing non hanno
confermato la fine. I default owner mode correnti sono:

- almeno 3 secondi di silenzio VAD stabile per creare il candidato;
- ulteriori 6,5 secondi di endpoint grace prima dello stop automatico;
- 500 ms di pre-roll e conservazione del buffer dopo il primo parlato;
- auto-submit solo nello stato `transcript_ready`, mai durante `armed`,
  `recording` o una pausa candidata.

La nuova isteresi VAD richiede tre frame consecutivi sopra il floor adattivo
per riconoscere una ripresa più bassa della frase precedente. Un respiro o un
click isolato non riapre l'utterance, mentre la ripresa della voce cancella il
candidato e conserva l'audio già catturato. Un silenzio lungo attraversa prima
il candidato e poi la grace; solo allora parte STT e, dopo `transcript_ready`,
la policy può inviare il testo una volta.

## Edge TTS e riferimento GTTS

Nel codice corrente non esiste un provider gTTS né una dipendenza/import
gTTS: il provider configurato è `edge_tts` e usa il helper Python/sidecar Edge
persistente. Un riferimento a “GTTS” nei log o nelle note indica quindi una
configurazione legacy o un ambiente esterno al percorso attuale; non è una
seconda pipeline usata da Traflix. Il helper Edge ha già retry/reset del worker
per gli errori di processo e la normalizzazione avviene una sola volta al
confine `jarvis_tts_speak`.

## Validazione

- test rosso prima della correzione per step brevi e coda oltre otto elementi;
- `scripts/jarvis-codex-stream.test.mjs`: delta-only, messaggio visibile,
  testo TTS accumulato, ordine intermedi/finale e marcatura finale;
- `scripts/jarvis-voice-endpointing.test.mjs`: policy di submit, pause/VAD
  wiring, Edge boundary e protezioni barge-in;
- `npx tsc --noEmit`: verde;
- `git diff --check`: verde;
- `cargo test --manifest-path src-tauri/Cargo.toml --lib jarvis::voice::`
  compila il crate e i test, ma l'esecuzione del binario Windows nel runner
  locale termina con `0xc0000139 (STATUS_ENTRYPOINT_NOT_FOUND)`, come già
  documentato in `VOICE-TROUBLESHOOTING.md`; non è un errore di compilazione
  del codice VAD/endpointing.

Il test reale con App Server/Codex e playback Edge richiede una sessione Codex
autenticata e dispositivi audio disponibili. Non sono state lette credenziali
dal repository e non è stato eseguito alcun push GitHub.
