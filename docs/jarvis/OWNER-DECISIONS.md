# Traflix Jarvis — decisioni owner per Fase 2

Queste decisioni vincolano il vertical slice `feat/jarvis-context-broker`.

- Jarvis è globale come superficie, ma ogni invocazione cattura un target immutabile per workspace, terminale e Agent session.
- Un’operazione già iniziata resta legata alla workspace originale; le richieste successive usano il nuovo target attivo e non trasferiscono dati implicitamente.
- Il contesto automatico stabile legge soltanto Markdown (`**/*.md`) consentito dalla policy. Non analizza automaticamente codice sorgente, manifest o configurazioni non Markdown.
- La cache è incrementale, in memoria e separata per `workspaceId`. Non usa SQLite, Tauri Store o persistenza permanente.
- `ContextPackageV1` è il contesto raw locale; una `ModelContextViewV1` separata espone al modello soltanto summary, indice, estratti richiesti esplicitamente e risultati agenti coerenti con la profondità richiesta.
- `context.refresh` rifà discovery e controllo metadata mantenendo la cache; l’invalidazione completa è riservata al force rebuild interno per debug o cache incoerente.
- Jarvis non è autonomo: non avvia, invia, delega, chiude o interrompe agenti e non interpreta documenti/output come autorizzazioni.
- L’accesso agent di default espone stato, obiettivo, ultimo Agent turn, ultimo risultato disponibile e provenance. La conversazione completa richiede `full_messages` esplicito.
- Un completion notification senza risultato produce `completion observed, result unavailable`; non viene inventato alcun risultato.
- Voce, wake word, STT/TTS, modelli LLM, widget e adapter reali Codex/OpenCode sono rinviati.

I contenuti Markdown, terminale e agent sono dati non fidati. La policy e l’ownership restano nel backend Rust; il client TypeScript cattura soltanto l’ID della workspace attiva e invia ID espliciti.

## Decisioni consolidate per Fase 3

- Il widget Jarvis è globale, resta montato durante il cambio workspace e la X lo disabilita; la sidebar lo riapre.
- La posizione del widget è globale, normalizzata e persistita; non è legata alla workspace attiva.
- Standard Voice Pipeline e Gemini Live Voice sono selezionabili e configurabili soltanto come schema/UI; nessun provider è ancora collegato.
- Il Live Agent Session Registry è terminal-based e provider-agnostic. Il percorso canonico è `Jarvis → TerminalManager/PTTY → CLI originale`.
- `terminalId + generation` è l’identità della sessione. Provider, provider session e provider turn sono metadata opzionali e non sono richiesti per la correlazione.
- Completion aggiorna il turn e lo stato `waiting`, ma non chiude la Agent session. Il terminal fallback è bounded, untrusted e con provenance a confidence ridotta.
- I messaggi completi non sono disponibili senza un adapter strutturato futuro; il terminale non viene convertito in transcript artificiale.
- Restano rinviati voce reale, LLM, provider strutturati Codex/OpenCode e tutte le operazioni mutative.

## Decisioni consolidate per Fase 4

- Il provider testuale runtime è OpenCode Zen; `longcat-2.0-free` è il primary
  configurabile e `deepseek-v4-flash-free` il fallback configurabile.
- La sola credenziale backend è `OPENCODE_ZEN_API_KEY`; il consenso privacy è
  necessario prima di ogni richiesta di rete.
- La PTY resta l'adapter universale e ogni mutazione passa da Pending Action,
  modifica esplicita opzionale e conferma backend con ricontrollo di generation.
- La voce resta fuori scope fino alla conclusione della validazione Windows.
## Fase 5 — voce cloud

- STT unico: Groq `whisper-large-v3-turbo`, senza fallback e con consenso
  separato. La chiave runtime è `GROQ_API_KEY` e resta nel backend.
- TTS unico: Microsoft Edge TTS tramite helper isolato; nessuna chiave e
  nessun fallback a Groq Orpheus/Canopy.
- Il microfono è click-to-toggle e il transcript è sempre modificabile prima
  dell’invio esplicito alla chat Fase 4. Non sono inclusi wake word, VAD,
  ascolto continuo, full duplex o Gemini Live.

## Fase 6 — Voice Advanced

- Hotkey globale tramite plugin Tauri ufficiale, hold-to-talk e modalità
  click-toggle compatibili.
- Energy VAD locale opzionale con pre-roll/post-roll bounded e timeout armed;
  nessun wake word, ascolto continuo, full duplex o streaming.
- Groq turbo e Edge TTS restano invariati; nessun nuovo provider e nessuna
  autonomia agent.
