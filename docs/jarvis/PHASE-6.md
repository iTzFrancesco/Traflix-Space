# Traflix Jarvis — Fase 6

La Fase 6 aggiunge un controllo vocale avanzato sopra la pipeline Fase 5,
senza cambiare i provider: Groq `whisper-large-v3-turbo` resta l'unico STT e
Edge TTS resta l'unico TTS. Il transcript è ancora una bozza modificabile e
l'invio alla chat resta esplicito per default.

## Attivazione

`voiceInput.activationMode` supporta `click_toggle` (default), `hold_to_talk`
e `vad`. Hold-to-talk usa pointer capture e key press/release; una perdita di
focus, cancel o cambio workspace non retargetta la richiesta. La workspace è
catturata al momento dell'arming.

La hotkey globale usa il plugin Tauri ufficiale. È disabilitata di default,
configurabile con `globalShortcut` e `shortcutBehavior` (`toggle` o `hold`), e
viene registrata solo se Jarvis e la hotkey sono abilitati. Conflitti e valori
non validi restituiscono errori typed senza sostituire scorciatoie altrui.

## VAD locale

`EnergyVAD` calcola RMS sui campioni locali e passa da `silence` a
`maybe_speech` a `speech` solo dopo più frame sopra soglia. Il pre-roll è un
ring buffer bounded; il post-speech richiede silenzio continuo prima dell'auto
stop. `maxArmedSeconds` è limitato a 20 e la registrazione complessiva resta
limitata a 45 secondi. In modalità `vad`, l'audio resta locale durante
`armed`: nessuna richiesta Groq parte prima del parlato e nessun ascolto
continuo permanente è attivo.

La macchina Rust è autoritativa: `idle → armed → recording → stopping →
transcribing → transcript_ready`, con cancellazione da ogni stato. Ogni
transizione `armed → recording` e `recording → transcribing` viene emessa al
frontend prima dell'aggiornamento successivo di livello o dell'attesa Groq.
L'identità attiva è il `requestId`, non la workspace visualizzata: un release
dopo uno switch ferma la richiesta originaria. Press/release rapidi e perdita
di focus lasciano una richiesta pendente deterministica, con completamento
idempotente; un errore del device porta a `failed` senza inviare audio parziale.
Ogni richiesta ha un solo completamento; i draft restano isolati per workspace.

## Turn-taking e privacy

Con `voiceOutput.stopOnUserSpeech=true`, una registrazione esplicita ferma e
attende TTS prima di aprire il microfono. Non è full duplex: il microfono non
ascolta mentre Jarvis parla senza un'azione dell'utente.

`autoSubmitTranscript` resta `false`. Se abilitato, invia solo transcript
valido nella workspace originale e non bypassa mai Pending Actions o i limiti
della Fase 4. VAD, audio e pre-roll non sono persistiti; il consenso input e
output resta separato. Gli eventi frontend includono solo livello bounded e
stato VAD, mai PCM/WAV. Il VAD conta frame audio reali e quindi mantiene gli
stessi tempi su input mono e stereo.

## Limiti e cosa resta fuori

Restano esclusi wake word, VAD cloud, ascolto continuo, streaming STT/TTS,
Gemini Live, nuovi provider, autonomia agent e Fase 7. La validazione reale di
CPAL, global shortcut e playback deve essere eseguita su Windows seguendo la
checklist dedicata.
