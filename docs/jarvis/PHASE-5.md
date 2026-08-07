# Traflix Jarvis — Fase 5 vocale cloud

La Fase 5 aggiunge un percorso click-to-toggle separato dalla chat, senza
creare una seconda memoria o un nuovo agent harness:

`microfono Windows → capture Rust → WAV PCM16 mono 16 kHz → Groq Whisper → transcript draft → jarvis_chat → assistant message → Edge TTS → playback Rust`.

## STT

Il solo provider STT runtime è Groq, con `GROQ_API_KEY` nel backend e modello
fisso `whisper-large-v3-turbo`. Non esiste fallback, retry applicativo o
seconda richiesta per lo stesso audio. Groq riceve soltanto il WAV bounded,
lingua, temperatura zero e un prompt breve con i nomi Traflix/agenti.

Il capture nativo usa cpal/WASAPI su Windows, limita una registrazione a 45
secondi e 4 MiB, converte f32/i16/u16, mischia in mono, ricampiona a 16 kHz,
rimuove silenzio prudente e produce PCM16 in memoria. Il transcript è sempre
una bozza modificabile: `autoSubmitTranscript` è false e l’invio usa il
normale `jarvis_chat` della Fase 4.

## TTS

Il provider è `edge_tts`, senza API key e senza fallback. In debug Rust può
avviare `scripts/jarvis-edge-tts.py` (oppure il percorso indicato da
`TRAF_EDGE_TTS_HELPER`) con JSON typed; in release usa il resolver ufficiale
`ShellExt::sidecar("jarvis-edge-tts")` del plugin Tauri. Il file MP3 resta in
una directory temporanea e viene eliminato dopo successo, stop, errore o
cancellazione. Il helper non legge settings, workspace o file e non registra
il testo.
`rodio` gestisce il playback Windows dietro `AudioPlayback`; lo stop è
idempotente e il click sul microfono interrompe prima l’audio (barge-in).

Prima del TTS il testo viene ripulito da Markdown, blocchi codice, URL e
metadati tecnici, poi limitato a 800 caratteri con preferenza per la fine di
una frase. Viene parlato soltanto l’assistant message finale.

## Lifecycle, privacy e limiti

Ogni richiesta vocale conserva `requestId`, workspace immutabile, device,
stato, durata, livello e cancellazione. Gli eventi sono
`jarvis://voice-state`, `jarvis://voice-level` e `jarvis://tts-state`; i
listener frontend vengono rimossi all’unmount. Buffer e file temporanei non
sono persistenti.

Input e output hanno consensi separati e disattivarli azzera il rispettivo
timestamp. Il consenso input informa dell’invio dell’audio a Groq; quello
output informa dell’invio del testo a Edge TTS. Nessuna chiave è salvata nei
settings o inviata al frontend.

Le voci vengono elencate soltanto su richiesta esplicita. La strategia release
è verificabile su Windows con
`powershell -ExecutionPolicy Bypass -File scripts/build-jarvis-edge-tts-sidecar.ps1`:
lo script genera `src-tauri/binaries/jarvis-edge-tts-x86_64-pc-windows-msvc.exe`
con PyInstaller e `src-tauri/tauri.windows.conf.json` lo include come
`externalBin`. Il sidecar non è stato costruito sulla VPS Linux; la verifica
del binario resta manuale. L’MSI release non richiede Python; solo il debug
usa Python e il modulo `edge-tts` presenti nell’ambiente.
La voce predefinita
è `it-IT-DiegoNeural` e il codice non seleziona silenziosamente una voce
straniera.

Questa fase non include wake word, VAD automatico, ascolto continuo, full
duplex, Gemini Live, desktop automation o Fase 6.
