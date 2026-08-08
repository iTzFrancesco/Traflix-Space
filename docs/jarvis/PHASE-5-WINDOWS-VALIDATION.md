# Checklist manuale Windows — Jarvis Fase 5

Questa checklist non è stata eseguita sulla VPS Linux. Va eseguita sul target
Windows con microfono e playback reali.

- [ ] Avvio Tauri Windows e disponibilità del microfono predefinito.
- [ ] Impostazione backend `GROQ_API_KEY`, senza comparsa nei log/UI.
- [ ] Consenso input separato e rifiuto prima del consenso.
- [ ] Click-to-toggle: start, timer, livello e stop.
- [ ] Limite 45 secondi e rifiuto sotto 250 ms.
- [ ] Trascrizione `whisper-large-v3-turbo` in italiano.
- [ ] Nessun fallback STT e nessun auto-submit.
- [ ] Modifica del transcript e invio esplicito nella chat della workspace originale.
- [ ] Cambio workspace durante la trascrizione senza retargeting.
- [ ] Cancel durante capture, encoding e richiesta Groq.
- [ ] Consenso output separato.
- [ ] Edge TTS con `it-IT-DiegoNeural`, rate, volume e pitch.
- [ ] Risposta testuale visibile anche se Edge TTS fallisce.
- [ ] Playback MP3, Stop e cleanup del file temporaneo.
- [ ] Barge-in: microfono ferma TTS prima di registrare.
- [ ] Elenco voci esplicito e preferenza per `it-IT`.
- [ ] Codex, Pi, OpenCode, Claude e Freebuff continuano a usare la PTY Fase 4.
- [ ] Nessun flicker, nessuna registrazione continua e nessuna wake word.
- [ ] Chiusura app senza processi helper o stream audio orfani.
- [ ] Verifica finale che log, settings e frontend non contengano segreti,
      audio o transcript completo.
- [ ] Eseguire `scripts/build-jarvis-edge-tts-sidecar.ps1` e verificare il
      binary PyInstaller con il target Windows corretto.
- [ ] In release verificare l’uso del sidecar senza Python di sistema; in debug
      verificare `TRAF_EDGE_TTS_HELPER`/Python.
