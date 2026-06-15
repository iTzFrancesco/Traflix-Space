# Report di Sviluppo: Traflix Space
## Applicazione Desktop Windows — Ambiente di Sviluppo Agentico

**Versione:** 1.0 | **Data:** 15 Giugno 2026  
**Autore:** Francesco (Traflix) | **Stack:** Tauri 2.0 + React + Rust + xterm.js

---

## 1. Executive Summary

**Traflix Space** e l'ambiente di sviluppo desktop per Windows che replica la filosofia di BridgeSpace di BridgeMind.ai — un "Agentic Development Environment (ADE)" — ma con l'identita visiva e il design system del portfolio Traflix. L'app permette di creare **spazi di lavoro persistenti** con terminali multipli, agenti AI integrati e navigazione fluida tramite sidebar.

**Differenziatori chiave rispetto a BridgeSpace:**
- **Design System Traflix:** dark laboratory aesthetic con warm machine orange (#e85d04) come segnale operazionale
- **Zero costi ricorrenti:** open source, nessun abbonamento mensile
- **Controllo totale:** codice proprietario, nessun vendor lock-in
- **Stack moderno:** Tauri 2.0 (Rust) per performance native, bundle ~15MB

---

## 2. Analisi del Prodotto Target: BridgeSpace

### 2.1 Funzionalita Core da Replicare

| Funzionalita | Descrizione BridgeSpace | Approccio Traflix Space |
|--------------|------------------------|------------------------|
| **Workspace/Stanze** | Spazi di lavoro persistenti con preset (Command, Swarm, Review) | Workspace creati con wizard: selezione cartella, numero terminali, agenti |
| **Terminali Multipli** | Fino a 16 terminali in parallelo, grid layout | Grid layout dinamico (1-16 panes) con xterm.js + PTY Rust |
| **Sidebar Navigation** | Menu laterale per switch rapido tra workspace | Sidebar con lista workspace + tabs terminali attivi |
| **Agenti AI** | Claude, Codex, Grok in terminali dedicati | Sidecar/spawn di agenti CLI (Aider, OpenCode, Claude Code) |
| **Persistenza Sessioni** | BridgeMemory con knowledge graph locale | File JSON locale per stato workspace + layout |
| **Kanban Board** | Task management integrato | Fase 2 — integrazione con task runner |

### 2.2 Architettura BridgeSpace (da Reverse Engineering)

BridgeSpace e un'app desktop Tauri con:
- **Frontend:** React/WebView con xterm.js per rendering terminali
- **Backend:** Rust che gestisce PTY (Pseudo Terminal) via `conpty` su Windows
- **Comunicazione:** Tauri IPC (invoke/events) tra frontend e Rust
- **Agenti:** Spawn di processi CLI (Claude Code, Codex CLI) come sidecar
- **Stato:** Gestione locale con file JSON + SQLite per history

Il changelog di BridgeSpace 3.2.1 (giugno 2026) rivela pattern critici:
- Terminal rendering con scheduler globale per gestire multi-agent load
- Focus recovery loop prevention (bug fix ricorrente)
- Backpressure handling per output massivo da agenti
- Session persistence e resume dopo crash

---

## 3. Architettura Tecnica Traflix Space

### 3.1 Stack Completo

```
+---------------------------------------------------------------+
|              FRONTEND (React + TypeScript)                    |
|  +-------------+  +-------------+  +-------------------------+  |
|  |   Sidebar   |  |  Workspace  |  |   Terminal Grid (xterm) |  |
|  |  (Zustand)  |  |   Manager   |  |   1-16 panes            |  |
|  +-------------+  +-------------+  +-------------------------+  |
|  +-------------+  +-------------+  +-------------------------+  |
|  |  Wizard     |  |  Settings   |  |   Agent Launcher        |  |
|  |  New Space  |  |  (Tauri)    |  |   (Sidecar/Spawn)       |  |
|  +-------------+  +-------------+  +-------------------------+  |
+--------------------------+------------------------------------+
                           | Tauri IPC (invoke + events)
+--------------------------+------------------------------------+
|              BACKEND (Rust)                                 |
|  +-------------+  +-------------+  +-------------------------+  |
|  |  PTY Manager|  |  Process    |  |   File System           |  |
|  |  (conpty)   |  |  Spawn/Kill |  |   (Workspace Config)    |  |
|  +-------------+  +-------------+  +-------------------------+  |
|  +-------------+  +-------------+  +-------------------------+  |
|  |  Workspace  |  |  Settings     |  |   Agent Registry        |  |
|  |  Registry   |  |  Store        |  |   (Aider, OpenCode...)  |  |
|  +-------------+  +-------------+  +-------------------------+  |
+---------------------------------------------------------------+
```

### 3.2 Tecnologie Dettagliate

| Livello | Tecnologia | Versione | Ruolo |
|---------|-----------|----------|-------|
| **Frontend Framework** | React 19 + TypeScript | latest | UI components, routing |
| **State Management** | Zustand | v5 | Global state (workspace, terminal, UI) |
| **Styling** | Tailwind CSS + CSS Modules | v4 | Design system Traflix |
| **Terminal Rendering** | xterm.js + WebGL Addon | v5.5 | Terminal emulator nel browser |
| **Build Tool** | Vite | v6 | Bundling, HMR |
| **Desktop Framework** | Tauri 2.0 | v2.0 | Rust backend, WebView, IPC |
| **PTY (Windows)** | conpty + portable-pty | latest | Pseudo terminal nativo Windows |
| **Process Management** | tauri-plugin-shell | v2 | Spawn/kill agenti e shell |
| **Storage** | tauri-plugin-store | v2 | Persistenza settings e stato |
| **File System** | tauri-plugin-fs | v2 | Accesso cartelle workspace |
| **Icons** | Lucide React | latest | Iconografia coerente |

### 3.3 Struttura Progetto

```
traflix-space/
├── src/                          # Frontend React
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx       # Menu laterale workspace
│   │   │   ├── TitleBar.tsx      # Custom window title bar
│   │   │   └── WorkspaceTabs.tsx # Tabs terminali attivi
│   │   ├── workspace/
│   │   │   ├── WorkspaceGrid.tsx   # Grid layout terminali
│   │   │   ├── TerminalPane.tsx  # Singolo terminale (xterm)
│   │   │   ├── NewSpaceWizard.tsx # Wizard creazione workspace
│   │   │   └── SpaceCard.tsx     # Card workspace nella sidebar
│   │   ├── terminal/
│   │   │   ├── XTermWrapper.tsx  # Wrapper xterm.js
│   │   │   ├── TerminalHeader.tsx # Header con titolo e controlli
│   │   │   └── AgentBadge.tsx    # Badge agente attivo
│   │   └── ui/                   # Componenti riutilizzabili (shadcn/ui)
│   ├── stores/
│   │   ├── workspaceStore.ts     # Stato workspace (Zustand)
│   │   ├── terminalStore.ts      # Stato terminali (Zustand)
│   │   └── uiStore.ts            # Stato UI (sidebar, modali)
│   ├── hooks/
│   │   ├── useTauriCommand.ts    # Wrapper invoke Tauri
│   │   ├── useTerminal.ts        # Gestione lifecycle terminale
│   │   └── useWorkspace.ts       # CRUD workspace
│   ├── lib/
│   │   ├── tauri.ts              # Config IPC Tauri
│   │   ├── agents.ts             # Registry agenti disponibili
│   │   └── presets.ts            # Preset workspace predefiniti
│   ├── types/
│   │   ├── workspace.ts          # Tipi workspace
│   │   ├── terminal.ts           # Tipi terminale
│   │   └── agent.ts              # Tipi agente
│   ├── App.tsx                   # Root component
│   └── main.tsx                  # Entry point
├── src-tauri/                    # Backend Rust
│   ├── src/
│   │   ├── main.rs               # Entry point Tauri
│   │   ├── lib.rs                # Registro comandi
│   │   ├── pty/
│   │   │   ├── mod.rs            # Modulo PTY
│   │   │   ├── manager.rs        # Gestione multi-PTY
│   │   │   └── windows.rs        # Implementazione conpty Windows
│   │   ├── workspace/
│   │   │   ├── mod.rs
│   │   │   ├── registry.rs       # Registry workspace (file JSON)
│   │   │   └── commands.rs       # Comandi Tauri workspace
│   │   ├── terminal/
│   │   │   ├── mod.rs
│   │   │   ├── session.rs        # Sessione terminale
│   │   │   └── commands.rs       # Comandi Tauri terminale
│   │   ├── agent/
│   │   │   ├── mod.rs
│   │   │   ├── registry.rs       # Registry agenti
│   │   │   └── launcher.rs       # Lancio agenti (sidecar/spawn)
│   │   └── settings/
│   │       ├── mod.rs
│   │       └── store.rs          # Persistenza settings
│   ├── Cargo.toml
│   ├── tauri.conf.json           # Config Tauri
│   └── capabilities/
│       └── default.json          # Permessi IPC
├── public/
│   └── fonts/                    # Syne, Poppins, JetBrains Mono
├── package.json
├── tailwind.config.ts            # Config design system Traflix
├── tsconfig.json
└── vite.config.ts
```

---

## 4. Design System: Implementazione Traflix

### 4.1 Colori (dal file design)

```css
:root {
  --primary: #e85d04;
  --primary-light: #ff7b00;
  --neutral-bg: #0a0a0a;
  --neutral-surface: #111113;
  --neutral-elevated: #18181b;
  --neutral-darkest: #050505;
  --neutral-text: #f4f4f5;
  --neutral-text-dim: #d4d4d8;
  --neutral-text-muted: #71717a;
  --neutral-border: rgba(255,255,255,0.06);
  --neutral-border-light: rgba(255,255,255,0.03);
}
```

### 4.2 Tipografia

| Ruolo | Font | Peso | Size | Uso |
|-------|------|------|------|-----|
| Display | Syne | 800 | clamp(2.25rem, 6vw, 3.75rem) | Titoli sezione |
| Headline | Syne | 700 | clamp(1.875rem, 5vw, 3rem) | Titoli card |
| Body | Poppins | 400 | clamp(1rem, 2vw, 1.1875rem) | Descrizioni |
| Label | Poppins | 700 | 0.6875rem | Metadata, badge |
| Mono | JetBrains Mono | 500 | 0.75rem | Terminal output, code |

### 4.3 Componenti Chiave

#### 4.3.1 Sidebar (Menu Laterale)

```
+------------------------+
|  [O] TRAFLIX SPACE     |  <- Logo (Syne 800, orange)
+------------------------+
|  + Nuovo Spazio        |  <- CTA primario
+------------------------+
|  [FOLDER] WORKSPACE    |  <- Sezione (Label)
|  |> my-project         |  <- Attivo (bg elevato)
|  |  api-server         |  <- Inattivo
|  |  frontend-app       |
|  |  ai-agent           |
+------------------------+
|  [MONITOR] TERMINALI   |  <- Sezione (Label)
|  |* bash (my-proj)     |  <- Con indicatore attivo
|  |  aider (my-proj)     |  <- Agent badge
|  |  node (api-srv)     |
+------------------------+
|  [GEAR] Settings       |  <- Footer
+------------------------+
```

**Stile:**
- Larghezza: 260px fissa
- Background: #0a0a0a con border-right 1px rgba(255,255,255,0.06)
- Hover workspace: bg rgba(255,255,255,0.025), border-radius 8px
- Workspace attivo: bg #18181b, border-left 2px #e85d04
- Terminali: font mono, badge colore agente

#### 4.3.2 Workspace Grid (Area Principale)

```
+------------------------------------------------------------+
|  my-project                              [=] [+] [-] [x]   |  <- Header workspace
+------------------------------------------------------------+
|  +-----------------+  +-----------------+                  |
|  |  bash           |  |  aider          |  <- Tab header    |
|  |  $ ls -la       |  |  > Add feature  |                  |
|  |  ...            |  |  ...            |                  |
|  |                 |  |                 |                  |
|  +-----------------+  +-----------------+                  |
|  +-----------------+  +-----------------+                  |
|  |  node           |  |  python         |                  |
|  |  > npm start    |  |  > python app.py|                  |
|  |  ...            |  |  ...            |                  |
|  |                 |  |                 |                  |
|  +-----------------+  +-----------------+                  |
+------------------------------------------------------------+
```

**Layout:**
- Grid dinamico: 1x1, 1x2, 2x2, 2x3, 3x3, 4x4 (fino a 16)
- Gap: 8px
- Pane: border-radius 12px, bg #111113, border 1px rgba(255,255,255,0.06)
- Pane attivo: border 1px rgba(232,93,4,0.3), shadow 0 0 20px rgba(232,93,4,0.05)
- Header pane: bg #18181b, border-radius 12px 12px 0 0, padding 8px 12px

#### 4.3.3 Terminal Pane

```
+-------------------------------------+
| [R][Y][G]  bash — ~/projects/my-app|  <- Traffic lights + title
+-------------------------------------+
| $ git status                        |
| On branch main                      |
|                                     |
| $                                   |  <- xterm.js canvas
|                                     |
|                                     |
+-------------------------------------+
```

**Elementi:**
- Traffic lights (R/Y/G): rosso/giallo/verde come macOS (stile Traflix)
- Titolo: processo + working directory (troncata)
- Agent badge: se e un agente AI, badge arancione con nome
- xterm.js: renderer WebGL, tema dark personalizzato

### 4.4 Tema xterm.js (Dark Traflix)

```javascript
const traflixTheme = {
  foreground: '#f4f4f5',
  background: '#111113',
  cursor: '#e85d04',
  cursorAccent: '#0a0a0a',
  selectionBackground: 'rgba(232,93,4,0.3)',
  black: '#18181b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#f4f4f5',
  brightBlack: '#27272a',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa'
};
```

---

## 5. Feature: Creazione Nuovo Spazio di Lavoro

### 5.1 Flow Utente

```
+-------------+     +-----------------+     +---------------------+
| Click       |---->| Wizard Step 1   |---->| Wizard Step 2       |
| "+ Nuovo    |     | Seleziona       |     | Configura Terminali |
|  Spazio"    |     | Cartella        |     |                     |
+-------------+     +-----------------+     +---------------------+
                                                  |
                                                  v
+-------------+     +-----------------+     +---------------------+
| Workspace   |<----| Wizard Step 4   |<----| Wizard Step 3       |
| Creato e    |     | Conferma e      |     | Seleziona Agenti    |
| Aperto      |     | Crea            |     |                     |
+-------------+     +-----------------+     +---------------------+
```

### 5.2 Step 1: Selezione Cartella

**UI:**
- Input con percorso cartella (read-only)
- Bottone "Sfoglia..." che apre dialog Tauri `open`
- Preview contenuto cartella (file principali)
- Checkbox "Usa come root del progetto"

**Backend (Rust):**
```rust
#[tauri::command]
async fn select_workspace_folder(app: AppHandle) -> Result<String, String> {
    let path = app.dialog()
        .file()
        .set_title("Seleziona cartella workspace")
        .blocking_pick_folder()
        .ok_or("Nessuna cartella selezionata")?;
    Ok(path.to_string())
}
```

### 5.3 Step 2: Preset o Configurazione Manuale

**Presets disponibili:**

| Preset | Terminali | Agenti | Layout | Descrizione |
|--------|-----------|--------|--------|-------------|
| **Blank** | 1 (bash) | Nessuno | 1x1 | Workspace vuoto |
| **Full-Stack Dev** | 4 | 1 (Aider) | 2x2 | Frontend, Backend, DB, AI |
| **API Server** | 3 | 1 (Aider) | 1x3 | Server, Test, AI |
| **AI Agent Swarm** | 4 | 4 (Aider x4) | 2x2 | Multi-agent parallelo |
| **DevOps** | 3 | 1 (OpenCode) | 1x3 | Docker, K8s, AI |
| **Data Science** | 3 | 1 (Aider) | 1x3 | Python, Jupyter, AI |

**UI Preset Card:**
```
+-----------------------------+
|  [ICON] Full-Stack Dev       |
|  -------------------------  |
|  Terminali: 4               |
|  Agenti: 1 (Aider)          |
|  Layout: 2x2                |
|                             |
|  [Seleziona]                |
+-----------------------------+
```

### 5.4 Step 3: Configurazione Terminali

**UI:**
- Slider/Input: numero terminali (1-16)
- Grid preview: anteprima layout in tempo reale
- Per ogni terminale:
  - Dropdown: Shell (bash, zsh, pwsh, cmd)
  - Dropdown: Agente (Nessuno, Aider, OpenCode, Claude Code, Custom)
  - Input: Comando di avvio opzionale
  - Input: Working directory (default: root workspace)

### 5.5 Step 4: Conferma e Creazione

**Riepilogo:**
```
+-------------------------------------+
|  Riepilogo Nuovo Spazio             |
|  ---------------------------------  |
|  Nome: my-project                   |
|  Cartella: C:\Users\Francesco\     |
|           projects\my-project        |
|  Terminali: 4                       |
|  Layout: 2x2                        |
|  Agenti: Aider (pane 2)             |
|  ---------------------------------  |
|  [< Indietro]  [v Crea Spazio]     |
+-------------------------------------+
```

**Creazione (Rust):**
```rust
#[derive(Serialize, Deserialize)]
struct WorkspaceConfig {
    id: String,           // UUID v4
    name: String,
    root_path: String,
    layout: GridLayout,    // rows, cols
    terminals: Vec<TerminalConfig>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[tauri::command]
async fn create_workspace(config: WorkspaceConfig) -> Result<Workspace, String> {
    // 1. Crea file .traflix/workspace.json nella cartella
    // 2. Inizializza terminali con PTY
    // 3. Salva nel registry globale
    // 4. Restituisce workspace object
}
```

---

## 6. Feature: Sidebar e Navigazione

### 6.1 Struttura Sidebar

```typescript
interface SidebarState {
  // Sezione Workspace
  workspaces: WorkspaceItem[];
  activeWorkspaceId: string | null;

  // Sezione Terminali Attivi
  activeTerminals: TerminalItem[];
  activeTerminalId: string | null;

  // UI
  isCollapsed: boolean;
  searchQuery: string;
}

interface WorkspaceItem {
  id: string;
  name: string;
  path: string;
  terminalCount: number;
  agentCount: number;
  isActive: boolean;
  lastOpened: Date;
}

interface TerminalItem {
  id: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  process: string;
  agent: string | null;
  isActive: boolean;
}
```

### 6.2 Interazioni

| Azione | Comportamento |
|--------|--------------|
| **Click workspace** | Apre workspace nell'area principale, carica layout e terminali |
| **Click terminale** | Focus sul terminale specifico nel workspace, scrolla in vista |
| **Hover workspace** | Preview: numero terminali, agenti attivi, ultima modifica |
| **Right-click workspace** | Context menu: Rinomina, Duplica, Elimina, Esporta |
| **Right-click terminale** | Context menu: Chiudi, Duplica, Rinomina, Kill process |
| **Drag workspace** | Riordina lista workspace |
| **Search** | Filtra workspace e terminali per nome |

### 6.3 Persistenza Sidebar

Lo stato della sidebar (ordine workspace, collassata/espansa, ricerca) viene salvato in `tauri-plugin-store`:

```rust
// settings.json (tauri-plugin-store)
{
  "sidebar": {
    "isCollapsed": false,
    "workspaceOrder": ["uuid-1", "uuid-2", "uuid-3"],
    "activeWorkspaceId": "uuid-1",
    "searchQuery": ""
  }
}
```

---

## 7. Feature: Terminali Multipli e PTY

### 7.1 Architettura PTY

Su Windows, Traflix Space usa **ConPTY** (Console Pseudo Terminal) — l'API nativa Windows 10+ che permette di creare terminali interattivi.

```rust
// src-tauri/src/pty/windows.rs
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use windows::Win32::System::Console::{
    CreatePseudoConsole, ConPTY, COORD, HPCON,
};

pub struct ConPty {
    handle: HPCON,
    input: File,
    output: File,
    process: Child,
}

impl ConPty {
    pub fn new(cols: u16, rows: u16, shell: &str) -> Result<Self, Box<dyn Error>> {
        // 1. Crea pipe per input/output
        // 2. Crea ConPTY con dimensioni
        // 3. Spawn processo shell collegato al ConPTY
        // 4. Restituisce handle per lettura/scrittura
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), Box<dyn Error>> {
        // Scrive input nel terminale
    }

    pub fn read(&mut self, buf: &mut [u8]) -> Result<usize, Box<dyn Error>> {
        // Legge output dal terminale
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), Box<dyn Error>> {
        // Ridimensiona ConPTY
    }
}
```

### 7.2 Comunicazione Frontend <-> PTY

```
Frontend (xterm.js)        Tauri IPC              Backend (Rust)
     |                          |                        |
     |-- onData(data) --------->|-- invoke(write_pty) --->|
     |    (utente digita)       |    { id, data }        |-- write(data)
     |                          |                        |
     |<-- onBinary(data) -------|<-- event(pty_output) ---|<-- read(buf)
     |    (output render)       |    { id, data }        |
     |                          |                        |
     |-- onResize(cols,rows) -->|-- invoke(resize_pty) -->|-- resize(cols,rows)
```

**Comandi Tauri:**
```rust
#[tauri::command]
async fn create_pty(
    app: AppHandle,
    shell: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let pty = ConPty::new(cols, rows, &shell)?;

    // Salva PTY nello stato globale
    let mut ptys = app.state::<PtyManager>().ptys.lock().await;
    ptys.insert(id.clone(), pty);

    // Avvia task async per leggere output
    let app_clone = app.clone();
    let id_clone = id.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let mut buf = [0u8; 4096];
            let n = ptys.get_mut(&id_clone).unwrap().read(&mut buf).await?;
            if n == 0 { break; }
            app_clone.emit("pty-output", json!({
                "id": id_clone,
                "data": base64::encode(&buf[..n])
            })).unwrap();
        }
        Ok::<(), Box<dyn Error>>(())
    });

    Ok(id)
}

#[tauri::command]
async fn write_pty(
    app: AppHandle,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut ptys = app.state::<PtyManager>().ptys.lock().await;
    let pty = ptys.get_mut(&id).ok_or("PTY not found")?;
    pty.write(data.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}
```

### 7.3 xterm.js Integration

```typescript
// components/terminal/XTermWrapper.tsx
import { Terminal } from 'xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

export function XTermWrapper({ ptyId, shell, cwd }: Props) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const term = new Terminal({
      theme: traflixTheme,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'block',
      allowProposedApi: true,
    });

    // Addon WebGL per performance
    term.loadAddon(new WebglAddon());
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current!);
    fitAddon.fit();

    // Crea PTY nel backend
    const cols = term.cols;
    const rows = term.rows;
    invoke('create_pty', { shell, cols, rows, cwd }).then(id => {
      setPtyId(id);

      // Ascolta output PTY
      const unlisten = listen('pty-output', (event: any) => {
        if (event.payload.id === id) {
          const data = Uint8Array.from(atob(event.payload.data), c => c.charCodeAt(0));
          term.write(data);
        }
      });

      // Invia input utente al PTY
      term.onData(data => {
        invoke('write_pty', { id, data });
      });

      // Resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        invoke('resize_pty', { id, cols: term.cols, rows: term.rows });
      });
      resizeObserver.observe(terminalRef.current!);

      return () => {
        unlisten.then(u => u());
        resizeObserver.disconnect();
        term.dispose();
      };
    });
  }, []);

  return <div ref={terminalRef} className="w-full h-full" />;
}
```

---

## 8. Feature: Agenti AI

### 8.1 Registry Agenti

```typescript
// lib/agents.ts
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  command: string;           // Comando base
  args: string[];            // Argomenti default
  env: Record<string, string>; // Variabili ambiente
  icon: string;              // Lucide icon name
  color: string;             // Badge color
  requiresApiKey: boolean;
  apiKeyEnv?: string;        // Nome var ambiente per API key
}

export const AGENTS: AgentDefinition[] = [
  {
    id: 'aider',
    name: 'Aider',
    description: 'AI pair programming nel terminale',
    command: 'aider',
    args: ['--model', 'claude-3-5-sonnet-20241022'],
    env: {},
    icon: 'Bot',
    color: '#e85d04',
    requiresApiKey: true,
    apiKeyEnv: 'ANTHROPIC_API_KEY'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Agente AI con TUI avanzata',
    command: 'opencode',
    args: [],
    env: {},
    icon: 'Terminal',
    color: '#22c55e',
    requiresApiKey: true,
    apiKeyEnv: 'OPENAI_API_KEY'
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Agente Claude ufficiale',
    command: 'claude',
    args: [],
    env: {},
    icon: 'MessageSquare',
    color: '#d97757',
    requiresApiKey: true,
    apiKeyEnv: 'ANTHROPIC_API_KEY'
  },
  {
    id: 'custom',
    name: 'Comando Personalizzato',
    description: 'Comando shell personalizzato',
    command: '',
    args: [],
    env: {},
    icon: 'Settings',
    color: '#71717a',
    requiresApiKey: false
  }
];
```

### 8.2 Lancio Agente

Quando un workspace viene creato con un agente, il terminale corrispondente esegue il comando dell'agente invece della shell di default:

```rust
#[tauri::command]
async fn launch_agent(
    app: AppHandle,
    workspace_id: String,
    terminal_id: String,
    agent_id: String,
    cwd: String,
) -> Result<(), String> {
    let agent = AGENT_REGISTRY.get(&agent_id)
        .ok_or("Agente non trovato")?;

    // Verifica API key se richiesta
    if agent.requires_api_key {
        let api_key = std::env::var(&agent.api_key_env)
            .map_err(|_| format!("API key mancante: {}", agent.api_key_env))?;
    }

    // Costruisci comando
    let mut cmd = Command::new(&agent.command);
    cmd.args(&agent.args)
       .current_dir(&cwd)
       .envs(&agent.env);

    // Se l'agente richiede PTY interattivo, usa lo stesso PTY manager
    // Altrimenti spawn come sidecar
    let pty_manager = app.state::<PtyManager>();
    pty_manager.spawn_with_command(terminal_id, cmd).await?;

    Ok(())
}
```

### 8.3 UI Agente nel Terminale

```
+-------------------------------------+
| [R][Y][G]  aider — ~/projects/my-app|
| +---------------------------------+ |
| | [ICON] Aider (Claude 3.5 Sonnet)| |  <- Agent badge
| +---------------------------------+ |
+-------------------------------------+
| > Add a login feature               |
|                                     |
| I'll help you add a login feature.  |
| Let me start by examining the       |
| codebase...                         |
|                                     |
|                                     |
+-------------------------------------+
```

---

## 9. State Management (Zustand)

### 9.1 Workspace Store

```typescript
// stores/workspaceStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WorkspaceStore {
  // State
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  // Actions
  addWorkspace: (workspace: Workspace) => void;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  reorderWorkspaces: (ids: string[]) => void;

  // Computed
  activeWorkspace: () => Workspace | undefined;
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeWorkspaceId: null,

      addWorkspace: (workspace) => set((state) => ({
        workspaces: [...state.workspaces, workspace],
        activeWorkspaceId: workspace.id,
      })),

      removeWorkspace: (id) => set((state) => ({
        workspaces: state.workspaces.filter(w => w.id !== id),
        activeWorkspaceId: state.activeWorkspaceId === id 
          ? state.workspaces[0]?.id || null 
          : state.activeWorkspaceId,
      })),

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

      updateWorkspace: (id, updates) => set((state) => ({
        workspaces: state.workspaces.map(w =>
          w.id === id ? { ...w, ...updates } : w
        ),
      })),

      reorderWorkspaces: (ids) => set((state) => ({
        workspaces: ids.map(id => state.workspaces.find(w => w.id === id)!)
          .filter(Boolean),
      })),

      activeWorkspace: () => {
        const { workspaces, activeWorkspaceId } = get();
        return workspaces.find(w => w.id === activeWorkspaceId);
      },
    }),
    {
      name: 'traflix-workspaces',
      storage: createJSONStorage(() => localStorage), // Sostituire con tauri-plugin-store
    }
  )
);
```

### 9.2 Terminal Store

```typescript
// stores/terminalStore.ts
interface TerminalStore {
  terminals: Map<string, TerminalState>;
  activeTerminalId: string | null;

  createTerminal: (config: TerminalConfig) => string;
  killTerminal: (id: string) => void;
  setActiveTerminal: (id: string) => void;
  updateTerminalTitle: (id: string, title: string) => void;
  writeToTerminal: (id: string, data: string) => void;
}

interface TerminalState {
  id: string;
  workspaceId: string;
  ptyId: string | null;
  title: string;
  process: string;
  agent: AgentDefinition | null;
  isActive: boolean;
  outputBuffer: string[];
}
```

---

## 10. Backend Rust: Struttura Dettagliata

### 10.1 main.rs

```rust
// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

mod pty;
mod workspace;
mod terminal;
mod agent;
mod settings;

use pty::PtyManager;
use workspace::WorkspaceRegistry;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Inizializza stato globale
            app.manage(PtyManager::new());
            app.manage(WorkspaceRegistry::new(app.app_handle().clone()));

            // Carica settings
            let store = app.store_builder("settings.json").build();
            app.manage(store);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Workspace
            workspace::commands::create_workspace,
            workspace::commands::get_workspaces,
            workspace::commands::get_workspace,
            workspace::commands::update_workspace,
            workspace::commands::delete_workspace,
            workspace::commands::select_folder,

            // Terminal
            terminal::commands::create_pty,
            terminal::commands::write_pty,
            terminal::commands::resize_pty,
            terminal::commands::kill_pty,
            terminal::commands::get_terminal_info,

            // Agent
            agent::commands::list_agents,
            agent::commands::launch_agent,
            agent::commands::kill_agent,

            // Settings
            settings::commands::get_settings,
            settings::commands::set_settings,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Cleanup PTY prima di chiudere
                let app = window.app_handle();
                if let Some(pty_manager) = app.try_state::<PtyManager>() {
                    tauri::async_runtime::block_on(async {
                        pty_manager.cleanup_all().await;
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Errore avvio Traflix Space");
}
```

### 10.2 PTY Manager

```rust
// src-tauri/src/pty/manager.rs
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::AppHandle;

pub struct PtyManager {
    ptys: Arc<Mutex<HashMap<String, Box<dyn PtyTrait + Send>>>>,
}

#[async_trait]
pub trait PtyTrait {
    async fn write(&mut self, data: &[u8]) -> Result<(), Box<dyn Error>>;
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, Box<dyn Error>>;
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), Box<dyn Error>>;
    async fn kill(&mut self) -> Result<(), Box<dyn Error>>;
    fn is_alive(&self) -> bool;
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            ptys: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn create(
        &self,
        id: String,
        shell: &str,
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
        app: AppHandle,
    ) -> Result<(), String> {
        let pty = create_pty(shell, cols, rows, cwd).await?;

        // Avvia lettura in background
        let ptys_clone = self.ptys.clone();
        let id_clone = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; 4096];
            loop {
                let n = {
                    let mut ptys = ptys_clone.lock().await;
                    let pty = match ptys.get_mut(&id_clone) {
                        Some(p) => p,
                        None => break,
                    };
                    match pty.read(&mut buf).await {
                        Ok(0) => break, // EOF
                        Ok(n) => n,
                        Err(_) => break,
                    }
                };

                let data = base64::encode(&buf[..n]);
                let _ = app.emit("pty-output", json!({
                    "id": id_clone,
                    "data": data
                }));
            }
        });

        self.ptys.lock().await.insert(id, pty);
        Ok(())
    }

    pub async fn cleanup_all(&self) {
        let mut ptys = self.ptys.lock().await;
        for (id, pty) in ptys.iter_mut() {
            let _ = pty.kill().await;
        }
        ptys.clear();
    }
}
```

---

## 11. Configurazione Tauri

### 11.1 tauri.conf.json

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/config.schema.json",
  "productName": "Traflix Space",
  "version": "0.1.0",
  "identifier": "com.traflix.space",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "Traflix Space",
        "width": 1400,
        "height": 900,
        "minWidth": 900,
        "minHeight": 600,
        "center": true,
        "decorations": false,
        "transparent": false,
        "theme": "Dark"
      }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' ipc://localhost; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:;"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["msi", "nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico"
    ],
    "windows": {
      "webviewInstallMode": {
        "type": "embedBootstrapper"
      }
    }
  }
}
```

### 11.2 Capabilities (Permessi)

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-execute",
    "shell:allow-spawn",
    "shell:allow-kill",
    "shell:allow-stdin-write",
    "fs:allow-read",
    "fs:allow-write",
    "fs:allow-read-dir",
    "dialog:allow-open",
    "store:default",
    "process:default"
  ]
}
```

---

## 12. Piano di Sviluppo

### Fase 1: Foundation (Settimana 1-2) ✅ COMPLETATA
- [x] Setup progetto Tauri 2.0 + React + Vite
- [x] Configurazione design system Tailwind (colori, font, spacing) — v4 CSS-first @theme
- [x] Implementazione layout base (sidebar + area principale)
- [x] Custom title bar (decorations: false) — TitleBar.tsx con traffic lights
- [x] Integrazione font (Syne, Poppins, JetBrains Mono) — Google Fonts CDN

### Fase 2: Workspace Core (Settimana 3-4) — ✅ COMPLETATA
- [x] Wizard creazione workspace (4 step) — NewSpaceWizard.tsx completo: Step 1 (selezione cartella), Step 2 (preset), Step 3 (config terminali), Step 4 (conferma)
- [x] Dialog selezione cartella (tauri-plugin-dialog) — comando `select_folder` in Rust con callback API `pick_folder` + oneshot channel
- [x] Persistenza workspace globale — WorkspaceRegistry in Rust salva/carica da `app_data_dir/traflix-space/workspaces.json`
- [x] Persistenza workspace locale — `create_workspace` crea `.traflix/workspace.json` nella cartella del progetto
- [x] CRUD workspace backend — 6 comandi Tauri implementati (create, get, get_all, update, delete, select_folder) con serde rename_all = camelCase
- [x] Modal UI riutilizzabile — Modal.tsx con overlay, close su Escape, scroll
- [x] Wizard collegato a Sidebar — pulsante "+ Nuovo Spazio" in Sidebar.tsx apre il wizard
- [x] Connessione frontend-backend — wizard chiama `invoke('create_workspace')` e aggiorna workspaceStore
- [x] Preset workspace predefiniti — 6 preset in src/lib/presets.ts (Blank, Full-Stack, API Server, AI Swarm, DevOps, Data Science)
- [x] Persistenza workspace (Zustand) — `traflix-workspaces` in localStorage
- [x] Sidebar con lista workspace — Sidebar.tsx con workspaces e terminali
- [x] Switch workspace — setActiveWorkspace() in workspaceStore

### Fase 3: Terminali (Settimana 5-7) — 🟡 PARZIALE
- [ ] Integrazione xterm.js con WebGL addon — dipendenze installate, wrapper stub
- [ ] Implementazione PTY Windows (ConPTY) — struttura moduli pronta (pty/mod, manager, windows, commands)
- [ ] Comunicazione frontend <-> backend per I/O terminale — comandi Tauri stub pronti
- [x] Grid layout dinamico (1-16 panes) — WorkspaceGrid.tsx
- [ ] Resize e riorganizzazione panes
- [x] Header pane con traffic lights e titolo — TerminalHeader.tsx

### Fase 4: Agenti (Settimana 8-9) — 🟡 PARZIALE
- [x] Registry agenti (Aider, OpenCode, Claude Code) — src/lib/agents.ts + Rust registry.rs
- [ ] Lancio agenti in terminali dedicati — launcher.rs stub
- [x] Badge agente nel terminale — AgentBadge.tsx
- [ ] Gestione API keys (tauri-plugin-store) — plugin installato, comandi stub
- [x] Comandi personalizzati — Custom agent in registry

### Fase 5: Polish (Settimana 10) — ❌ DA AVVIARE
- [ ] Animazioni e transizioni (Framer Motion)
- [ ] Custom cursor (opzionale)
- [x] Tema dark coerente — foundation completa (Tailwind v4 @theme + globals.css)
- [ ] Keyboard shortcuts
- [ ] Error handling e logging
- [ ] Packaging e distribuzione (MSI installer) — tauri.conf.json configurato per MSI/NSIS

---

## 13. Confronto con BridgeSpace

| Aspetto | BridgeSpace | Traflix Space |
|---------|-------------|---------------|
| **Costo** | $16-$100/mese | Gratuito (open source) |
| **Stack** | Tauri + React + Rust | Tauri 2.0 + React + Rust |
| **Design** | Generic dark | Traflix dark laboratory |
| **Terminali** | Fino a 16 | Fino a 16 |
| **Agenti** | Claude, Codex, Grok | Aider, OpenCode, Claude Code |
| **Persistenza** | BridgeMemory (.bridgememory/) | File JSON locale (.traflix/) |
| **Kanban** | Integrato | Fase 2 |
| **Voice** | BridgeVoice | Non in scope |
| **MCP** | BridgeMCP | Fase 2 |
| **Lock-in** | Vendor lock-in | Zero lock-in |
| **Privacy** | Cloud (Anthropic/OpenAI) | Locale-first possibile |

---

## 14. Risorse e Riferimenti

### Documentazione
- Tauri 2.0: https://v2.tauri.app/
- xterm.js: https://xtermjs.org/
- ConPTY: https://docs.microsoft.com/en-us/windows/console/pseudoconsoles
- Zustand: https://docs.pmnd.rs/zustand

### Progetti di Riferimento
- **BridgeSpace:** bridgemind.ai — Product target
- **Kerminal:** dev.to/klpod221 — Tauri + xterm.js terminal app
- **Lokus:** github.com/lokus-ai — Tauri 2.0 real-world app
- **Tabby:** tabby.sh — Terminal emulator open source

### Crates Rust
- `portable-pty` — Cross-platform PTY
- `tokio` — Async runtime
- `serde` + `serde_json` — Serializzazione
- `uuid` — UUID generation
- `base64` — Encoding output PTY

---

*"Deployed while you were reading this."* — Traflix
