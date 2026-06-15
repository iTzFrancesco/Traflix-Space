# Traflix Space — Rifinizione & Nuove Feature

> Ultimo aggiornamento: 2026-06-15
> Stato attuale: v0.1.1 — Feature core complete, manca polish e feature advanced

---

## Stato Attuale

| Area | Completamento | Note |
|------|:---:|------|
| Foundation (Tauri 2 + React 19 + Vite 6) | 100% | Stack moderno, zero errori build |
| Workspace Core (Wizard 4 step + CRUD) | 95% | Funzionale, mancano refinement UX |
| Terminali (xterm.js + ConPTY nativo) | 95% | Funzionale, mancano feature extra |
| Agenti (Registry + Auto-launch) | 90% | 3 agenti + custom, manca gestione errori |
| Polish (Animazioni + Dark Theme) | 75% | Base solida, manca dettagli |
| **Complessivo** | **~92%** | |

---

## Priorità 1 — Bug Fix & Robustezza

### 1.1 Gestione errori PTY migliorata
- [ ] Aggiungere `GetLastError()` nei messaggi di errore Win32 per debugging
- [ ] Toast automatico quando un terminale muore inaspettatamente
- [ ] Riconnessione automatica PTY dopo crash (opzionale)

### 1.2 API Key Security
- [ ] Crittografia API keys con crate `keyring` o DPAPI Windows
- [ ] Mascheramento chiavi in logs (mai loggare API keys)
- [ ] Validazione formato API key prima del salvataggio

### 1.3 Blocking I/O → Async
- [ ] Spostare `std::fs` su `tokio::fs` nei comandi Tauri async
- [ ] Workspace registry: `load()` e `save()` async
- [ ] Settings store: `load_from_disk` e `save_to_disk` async

---

## Priorità 2 — UX Refinement

### 2.1 Sidebar Interattiva
- [x] **Redesign sidebar** — split in Workspaces + Terminals, rimosso Settings
- [x] **Colored workspace icons** — bordo laterale colorato + icona quadrata per workspace
- [x] **Conteggio terminali attivi** — badge numero accanto al nome workspace
- [x] **Terminali interattivi** — click per navigare al workspace, rename inline
- [ ] **Collapse/Expand sidebar** — riduci a icone ( già in uiStore, da connettere alla UI )
- [ ] **Ricerca workspace** — barra di ricerca nella sidebar (gia in uiStore, da connettere )
- [ ] **Drag & drop reorder** — riordinare workspace con drag

### 2.2 Context Menu (Right-click)
- [ ] Menu contestuale sui workspace (rinomina, elimina, duplica)
- [ ] Menu contestuale sui terminali (chiudi, chiudi tutti, rinomina)
- [ ] Menu contestuale nella griglia (aggiungi terminale, layout)

### 2.3 Terminali — Miglioramenti
- [ ] **Split orizzontale/verticale** — dividere un terminale in due
- [ ] **Tabs nei terminali** — multiplexing dentro un singolo pane
- [ ] **Search nel terminale** — Ctrl+F per cercare nello scrollback
- [ ] **Copy/Paste migliorato** — Ctrl+Shift+C/V come nel真正的 terminale
- [ ] **Link detection** — click su URL per aprire nel browser

### 2.4 Workspace — Miglioramenti
- [ ] **Rename workspace** — rinomare direttamente dalla sidebar
- [ ] **Import/Esporta workspace** — condividere configurazioni
- [ ] **Workspace recenti** — sezione "ultimi aperti" in cima alla sidebar
- [ ] **Icona workspace** — emoji o icona personalizzata per workspace

---

## Priorità 3 — Feature Advanced

### 3.1 Monitoring Dashboard
- [ ] **Process monitor** — CPU/RAM usage per terminale
- [ ] **Output log** — salvataggio output terminale su file
- [ ] **Session history** — rivedere output delle sessioni passate

### 3.2 Multi-Agent Orchestration
- [ ] **Agent status live** — indicatore stato agente (running/idle/error)
- [ ] **Agent output routing** — redirect output agente a terminale specifico
- [ ] **Agent templates** — salvare configurazioni agente riutilizzabili
- [ ] **Concurrent agents** — lanciare più agenti nello stesso terminale

### 3.3 Plugin System
- [ ] **Custom commands** — registrare comandi custom nell'UI
- [ ] **Hooks** — pre/post hook per eventi (workspace open, terminal create)
- [ ] **Theme engine** — temi personalizzabili da file JSON

### 3.4 Integrations
- [ ] **Git integration** — status branch, commit, diff direttamente nell'UI
- [ ] **Docker** — gestione container da sidebar dedicata
- [ ] **SSH** — connessione a server remoti
- [ ] **Port forward** — visualizzare e gestire port forwarding

---

## Priorità 4 — Code Quality

### 4.1 Testing
- [ ] Setup Vitest per frontend
- [ ] Test unitari per stores (workspaceStore, terminalStore)
- [ ] Test integrazione per hooks
- [ ] Setup cargo-test per backend Rust

### 4.2 Linting & Formatting
- [ ] Configurare ESLint + Prettier
- [ ] Regole di import ordering
- [ ] Pre-commit hooks con husky

### 4.3 CI/CD
- [ ] GitHub Actions per build automatico
- [ ] Release workflow con changelog automatico
- [ ] Auto-update notifiche (Tauri updater plugin)

### 4.4 Documentation
- [ ] README.md completo con installazione, usage, screenshots
- [ ] Contributing guidelines
- [ ] API documentation per i comandi IPC
- [ ] User guide con screenshots

---

## Priorità 5 — Polish & Design

### 5.1 Visual
- [ ] **Ombre e profondità** — elevation system per cards e modali
- [ ] **Transizioni page** — animazioni di transizione tra workspace
- [ ] **Loading states** — skeleton loaders per caricamento dati
- [ ] **Empty states** — illustrazioni per stati vuoti (no workspace, no terminals)
- [ ] **Micro-interactions** — hover effects, click feedback

### 5.2 Accessibility
- [ ] **Keyboard navigation** — Tab navigation completa
- [ ] **Screen reader** — ARIA labels su tutti gli elementi interattivi
- [ ] **High contrast** — tema ad alto contrasto opzionale
- [ ] **Font size** — resize font con Ctrl+Plus/Minus

### 5.3 Performance
- [ ] **Code splitting** — lazy loading per modali e componenti pesanti
- [ ] **Virtual scrolling** — per liste lunghe (workspaces, history)
- [ ] **Web Worker** — processare output PTY in worker separato
- [ ] **Memory optimization** — limitare output buffer nei terminali

---

## Changelog

### v0.1.2 (2026-06-15) — Sidebar Redesign v2
- Rimosso completamente la sezione Terminali dalla sidebar
- Aggiunta rinomina workspace inline (pencil icon su hover)
- Migliorato spacing e respirabilità della sidebar
- Stile premium con font Syne per header, Poppins per corpo
- Animazioni fluide con spring physics (stiffness: 500, damping: 35)
- Transizioni hover con cubic-bezier custom

### v0.1.1 (2026-06-15) — Sidebar Redesign
- Redesign sidebar: split in Workspaces + Terminali
- Rimosso Settings dalla sidebar
- Bordi laterali colorati + icone quadrate per workspace
- Badge conteggio terminali per workspace
- Terminali interattivi: rename inline, click per navigare al workspace
- Stile pulito e minimal ispirato a BridgeMind

### v0.1.0 (2026-06-15) — Current
- Setup iniziale Tauri 2 + React 19 + Vite 6
- Workspace CRUD con wizard 4 step
- Terminali xterm.js con ConPTY nativo
- 3 agenti AI (Aider, OpenCode, Claude Code) + Custom
- API key management con persistenza
- Dark theme con design system Tailwind v4
- Fix bug critici e rimozione dead code
