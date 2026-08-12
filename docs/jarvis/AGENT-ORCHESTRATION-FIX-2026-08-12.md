# Jarvis — lifecycle, titoli e orchestrazione agenti

## Pinpoint delle cause

1. `TerminalSession.process_alive` descriveva la shell ConPTY. Quando il CLI
   agente terminava, PowerShell restava viva e il registry continuava a vedere
   una sessione agentica.
2. Il detector del process tree smetteva di osservare un'identità ad alta
   confidence e non aveva una transizione `presente -> assente`; provider e
   `is_agent_terminal` rimanevano quindi sticky.
3. Dieci secondi senza output trasformavano `working` in `waiting`. Il silenzio
   della PTY non dimostra il completamento di un Agent turn.
4. L'identità `terminalId + generation` distingueva la vita della PTY, ma non
   `/clear`, `/new` o il riavvio del CLI dentro la stessa PowerShell.
5. La navbar calcolava `Agente — progetto` nel frontend, mentre Jarvis riceveva
   il titolo persistito (`Codex`, `Terminal`, ecc.). `agent.list` non esponeva
   inoltre alcun titolo.
6. Il piano conversazionale eseguiva ogni operazione in serie e terminava al
   primo errore. Il contesto operativo veniva costruito una sola volta e il
   compattatore poteva cancellare workspace/provider necessari al routing.
7. I thread Codex sono effimeri e la memoria UI era soltanto in RAM: dopo un
   restart Jarvis poteva perdere il contesto di una delega precedente.

## Contratti implementati

- PTY e processo agente hanno liveness separate. Un launcher agentico noto
  (`node.exe`, `npm`, `cmd`, ecc.) resta valido come discendente della shell;
  processi background arbitrari non contano. Tre snapshot completi
  senza discendenti demotono il pane a PowerShell. Un errore CIM non conta come
  assenza.
- Solo gli adapter provider e l'evento locale `turn_completed` portano un turn
  a `waiting`. L'output idle non produce completion.
- La sola presenza del CLI indica `waiting`, non `working`: lo stato diventa
  `working` esclusivamente dopo un prompt committed, dell'utente o di Jarvis.
- Ogni reset o rilancio nello stesso PTY crea un nuovo epoch logico e conserva
  il precedente come history `exited`. Anche un cambio di `providerSessionId`
  ruota l'epoch.
- Il backend calcola il titolo effettivo con la stessa precedenza della navbar:
  rename persistito, altrimenti `Agente/Shell — cartella CWD`. Il titolo è
  allegato agli agenti correlando workspace, terminale e generation; resta un
  hint non attendibile, mai una chiave di ownership.
- Ogni step del piano aggiorna terminali e registry. Send indipendenti verso
  agenti distinti possono essere eseguiti in parallelo e producono receipt
  separati; il fallimento di un send non annulla gli altri. Handoff e mutazioni
  dipendenti restano ordinati e fail-stop.
- Se la richiesta corrente nomina esplicitamente un provider supportato senza
  sessione live, `agent_send` può aprire il terminale visibile e consegnare il
  task. Nessun agente viene aperto proattivamente fuori dalla richiesta.
- La conversazione recente è bounded e persistita nell'app-data. Ogni turno
  riceve un digest operativo fresco; la cronologia passata dà contesto ma non
  autorizza nuove azioni.
- La diagnostica controlla gli adapter senza scrivere. `Installa/Ripara` è
  l'unico percorso che modifica le configurazioni utente tramite lo script
  bundled; gli agenti già aperti devono essere riavviati.

## Piano di verifica

1. Unit test della state machine presenza/assenza con shell viva.
2. Registry test per completion notificata, silenzio, reset e rilancio epoch.
3. Contract test dei titoli automatici, rename e demozione a PowerShell.
4. Contract test del digest fresco, memoria persistente e invarianti del
   compattatore.
5. Test del piano multi-agent e degli adapter; suite Rust completa con manifest
   common-controls Windows.
6. Typecheck TypeScript e suite statiche/integration già previste dal progetto.
