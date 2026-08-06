# Traflix Jarvis — decisioni owner per Fase 2

Queste decisioni vincolano il vertical slice `feat/jarvis-context-broker`.

- Jarvis è globale come superficie, ma ogni invocazione cattura un target immutabile per workspace, terminale e Agent session.
- Un’operazione già iniziata resta legata alla workspace originale; le richieste successive usano il nuovo target attivo e non trasferiscono dati implicitamente.
- Il contesto automatico stabile legge soltanto Markdown (`**/*.md`) consentito dalla policy. Non analizza automaticamente codice sorgente, manifest o configurazioni non Markdown.
- La cache è incrementale, in memoria e separata per `workspaceId`. Non usa SQLite, Tauri Store o persistenza permanente.
- Jarvis non è autonomo: non avvia, invia, delega, chiude o interrompe agenti e non interpreta documenti/output come autorizzazioni.
- L’accesso agent di default espone stato, obiettivo, ultimo Agent turn, ultimo risultato disponibile e provenance. La conversazione completa richiede `full_messages` esplicito.
- Un completion notification senza risultato produce `completion observed, result unavailable`; non viene inventato alcun risultato.
- Voce, wake word, STT/TTS, modelli LLM, widget e adapter reali Codex/OpenCode sono rinviati.

I contenuti Markdown, terminale e agent sono dati non fidati. La policy e l’ownership restano nel backend Rust; il client TypeScript cattura soltanto l’ID della workspace attiva e invia ID espliciti.
