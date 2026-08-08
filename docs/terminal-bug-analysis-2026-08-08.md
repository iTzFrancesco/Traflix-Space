# Traflix Space — analisi dei bug dei terminali

Data: 2026-08-08
Ambiente: Windows, Tauri 2, React/xterm.js, `portable-pty`
Perimetro: analisi dei commit precedenti all’introduzione di Jarvis

## Stato dell’indagine

L’indagine è partita in modalità read-only sulla cronologia Git precedente a Jarvis. Dopo aver isolato i punti causali, sono state applicate solo correzioni circoscritte al ciclo di vita del terminale, al resize xterm e al cambio workspace. Le modifiche Jarvis già presenti nel worktree non sono state riscritte.

I riferimenti principali sono:

- `bbe56e6` — persistenza della posizione di scroll durante lo streaming;
- `824ba51` — conservazione dell’output live durante il cambio workspace;
- `068bb87` — reflow, scrollback e rehydration del terminale;
- `3bfdef2` — anchor testuale durante il resize/fullscreen;
- `d8545c6` — follow mode durante il reflow;
- `6937672` — lifecycle e snapshot backend del terminale;
- `a0af319` — mantenimento del viewport in fondo dopo i cambi di layout;
- `70c1439` — rifinitura grafica dei terminali, non risultata causa primaria dei bug analizzati.

## 1. Terminale nero quando è idle

### Evidenza osservata

Nella prima schermata il pane `Dev server space` mostra solo il cursore xterm arancione, senza prompt PowerShell. Nella schermata successiva, dopo l’interazione dell’utente, compaiono prompt e righe `^C` ripetute.

Questo esclude come causa primaria la morte del processo: il PTY e la shell sono ancora vivi e reagiscono all’input. Il problema è che l’output iniziale non viene dipinto nel terminale React.

### Catena causale più probabile

1. `TerminalPane` crea xterm e avvia `terminal_spawn` in un effect React.
2. La sottoscrizione all’output è un effect successivo e `subscribeTerminalOutput` registra il listener Tauri in modo asincrono.
3. Il backend può emettere il primo prompt subito dopo la creazione della shell, prima che il listener globale `terminal-output` sia realmente registrato.
4. In `terminalEvents.ts`, quando non esiste ancora un handler per quel terminale, `enqueueOutput` esegue un ritorno anticipato e perde il chunk.
5. Una shell idle non emette altro output. Di conseguenza xterm resta vuoto, anche se il PTY funziona.
6. La digitazione, `Enter` o `Ctrl+C` genera un nuovo echo/prompt e fa sembrare che il terminale si “sblocchi”.

Il commit `c9b1ade` ha introdotto il comportamento esplicito di scartare l’output quando non ci sono subscriber, assumendo che una successiva rehydration lo recuperi. `6937672` ha poi esteso lo snapshot anche al primo mount, ma la sequenza resta vulnerabile: lo snapshot può essere letto prima che il parser backend abbia ricevuto il prompt e il primo evento può essere già stato perso dal bus.

### Perché il problema appare soprattutto senza agente/server

Un agente o un dev server produce output aggiuntivo poco dopo il mount e quindi maschera la perdita del primo prompt. Un terminale PowerShell fermo invece non produce nessun evento successivo che possa ridisegnare la UI.

### Valutazione

**Confidenza: alta.** La condizione “nessun processo attivo” e il fatto che l’input faccia riapparire il prompt coincidono esattamente con questa race di output iniziale.

## 2. Cambio workspace: il terminale dell’agente torna in alto

### Meccanismo coinvolto

`WorkspaceView` renderizza soltanto il workspace attivo. Quando si cambia workspace, il `TerminalPane` viene smontato; il PTY backend invece resta vivo. Quando si rientra, il pane viene ricreato, legge `scrollPosition` dallo Zustand store e reidrata lo snapshot backend.

La posizione viene rappresentata da:

```text
offsetFromBottom = buffer.baseY - buffer.viewportY
followsOutput    = offsetFromBottom === 0
```

Durante lo smontaggio la posizione viene salvata nello store. Durante il remount, `restoreScrollPosition` interpreta quello stato: `followsOutput=true` porta in fondo; `false` ripristina la distanza dal fondo.

### Punto debole individuato

Il valore `viewportY` di xterm non rappresenta sempre un’azione dell’utente: durante `fitAddon.fit()`, resize PTY, cambio grid e remount può temporaneamente diventare `0`. Se quell’evento supera i filtri di layout ed entra in `captureScrollPosition`, il codice lo interpreta come navigazione reale:

```text
viewportY = 0
baseY > 0
→ followsOutput = false
→ offsetFromBottom = baseY
```

Al successivo rientro, il codice ripristina la distanza dal fondo. Se la distanza è maggiore del nuovo `baseY`, `scrollToLine` viene clampato a `0`: il terminale appare quindi all’inizio dello scrollback.

Il caso è più visibile con agenti come Pi perché hanno molto output, reflow e resize del PTY. `a0af319` ha provato a rendere i ref di scroll autorevoli e ha aggiunto una riparazione temporanea del fondo, ma la riparazione dura solo una finestra limitata e non impedisce che uno stato `followsOutput=false` già catturato venga persistito durante il cambio workspace. `70c1439` modifica solo stile e dimensioni dei controlli, quindi non è il candidato principale.

### Cronologia rilevante

- `bbe56e6` introduce la persistenza della posizione e la gestione custom degli eventi di scroll;
- `068bb87` aggiunge rehydration dello scrollback e rende il remount dipendente dallo stato salvato;
- `3bfdef2` aggiunge l’anchor testuale per i reflow, ma soltanto quando il terminale è già in history mode;
- `d8545c6` aggiunge una barriera per il resize;
- `a0af319` sostituisce la barriera con `stabilizeFollowBottom` e filtri di layout.

### Correzione applicata

Il cleanup non campiona più `viewportY` durante lo smontaggio. Salva invece l’ultimo `scrollPositionRef` aggiornato da eventi utente o layout validi. In questo modo il teardown del workspace non può convertire un terminale che seguiva il fondo in un terminale in history mode solo perché xterm ha riportato temporaneamente `viewportY=0`.

È stato inoltre aggiunto il ripristino del terminale attivo quando si rientra in un workspace già presente nella cache. Prima, il terminale attivo poteva appartenere al workspace precedente, causando focus e resize sul pane sbagliato.

**Confidenza: alta sulla catena causale e sulla correzione.** Il valore di scroll salvato non viene più letto durante una transizione di layout non stabile.

## 3. Scrollbar/pulsante di scroll non cliccabile con un solo terminale

Nel codice non esiste un pulsante applicativo separato per andare in fondo: il controllo visibile è la scrollbar nativa di xterm (`.xterm-viewport`). L’app aggiunge:

- `scrollbar-width: thin` globale e sulla viewport;
- larghezza WebKit di 9 px;
- un `pointerdown` in capture sul container, che prova a riconoscere la zona scrollbar con una larghezza minima di 16 px;
- una logica di follow mode che può riportare la viewport in fondo.

### Causa più concreta: overlay globale di drag

`draggedTerminalId` è globale nello store, non locale al workspace. Se resta valorizzato durante un drag o durante una transizione tra workspace, ogni altro `TerminalPane` renderizza un overlay assoluto:

```text
position: absolute
inset: 0
z-index: 100
```

L’overlay non imposta `pointer-events: none`, quindi intercetta anche il click sulla scrollbar e rende l’intero pane apparentemente non cliccabile. Questo spiega perché il problema può manifestarsi anche con un solo terminale visibile: il drag può provenire da un altro terminale o da un altro workspace, mentre `draggedTerminalId` è condiviso globalmente.

Il candidato è particolarmente forte se il mancato click avviene dopo aver trascinato un terminale o dopo un cambio workspace.

### Seconda causa possibile: click recepito ma scroll subito annullato

Il `pointerdown` cerca la scrollbar calcolando `offsetWidth - clientWidth`. In WebView2 e con scrollbar sottili questa geometria può non coincidere con l’area effettivamente cliccata. Se il click non viene riconosciuto come intento utente, `followsOutput` può restare true; `stabilizeFollowBottom` e i callback di output possono allora riportare immediatamente la viewport in fondo. Dal punto di vista dell’utente il thumb sembra non muoversi, anche se il click è stato ricevuto.

Questa seconda ipotesi non blocca fisicamente il puntatore: è un conflitto tra hit-test, follow mode e reflow. Va distinta dall’overlay z-index, che invece blocca davvero l’evento.

### Correzione applicata

L’overlay di drag è ora visuale (`pointer-events: none`), quindi non può coprire il viewport xterm o la sua scrollbar. Il drag continua a risolvere il pane sotto il puntatore tramite `document.elementFromPoint` durante `pointermove`.

Il rilevamento dell’intento di scroll sulla scrollbar ascolta inoltre sia `pointerdown` sia `mousedown`, perché WebView2 non espone sempre il primo evento in modo uniforme per la scrollbar nativa.

**Confidenza: alta per il blocco fisico dell’overlay; media per le differenze di hit-test specifiche di WebView2.**

## 4. Cambio applicazione: il terminale scrive una o due lettere per riga

### Evidenza osservata

Nella schermata più recente il percorso PowerShell viene visualizzato come `o\`, `On`, `eD`, `ri`, ecc. Questo non è un problema di font o di repaint: è l’output reale della shell riformattato con una larghezza di circa 2 colonne.

### Catena causale

1. `ResizeObserver` resta attivo anche quando la finestra WebView2 perde il focus.
2. Durante il cambio applicazione WebView2 può restituire per pochi millisecondi dimensioni/cell metrics non valide.
3. `@xterm/addon-fit` calcola le colonne con una protezione minima pari a 2 (`Math.max(2, ...)`).
4. Il resize veniva quindi inoltrato a `terminal_resize` con una dimensione di circa 2 colonne.
5. ConPTY/PowerShell avvolge ogni coppia di caratteri; quando la finestra torna visibile il terminale può rimanere deformato finché non arriva un nuovo input o un nuovo resize valido.

### Correzione applicata

In `src/lib/terminalPolicies.ts` è stata introdotta una policy comune che accetta un resize solo se:

- la finestra è focused e il documento è visible;
- il layout ha dimensioni positive;
- le colonne sono almeno 8 e le righe almeno 2.

`TerminalPane` applica la policy prima di `fitAddon.fit()` e prima di ogni `terminal_resize`. Durante blur/visibility hidden il resize viene ignorato. Se xterm propone una dimensione transitoria, il passaggio viene saltato: non viene inviato nessun fallback arbitrario al PTY. Il successivo `ResizeObserver` o il refit al ritorno del focus applica la dimensione reale e ripara anche un PTY già rimasto a 2 colonne.

La finestra viene rifittata quando torna focused, quindi una misura transitoria non viene persistita come dimensione reale del terminale.

**Confidenza: alta.** Il wrapping carattere-per-carattere è una firma diretta di un PTY ridimensionato a pochissime colonne.

## 5. Output iniziale perso nel terminale idle

Per chiudere la race descritta nella sezione 1, `TerminalPane` registra un handler temporaneo sul bus output prima dell’effetto di spawn e attende che il listener Tauri globale sia pronto prima di chiamare `terminal_spawn`. L’handler reale subentra subito dopo senza lasciare una finestra senza subscriber.

## Verifica eseguita

È stato aggiunto `scripts/terminal-regression.test.mjs`, con controlli sui quattro punti critici:

- listener output pronto prima dello spawn;
- rifiuto di blur e dimensioni a 2 colonne;
- ripristino del terminale attivo al rientro in cache;
- overlay drag non interattivo e teardown che salva l’ultimo intento di scroll.

Risultati finali:

- regressioni terminali: **5/5 pass**;
- suite frontend/Jarvis: **57/57 pass**;
- adapter notifiche: **pass**;
- TypeScript strict: **pass**;
- `cargo fmt --check`: **pass**;
- `cargo check --release`: **pass**;
- test Rust con `-D warnings`: **158/158 pass**.

Clippy è arrivato al codice ma resta bloccato da due lint preesistenti in `src-tauri/src/jarvis/control.rs` (`unnecessary_sort_by`, righe 783 e 793), che non appartengono ai file modificati per questi bug e non sono stati cambiati per non interferire con Jarvis. La prima esecuzione della suite strict era inoltre incappata nella differenza di toolchain locale (`cargo` 1.94 contro Clippy 1.97); le verifiche Rust finali sono state eseguite con stable 1.97 e target isolato su `D:\rust`.

---

## 6. Audit read-only successivo: problemi ancora da correggere

Questo audit è stato eseguito senza modificare file, senza formattare e senza ripristinare le modifiche già presenti nel worktree.

### Verifiche eseguite

- regressioni terminali dirette: **5/5 pass**;
- suite UI/Jarvis/E2E: **51/51 pass**;
- test Rust del terminal engine: **7/7 pass**;
- TypeScript: **pass**;
- `npm run test:terminal`: comando non definito in `package.json`; il test corretto è stato eseguito direttamente con `node --test scripts/terminal-regression.test.mjs`.

I test verdi non coprono ancora tutti i confini tra generazioni PTY e riaperture.

### 6.1 Eventi stale tra generazioni PTY

`terminal_reopen` riutilizza lo stesso `terminalId` ma crea una nuova generazione backend. Tuttavia `TerminalOutput` e `TerminalExited` trasportano solo:

```text
terminalId
```

Non trasportano la generazione e il frontend non può quindi distinguere un evento tardivo della vecchia sessione da uno appartenente al nuovo PTY. Un output vecchio potrebbe essere scritto nel nuovo xterm oppure un vecchio evento di uscita potrebbe marcare come chiusa la nuova sessione.

**Confidenza: alta.** È un bug di identificazione del flusso tra generazioni.

### 6.2 Riapertura manuale senza reidratazione completa

Il percorso `handleRestart` invoca `terminal_reopen`, marca il terminale come avviato e poi esegue `xterm.reset()`. Non esegue però la stessa reidratazione completa dello snapshot usata al mount (`terminal_get_screen_text`).

Il nuovo prompt o output può arrivare prima del reset e venire cancellato; in alternativa il terminale riaperto può partire senza stato iniziale coerente.

**Confidenza: alta.** Il percorso di riapertura manuale non riusa la barriera snapshot/watermark del mount.

### 6.3 Exit code sempre riportato come zero

Il backend controlla l’uscita del processo con `try_wait()`, ma ignora lo status reale (`_status`) e pubblica sempre:

```text
exit_code: 0
```

Un processo terminato con codice diverso da zero viene quindi mostrato come se fosse terminato correttamente.

**Confidenza: alta.** Il valore viene impostato staticamente nei percorsi reader e watchdog.

### 6.4 Possibile stato active incoerente dopo errore

`TerminalManager::set_active` aggiorna `active_id` prima di completare la validazione e lo spawn del terminale target. Se lo spawn fallisce, l’ID attivo può puntare a una sessione non utilizzabile oppure il terminale precedente può restare marcato come inattivo.

**Confidenza: media-alta.** Il problema si manifesta solo quando il cambio terminale incontra un errore backend.

### 6.5 Resize fallback durante layout instabile

Nel percorso `syncMeasuredPtySize`, la prima correzione usava la dimensione stabile salvata, inizialmente `80×24`, e la inviava comunque al PTY quando la misura WebView2 non era stabile. Questo poteva ridimensionare temporaneamente un PTY vivo prima che il layout reale fosse disponibile.

**Esito dell’audit:** regressione confermata e corretta. Una misura instabile ora interrompe il passaggio senza chiamare `terminal_resize`; il prossimo fit stabile applica direttamente la geometria reale.

### 6.6 Copertura test mancante

Mancano test espliciti per:

- eventi output/exit vecchi dopo `terminal_reopen`;
- riapertura mentre arrivano chunk PTY;
- exit code non zero;
- fallimento di `set_active` senza corrompere l’ID attivo precedente;
- resize concorrenti durante una transizione di generazione.

Le note 6.1–6.4 restano problemi backend indipendenti dalle correzioni terminal/workspace di questa analisi; non sono stati modificati per non sovrapporsi alle modifiche Jarvis correnti. La nota 6.5 era invece una regressione della patch di resize ed è stata corretta nel codice e nel test di regressione.
