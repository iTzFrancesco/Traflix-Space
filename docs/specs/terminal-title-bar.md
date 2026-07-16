# Spec: Terminal Title Bar

## Problem Statement

I terminali di Traflix Space non hanno un titolo visibile. L'unica toolbar mostra solo i pulsanti focus e close in alto a destra. Quando si hanno più terminali aperti, è difficile capire a colpo d'occhio quale agente sta girando, in quale repository si sta lavorando, o su quale branch git ci si trova. Questo è particolarvero critico quando si lavora con agenti LLM (OpenCode, Claude Code) su più progetti contemporaneamente.

## Solution

Aggiungere una barra del titolo full-width in cima a ogni terminale, con:
- **Sinistra:** pallino colorato del workspace + nome completo della sessione (agente + progetto, o solo progetto)
- **Destra:** branch git corrente + pulsanti focus/close esistenti

La barra ha altezza fissa (28px), stessa dei pulsanti attuali. Il nome è editabile con doppio click. Branch e nome progetto vengono aggiornati durante la reidratazione del terminale.

## User Stories

1. Come utente, voglio vedere a colpo d'occhio in che repository sta lavorando un terminale, così da non dover indovinare o guardare il prompt.
2. Come utente, voglio vedere il branch git corrente nella barra del titolo, così da sapere su quale branch sto lavorando senza dover digitare `git branch`.
3. Come utente, voglio un pallino colorato che identifica il workspace a cui appartiene il terminale, così da associare visivamente i terminali al workspace corretto.
4. Come utente con più workspace aperti, voglio colori diversi per ogni workspace (arancio, ciano, viola, verde, giallo, rosso, rosa, blu), così da distinguerli immediatamente.
5. Come utente che usa agenti LLM (OpenCode, Claude Code), voglio vedere nella barra il nome dell'agente + il progetto (es. "OpenCode — Traflix-Space"), così da sapere quale agente sta eseguendo in quel terminale.
6. Come utente che usa una shell normale (PowerShell), voglio vedere "PowerShell — nome-progetto", così da avere un contesto immediato.
7. Come utente, voglio rinominare manualmente il titolo del terminale con doppio click, così da personalizzarlo se il nome automatico non è descrittivo.
8. Come utente, voglio che il nome editato venga perso al refresh (solo in memoria), così da non accumulare dati sporchi persistenti.
9. Come utente, voglio che il nome del terminale sia derivato automaticamente dal CWD (ultimo segmento del path), così da non doverlo inserire manualmente.
10. Come utente, voglio che il branch git venga mostrato solo quando disponibile (non in cartelle non-git), così da non occupare spazio inutilmente.
11. Come utente, voglio che i nomi lunghi vengano troncati con ellissi (...) quando non entrano nella barra, così da non rompere il layout.
12. Come utente, voglio che la barra sia visibile anche in focus mode, così da non perdere il contesto quando un terminale è ingrandito.
13. Come utente, voglio che la barra abbia la stessa altezza in tutti i terminali (fissa, non scalabile col numero di terminali), così da avere un layout prevedibile.
14. Come utente, voglio che il layout del pannello sia flex-column (barra sopra, xterm sotto), così che la barra non si sovrapponga mai all'output del terminale.
15. Come utente, voglio che il branch git venga rilevato su evento (rehydrate), non in polling continuo, così da non sprecare risorse.

## Implementation Decisions

### Moduli da creare/modificare

1. **`src/lib/workspaceColors.ts`** (NUOVO)
   - Esportare `WORKSPACE_COLORS` array e `getWorkspaceColor(index: number): string`
   - Estratto da `Sidebar.tsx` per evitare dipendenze circolari

2. **`src-tauri/src/terminal_engine/commands.rs`** (modifica)
   - Aggiungere comando IPC `get_git_branch(terminal_id: String) -> Result<Option<String>, String>`
   - Esegue `git -C <cwd> branch --show-current` nel backend

3. **`src-tauri/src/terminal_engine/mod.rs`** (modifica)
   - Aggiungere metodo `get_git_branch(&self, id: &str) -> Result<Option<String>, String>`
   - Legge il CWD dalla sessione del terminale (già disponibile in `TerminalSession.cwd`)
   - Esegue il comando git e ritorna l'output

4. **`src-tauri/src/main.rs`** o registro comandi (modifica)
   - Registrare il nuovo comando `get_git_branch`

5. **`src/stores/terminalStore.ts`** (modifica)
   - Aggiungere `terminalTitles: Record<string, string>` per i titoli editati dall'utente
   - Aggiungere `renameTerminal(id: string, title: string)` action
   - `updateTitle()` già esiste — può essere usato o esteso

6. **`src/components/workspace/TerminalPane.tsx`** (modifica principale)
   - Aggiungere `TerminalTitleBar` sotto-componente inline
   - Sostituire toolbar `position: absolute` con layout flex-column:
     - Barra full-width sopra (28px height)
     - Container xterm sotto (flex: 1)
   - Barra sinistra: pallino colore + nome sessione
   - Barra destra: branch git + focus button + close button
   - Doppio click sul nome → input editabile inline
   - Chiamata `get_git_branch` dopo rehydrate

### API Contracts

#### Nuovo IPC: `get_git_branch`

```
get_git_branch(terminal_id: String) -> Result<Option<String>, String>
```

- Input: `terminal_id` della sessione
- Output: `Some("main")` o `Some("migliorie-grok")` se in un repo git, `None` se non in un repo git
- Error: se il terminale non esiste o git fallisce
- Implementazione: esegue `git -C <cwd> branch --show-current 2>null` catturando stdout
- CWD letto dalla sessione del terminale

#### Stato titoli in memoria

```typescript
interface TerminalStore {
  // ... esistente ...
  terminalTitles: Record<string, string>;  // id -> titolo personalizzato
  renameTerminal: (id: string, title: string) => void;
}
```

- `terminalTitles` contiene solo i titoli che l'utente ha **esplicitamente rinominato**
- Se non presente in `terminalTitles`, si usa il titolo derivato (agente + progetto)
- Non persiste su disco (Zustand senza `persist` per `terminalTitles`)

### Layout pannello

Prima (attuale):
```
┌──────────────────────────┐
│                    [⊞][✕]│  ← toolbar position: absolute
│                          │
│     (xterm output)       │
│                          │
└──────────────────────────┘
```

Dopo:
```
┌──────────────────────────┐
│ ● OpenCode — Traflix-Space  │  ← title bar full-width, 28px
│   main              [⊞][✕]│
├──────────────────────────┤
│                          │
│     (xterm output)       │
│                          │
└──────────────────────────┘
```

Layout: `flex-direction: column` sul container del pane.
- Title bar: height 28px, flex-shrink: 0
- Terminal container: flex: 1

### Derivazione nome automatico

Al mount / rehydrate:
1. Prendere `cwd` → ultimo segmento del path
2. Se `agentId` è presente: `"<agentName> — <projectName>"`
3. Se shell predefinita (powershell.exe, pwsh.exe, cmd.exe, bash, zsh): `"PowerShell — <projectName>"` o simile
4. Se shell custom: `"<shell> — <projectName>"`

### Doppio click rename

- Doppio click sul nome → sostituisce lo span con un `<input>` di testo
- L'input ha lo stesso stile della barra (stesso font, colore, background trasparente)
- Submit: Enter o blur
- Cancel: Escape (ripristina nome originale)
- Al submit: chiama `terminalStore.renameTerminal(id, nuovoNome)`
- L'input non ha bordo/outline evidente — si mimetizza con la barra

### Troncamento

- Nome progetto: max ~200px via CSS `text-overflow: ellipsis`
- Branch: occupa spazio residuo prima dei pulsanti
- Media query implicita: se la somma non entra, il branch si tronca prima del nome

### Focus mode

- In focus mode la barra rimane visibile
- Stessa altezza, stessi elementi, stesso comportamento

## Testing Decisions

### Cosa testare (comportamento esterno)

1. **Titolo automatico corretto**: quando un terminale viene creato con `cwd = "C:\Users\proj\Traflix-Space"` e `agentId = "opencode"`, il titolo visualizzato deve essere `"OpenCode — Traflix-Space"`.
2. **Titolo editato persiste in memoria**: dopo rename via doppio click, la store `terminalTitles` contiene il nuovo nome.
3. **Branch su rehydrate**: dopo workspace switch, il branch viene recuperato e mostrato nella barra.
4. **Colore workspace**: il pallino ha colore corrispondente all'indice del workspace nella lista.
5. **Troncamento**: con nome lungo, ellipsis applicato senza rompere il layout.
6. **Doppio click**: apre input, Enter conferma, Escape annulla.

### Cosa NON testare (dettagli implementativi)

- Non testare il componente React isolatamente (è puramente presentazionale)
- Non testare il parsing del CWD
- Non testare l'esecuzione di git in Rust (si testa l'IPC contract)

### Prior art

- `TerminalPane.tsx` ha già logica di mount/rehydrate testata via effetti
- `terminalStore.ts` ha già action pattern per `updateTitle`
- `get_screen_text` è il pattern IPC per dati derivati dal backend

## Out of Scope

- **Naming LLM-generated**: non si analizza il contenuto dell'output dell'agente per generare titoli descrittivi. Il nome deriva solo da CWD + agentId.
- **Persistenza su disco dei titoli**: i titoli editati vivono solo in RAM (Zustand senza persist). Alla chiusura dell'app si perdono.
- **Polling continuo del branch**: il branch viene letto solo su rehydrate (evento), non ogni N secondi.
- **Icone custom per agenti**: solo testo, nessuna icona/logo nella barra.
- **Drag-and-drop della barra**: la barra non è un handle per spostare il terminale.
- **Tooltip sul nome**: non si mostra il nome completo in tooltip al posto dell'ellipsis.
- **Dropdown menu dalla barra**: nessun menu contestuale al click sulla barra.
- **Colorazione automatica del bordo in base al workspace**: solo il pallino usa il colore workspace.

## Further Notes

- Il branch git viene letto con `git -C <cwd> branch --show-current 2>null`. Se git non è installato o la cartella non è un repo, ritorna `None` e la sezione branch non viene mostrata.
- Il nome dell'agente (es. "OpenCode", "Claude Code") viene dalla mappa in `src/lib/agents.ts` → campo `name` o `description`.
- I workspace colors sono un array di 8 colori definito in `Sidebar.tsx`. Va estratto in file condiviso per evitare dipendenze circolari.
- Il terminale in focus mode ha bordo azzurro (`#3b82f6`). Il pallino del workspace rimane del colore del workspace (non cambia in focus mode).
- La barra ha stesso font dell'app (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`).
- L'input di rename ha `font-size: 12px` come il resto della barra.
