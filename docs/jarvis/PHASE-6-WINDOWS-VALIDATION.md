# Fase 6 — checklist Windows

Questa checklist non è stata eseguita sulla VPS Linux.

**Stato owner (2026-08-07): validazione manuale Windows differita perché al momento non è disponibile un ambiente fisico per eseguirla. La Fase 6 può proseguire come code-complete verso la Fase 7, ma nessun punto seguente deve essere considerato superato finché non viene provato realmente su Windows.**

- [ ] avviare Tauri Windows con consenso Groq/Edge TTS configurato;
- [ ] click-toggle: start, stop, transcript e draft modificabile;
- [ ] hold-to-talk con mouse, uscita dal bottone e pointer capture;
- [ ] hold-to-talk con tastiera, key repeat e rilascio fuori focus;
- [ ] hotkey globale toggle;
- [ ] hotkey globale hold;
- [ ] conflitto e shortcut non valida mostrano errore senza crash;
- [ ] VAD in stanza silenziosa e timeout armed;
- [ ] VAD con rumore ventola e voce bassa;
- [ ] VAD con parlato normale, pausa breve e auto-stop a fine frase;
- [ ] cap di 45 secondi;
- [ ] cambio workspace durante armed e recording;
- [ ] cancel, stop manuale e race auto-stop;
- [ ] barge-in ferma sintesi e playback prima della capture;
- [ ] disabilitazione Jarvis e uscita app chiudono microfono, STT, TTS e playback;
- [ ] due workspace conservano draft indipendenti;
- [ ] auto-submit disattivato di default e warning quando attivato;
- [ ] nessun audio o secret nei log;
- [ ] nessuna wake word, full duplex o ascolto permanente.