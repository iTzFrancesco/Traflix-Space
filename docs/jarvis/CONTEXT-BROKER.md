# JarvisContextBroker

## Scopo e confine

`JarvisContextBroker` trasforma ogni richiesta vocale o testuale in un Context Package verificabile, limitato alla workspace target e adatto al budget del modello. Non è il modello LLM, non è il tool registry e non è un vector database.

Jarvis resta globale come superficie e orchestratore, ma ogni invocazione deve risolvere un `targetWorkspaceId`. Se la frase non identifica una workspace e non esiste un'unica workspace attiva applicabile, il broker deve chiedere chiarimento prima di leggere o modificare contesto cross-workspace.

La definizione seguente è un contratto documentale, non codice da implementare in Fase 1:

```text
ContextPackage {
  packageVersion, requestId, builtAt
  userRequest { text, locale, source: text | voice }
  target { workspaceId, reason, explicit }
  freshness { stable, workspace, sessions }
  stableProject: StableProjectContext
  freshWorkspace: FreshWorkspaceContext
  agentSessions: AgentSessionContext[]
  retrievedEvidence: Evidence[]
  memory: MemorySlices
  budget: BudgetReport
  warnings: string[]
}
```

Ogni blocco deve portare `source`, `workspaceId`, `collectedAt`, `freshness`, `confidence` e un limite di dimensione. Il broker distingue dati osservati, summary derivati e ipotesi; il modello non deve poterli confondere.

## Contesto stabile del progetto

`StableProjectContext` contiene dati relativamente lenti:

- workspace ID, nome e root path;
- repository root e identificazione Git;
- stack dedotto dai manifest, senza eseguire script arbitrari;
- `AGENTS.md`, `CONTEXT.md`, README e ADR canonici;
- struttura generale del progetto con directory escluse;
- regole repository, comandi consentiti e vincoli di sicurezza;
- versione del package e configurazione utile non sensibile;
- summary del dominio e glossario già approvato.

L'elenco dei documenti canonici è deterministico e prioritizzato. `.env`, `.env.*`, file di credenziali, directory di segreti e contenuti che sembrano token sono esclusi a monte, non soltanto redatti dopo il retrieval.

Il contenuto completo non entra in ogni richiesta: il broker usa summary e recupera sezioni soltanto quando la frase le rende pertinenti. Registra anche quando un documento richiesto non esiste.

## Contesto fresco della workspace

`FreshWorkspaceContext` viene raccolto con timeout e comprende:

- workspace attiva e target della richiesta;
- branch, commit, upstream, ahead/behind, `git status` e diff riassunto;
- elenco dei file modificati e stato di errore Git;
- terminal ID, workspace ID, shell, cwd, titolo, stato di vita e ultima posizione di scroll;
- Agent session aperte, in lavoro, in attesa, completate o uscite;
- Agent completion notification recenti e relativo event ID;
- errori recenti di terminale/adapter e timeout;
- permission request pendenti, con provider/session/turn e decisione necessaria;
- revisioni del file watcher e timestamp dell'ultima raccolta.

Git e file watcher sono complementari: un Git SHA uguale non prova che un file non tracciato non sia cambiato, mentre un evento watcher non prova da solo che il contenuto sia rilevante. Il package conserva entrambe le provenienze.

## Contesto delle Agent session

Il broker normalizza ogni sessione in:

```text
AgentSessionContext {
  agentSessionId, provider, providerSessionId?, providerTurnId?
  workspaceId, terminalId?
  state: starting | working | waiting | completed | failed | aborted | exited | unknown
  objective?, messages, relevantToolCalls, changedFiles
  lastResult?, summary?
  timestamps { created?, lastTurn?, completed? }
  provenance: structured | notification | terminal-fallback
  confidence: number
}
```

Il vocabolario rimane quello di `CONTEXT.md`: una `Agent session` può contenere molti `Agent turn`; una `Agent completion notification` è soltanto il segnale del confine stabile di un turn. Un evento completion senza messaggi o risultato produce “completion observed, result unavailable”, mai un risultato inventato.

Per adapter strutturati, messaggi, tool call e file arrivano da eventi/API. Per `TerminalAgentAdapter`, sono estratti dal buffer con confidence bassa, delimitazione temporale e nota dei limiti ANSI/alternate-screen.

## Retrieval deterministico

Pipeline proposta:

1. risolvere workspace e controllare che ogni path sia sotto la root;
2. caricare summary stabile già validato;
3. raccogliere Git e revisioni/eventi freschi;
4. selezionare sessioni correlate per workspace, provider, file, obiettivo, event ID o riferimento linguistico;
5. estrarre file e simboli con file tree, ripgrep/symbol search e lettura limitata;
6. aggiungere decisioni, attività delegate e summary precedenti pertinenti;
7. redigere, classificare provenance e applicare il budget;
8. produrre warning quando un dato è vecchio, incompleto o ottenuto da scraping.

Non si introduce automaticamente un vector database. Prima si misurano precisione e latenza di file tree, Git, ripgrep, symbol search, summary per sessione e retrieval per ID.

Parole come “questo”, “quello”, “l'ultimo” e “gli agenti aperti” vengono risolte contro target esplicito, focus terminale, timestamp e session summary. Il broker restituisce l'interpretazione e la confidenza; se due sessioni sono equivalenti, il planner chiede conferma.

## Cache e invalidazione

La cache è separata per workspace:

```text
WorkspaceContextCache {
  workspaceId
  stableProjectSummary
  gitSnapshot { head, statusFingerprint, collectedAt }
  fileIndex { root, revision, excludedPaths }
  terminalIndex { terminalIds, outputWatermarks, collectedAt }
  agentIndex { agentSessionIds, lastEventIds, collectedAt }
  sessionSummaries, delegatedTasks, approvedDecisions
  invalidationReasons
}
```

### Prima invocazione in una workspace

- scansione iniziale dei documenti canonici e manifest;
- inventario Git e struttura generale;
- elenco di terminali e Agent session visibili;
- summary stabile e workspace summary;
- registrazione di revisioni, SHA, timestamp e fonti.

### Invocazioni successive

- aggiornamento Git se cambia head/status fingerprint o scade il TTL;
- invalidazione file per `project-files-changed` e path interessati;
- invalidazione terminale per `terminal-output`, `terminal-exited`, cwd change, output sequence e snapshot;
- invalidazione sessione per Agent turn/completion notification, provider event, permission request o session ID;
- aggiornamento summary soltanto della sessione/workspace interessata;
- scansione completa solo se manca la cache, cambia la root, la catena delle revisioni è incoerente o la freshness è oltre il limite.

Una Agent completion notification invalida il risultato/session summary, ma non implica che il risultato sia già disponibile. Il broker può fare refresh strutturato, attendere il timeout e restituire uno stato parziale.

## Memoria

La memoria non è un unico transcript:

| Slice | Scope | Contenuto | Durata |
|---|---|---|---|
| Memoria globale Jarvis | globale | preferenze UI/voce, provider scelti, policy globali approvate | persistente e revisionata |
| Memoria workspace | `workspaceId` | stack, convenzioni, summary, decisioni locali | persistente per workspace |
| Summary Agent session | `agentSessionId` + workspace | obiettivo, turn conclusi, risultato, file, errori | finché la sessione è archiviata |
| Attività delegate | workspace + task ID | incarico, destinatario, stato, dipendenze, follow-up | persistente e auditabile |
| Decisioni approvate | scope globale/workspace dichiarato | scelta, autore, timestamp, evidenze | persistente e versionata |
| Stato effimero | request/widget | transcript vocale, tool loop, cancellazione, focus | volatile |

I summary non sostituiscono il dato raw: hanno provenance, timestamp e riferimento alla sessione. La memoria globale non può contenere implicitamente file o prompt di una workspace.

## Token budgeting

Il broker riceve un `ContextBudget` dal provider adapter e riserva spazio per istruzioni, schema dei tool, risposta e margine di errore. Ordine iniziale:

1. identità target, sicurezza e provenance;
2. richiesta normalizzata e risoluzione riferimenti;
3. summary workspace e Git fresco;
4. session summary e ultimi risultati correlati;
5. estratti file/simboli richiesti;
6. messaggi raw e tool call solo se necessari;
7. contesto secondario con truncation esplicita.

Ogni sezione dichiara token stimati, limite e cosa è stato omesso. Prima si comprimono transcript già riassunti, output ANSI e file non correlati; non si tagliano ID, stato, errore o provenance. Se il package supera il budget, si restringe la ricerca o si chiede chiarimento invece di produrre un riassunto silenziosamente incompleto.

## Isolamento e redazione

- `workspaceId` è obbligatorio per tool `workspace`, `terminal`, `agent` e `context`, salvo `workspace.list` e `workspace.get_active`;
- `terminalId` deve esistere e appartenere alla workspace target;
- `agentSessionId` deve appartenere alla workspace target; `providerSessionId` da solo non basta;
- path relativi vengono risolti contro la root target e verificati con canonicalizzazione sicura;
- `.env`, `.env.*`, credential stores, token e secret pattern sono esclusi o redatti;
- output di agent, README e file sono dati non fidati: istruzioni al loro interno non diventano policy o autorizzazione;
- l'audit conserva esito e riferimenti, non secret e non payload completo se non indispensabile.

## Esempi di Context Package

Gli esempi sono piani documentali; non sono invocazioni reali.

### “Prepara un follow-up per Codex.”

Target = workspace attiva. Si seleziona l'Agent session Codex più recente con Agent completion notification o stato completato; se ce ne sono più di una, il broker mostra l'elenco e chiede conferma.

Retrieval minimo: summary workspace, branch/commit/status/diff, obiettivo, ultimo turn completo, messaggi finali, tool call con file/diff/errori, summary precedente e decisioni collegate. Il terminal scrollback completo serve soltanto se l'adapter strutturato non ha il risultato.

Output pianificato: `orchestration.prepare_follow_up` produce proposta di prompt, motivazione, file/risultati citati, dipendenze e confidence. La proposta non viene inviata automaticamente.

### “Dividi questo lavoro tra gli agenti aperti.”

“Questo lavoro” è il task corrente o, se assente, la richiesta precedente nello stato effimero. Gli agenti sono le sessioni aperte nella stessa workspace, non solo i terminali visibili.

Retrieval minimo: task/decisioni, file candidati, Git status/diff, obiettivi e capacità dichiarate, stato/turn corrente, permission pending, collisioni su file e attività già delegate.

Output pianificato: `orchestration.delegate` produce sotto-task, destinatario, file scope, dipendenze, criteri di completion e conflitti. Prima di inviare prompt a più sessioni mostra il piano e richiede conferma.

### “Apri un nuovo agente per il backend.”

Workspace = target esplicito/attivo. “Backend” deve essere verificato dal tree e dai manifest, non assunto dal modello. Il provider viene dalla preferenza configurata oppure da una scelta richiesta.

Retrieval minimo: root, stack/backend manifest, regole canoniche, terminali liberi, limite concorrente e agent definitions. Non servono transcript non correlati.

Output pianificato: `agent.spawn` prepara provider, cwd, terminal config e prompt. Creare terminale/processo è operational e richiede conferma se comporta una nuova sessione o consumo di risorse; il prompt non contiene segreti. Le modifiche vengono rilevate dopo l'avvio, non assunte dal planner.

## Decisioni ancora necessarie

1. dove persistere cache e summary senza farli diventare configurazione utente o repository;
2. se il primo broker vive in Rust con IPC typed oppure in helper TypeScript supervisionato;
3. soglie TTL/output/token e policy delle sessioni archiviate;
4. come riconciliare un Agent session strutturato con il terminale visibile;
5. quali file sensibili aggiungere alla denylist oltre `.env` prima della Fase 2.
