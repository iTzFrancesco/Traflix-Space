# Tickets: Terminal Title Bar

Aggiungere una barra del titolo full-width in cima a ogni terminale, con pallino colore workspace, nome sessione (agente + progetto), branch git, rename con doppio click, e pulsanti focus/close.

Fonte: `docs/specs/terminal-title-bar.md`

Lavora la **frontier**: qualsiasi ticket i cui blocker sono completati. Per una catena lineare pura procedi dall'alto verso il basso.

## 1. shared-workspace-colors

**What to build:** Estrarre `WORKSPACE_COLORS` e `getWorkspaceColor()` da `Sidebar.tsx` in un nuovo modulo `src/lib/workspaceColors.ts`, così che sia importabile da `TerminalPane.tsx` senza creare dipendenze circolari. `Sidebar.tsx` importa dal nuovo file invece di dichiarare le costanti inline.

**Blocked by:** None — can start immediately.

- [ ] Nuovo file `src/lib/workspaceColors.ts` esporta `WORKSPACE_COLORS` (array di 8 stringhe hex) e `getWorkspaceColor(index: number): string`
- [ ] `Sidebar.tsx` importa da `workspaceColors.ts` invece di dichiarare le costanti
- [ ] `npx tsc --noEmit` passa senza errori
- [ ] `npm run build` passa
- [ ] Sidebar mostra ancora i colori corretti

## 2. backend-git-branch

**What to build:** Nuovo IPC command `get_git_branch(terminal_id)` che esegue `git -C <cwd> branch --show-current 2>null` e ritorna `Some("branch-name")` o `None` se non in un repo git. Il terminale esiste già con un CWD salvato nella sessione.

**Blocked by:** None — can start immediately.

- [ ] Metodo `get_git_branch(&self, id: &str) -> Result<Option<String>, String>` su `TerminalManager` in `mod.rs`
- [ ] Comando IPC in `commands.rs` con decorator `#[tauri::command]`
- [ ] Registrazione comando in `main.rs`
- [ ] `cargo check` passa
- [ ] Branch letto correttamente da CWD della sessione
- [ ] `None` ritornato per cartelle non-git
- [ ] Errore gestito gracefulmente

## 3. terminal-store-titles

**What to build:** Aggiungere `terminalTitles: Record<string, string>` e `renameTerminal(id, title)` action in `terminalStore.ts`. I titoli personalizzati vivono solo in memoria (Zustand senza `persist` per questo campo). Il comportamento di fallback: se un terminale non ha un titolo in `terminalTitles`, la UI usa il nome derivato automaticamente.

**Blocked by:** None — can start immediately.

- [ ] `terminalTitles: Record<string, string>` aggiunto allo stato iniziale
- [ ] `renameTerminal(id, title): void` action implementata
- [ ] `renameTerminal` non persiste (nessun `partialize` per questo campo)
- [ ] `npx tsc --noEmit` passa
- [ ] Test rapido: chiamata `renameTerminal` via console → store aggiornato

## 4. title-bar-ui

**What to build:** Sostituire la toolbar `position: absolute` in `TerminalPane.tsx` con una barra del titolo full-width in layout flex-column. La barra contiene:

**Sinistra:** pallino colore workspace (da `workspaceColors.ts`) + nome sessione. Il nome è derivato automaticamente da `agentId` + CWD. Se l'utente ha rinominato (da `terminalTitles` nello store), usa quello.

**Destra:** branch git (da `get_git_branch` chiamato dopo rehydrate) + pulsanti focus/close esistenti.

**Comportamenti:** doppio click sul nome → input editabile inline (Enter conferma, Escape annulla). Troncamento con ellissi per nomi lunghi. L'xterm è spostato sotto la barra in layout flex-column.

**Blocked by:** 1 (shared-workspace-colors), 2 (backend-git-branch), 3 (terminal-store-titles)

- [ ] Container del pane passa a `flex-direction: column`
- [ ] Title bar full-width: 28px height, flex-shrink: 0, stesso background del pane
- [ ] Pallino colore workspace a sinistra (cerchio 8×8px con colore da `getWorkspaceColor`)
- [ ] Nome sessione derivato: `agentId ? "<agentName> — <project>" : "<shell> — <project>"`
- [ ] Branch git mostrato a destra (da `get_git_branch` dopo rehydrate), nascosto se `None`
- [ ] Pulsanti focus e close mantenuti all'estrema destra
- [ ] Doppio click sul nome → input editabile (Enter = conferma, Escape = annulla)
- [ ] Troncamento con ellissi via CSS `text-overflow: ellipsis`
- [ ] xterm container sotto la barra con `flex: 1`
- [ ] Branch letto su evento rehydrate, non in polling
- [ ] `npx tsc --noEmit` passa
- [ ] `npm run build` passa
- [ ] `npm run tauri dev` — title bar visibile e funzionante
