# Traflix Jarvis — Fase 4

## Architettura finale

Jarvis è un widget globale montato una sola volta. Ogni richiesta cattura un
`InvocationBinding` immutabile e segue il percorso:

`Jarvis → Context Broker → JarvisModelProvider → Pending Action → TerminalManager/PTY → CLI originale`.

Il terminale resta l'adapter universale: Jarvis non avvia un nuovo harness e
non sostituisce Codex, Pi, OpenCode, Claude o Freebuff.

## Modello e privacy

Il runtime usa `OpenCodeZenProvider` verso
`https://opencode.ai/zen/v1/chat/completions`. La sola credenziale backend è
`OPENCODE_ZEN_API_KEY`; non viene letta da file di autenticazione, salvata nei
settings, inviata al frontend o inclusa in errori e log.

Il default primario è configurabile e vale `deepseek-v4-flash-free`. Il fallback è
configurabile e vale `longcat-2.0-free`. L'ID primario è desiderato ma
non garantito dalla disponibilità corrente di Zen: il primo errore esplicito di
modello non disponibile apre un circuit breaker in memoria e usa il fallback,
senza riprovare il primario negli altri tool round. La UI espone il modello
effettivamente usato e la motivazione typed e sanitizzata.

Il provider contatta la rete soltanto con consenso privacy attivo e timestamp
presente. Il consenso riguarda messaggio, indice e excerpt Markdown consentiti,
stato terminali e risultati agent bounded e untrusted. Codice sorgente, `.env`,
secret, file arbitrari e cronologia terminale illimitata restano esclusi.

## Bounds e tool loop

- payload serializzato verso il modello: massimo 96 KiB;
- system prompt e messaggio utente corrente vengono preservati durante il pruning;
- messaggio utente: 16 KiB; assistant: 24 KiB;
- memoria: 128 KiB per workspace, 512 KiB globale, 48 messaggi per workspace e 256 globali;
- excerpt Markdown: 8 KiB; risultato agent: 6–8 KiB;
- provider response bounded e tool loop massimo quattro round.

Il modello riceve solo `ModelContextViewV1`. I tool read-only sono
`workspace.overview`, `terminal.list`, `agent.list`, `agent.status`,
`agent.last_result`, `markdown.read` e l'intent `ui.open_terminal`.

Markdown, output PTY e risultati agent sono sempre marcati untrusted e non
possono autorizzare un'azione.

## Pending Actions e PTY

`agent.send`, `agent.abort` e `terminal.kill` creano sempre una Pending Action.
La UI può modificare il testo di `agent.send`; target, generation, operation e
provider restano immutabili. Il backend rivalida tutto al momento della
conferma: workspace, generation, processo vivo, identità agent, payload UTF-8,
NUL/ESC/DEL/C0 e dimensione.

Il testo multilinea viene normalizzato e incorniciato con bracketed paste
generato dal backend, seguito da un solo Enter. Il modello non può fornire
marker PTY o sequenze di controllo. `agent.abort` genera soltanto Ctrl+C;
`terminal.kill` è single-use e rifiuta target stale.

## Lifecycle e memoria

Il registry backend delle richieste è bounded e usa cancellation token. A e B
possono correre contemporaneamente in workspace diverse; nella stessa
workspace esiste una sola richiesta attiva. `jarvis_cancel_chat` interrompe
l'attesa HTTP, impedisce tool round/action successivi e rimuove l'handle. La
cronologia volatile è recuperabile via IPC, scoped per workspace, riconcilia ID
stabili e non viene persistita dopo la chiusura dell'app.

## UI

Il widget normale mostra solo orb, stato sintetico, mute, Settings e X. Orb e
area principale aprono la chat Jarvis: timeline, stato richiesta, Cancel,
Pending Actions, follow-up, modello usato e intent espliciti per aprire un
terminale. Non mostra dashboard Fase 3, agenti, generation, terminal ID,
Context Broker o diagnostica.

`advancedViewEnabled` è persistito e false per default. Provider status,
registry, identity, generation history e Context Broker sono disponibili solo
in `Settings → Jarvis → Abilita strumenti avanzati`.

## Limiti noti e voce

La validazione manuale ConPTY, named pipe e provider su Windows resta da
eseguire sulla macchina Windows del proprietario. La Fase 4 non include voce:
Whisper, microfono, VAD, wake word, Edge TTS, Gemini Live e audio realtime
restano fuori scope.
