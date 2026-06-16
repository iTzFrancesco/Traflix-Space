# Traflix Space — Piano di Rebuild Completo del Sistema Terminale

> **Versione:** 1.1 (revisione critica) | **Data:** 16 Giugno 2026
> **Autore:** Francesco (Traflix)
> **Riferimento:** Warp (warpdotdev/warp) — GPU-accelerated terminal in Rust

---

## 0. Executive Summary

### Problema

L'applicazione diventa **inutilizzabile** con 4+ terminali attivi. Le cause root sono:
- **8 istanze xterm.js** creano 8 canvas/WebGL context simultanei in WebView2 (limite Chromium ~8-16)
- **8 processi `powershell.exe`** spawnano quasi simultaneamente (0-450ms di stagger)
- **Nessuna virtualizzazione**: tutti i terminali renderizzano a 60fps anche quando non visibili/focusati
- **40.000 righe di scrollback** in memoria JavaScript (5000 x 8 terminali)
- **ResizeObserver globale**: ogni resize della finestra scatena 8 `fitAddon.fit()` + 8 `pty.resize()`
- **Bug `ptyId`** mai settato: limite agenti (4) mai applicato

### Obiettivo

Rebuild **atomico e completo** del sistema terminale, passando da un'architettura dove ogni terminale e' un'entita' indipendente e pesante (xterm.js + PTY frontend-managed) a un'architettura ispirata a **Warp**: motore terminale centralizzato in Rust + rendering frontend virtualizzato.

### Risultato atteso

| Metrica | Prima | Dopo |
|---------|-------|------|
| Istanze xterm.js attive | 8 (sempre) | 1 (solo terminale attivo) |
| Canvas/WebGL contexts | 8 | 1 |
| Processi shell all'avvio workspace | 8 simultanei | 0 (lazy spawn on focus) |
| Scrollback in memoria JS | 40.000 righe | 0 (in Rust, on-demand) |
| Frame render/sec totali | ~480 (8x60fps) | ~60 (1x60fps) |
| Resize lag | 8x fit+resize | 1x resize (solo attivo) |
| Memoria frontend per terminali | ~200-400MB | ~20-40MB |
| Tempo apertura workspace | ~2-3s (bloccante) | <100ms (nessuno spawn upfront) |

---

## 1. Architettura Attuale — Analisi Critica

### 1.1 Data Flow Attuale

```
WorkspaceGrid (1-8 panes CSS Grid)
  └─ TerminalPane x N (React.memo, solo stile bordo diverso se attivo)
       └─ XTermWrapper x N
            ├─ new Terminal(xterm.js)      ← 1 per ogni pane (8 contesti canvas/WebGL)
            ├─ new FitAddon()              ← 1 per ogni pane
            ├─ spawn("powershell.exe", []) ← 1 processo ConPTY per ogni pane
            ├─ pty.onData -> term.write()  ← output shell -> xterm (sempre attivo)
            ├─ term.onData -> pty.write()  ← input utente -> shell (sempre attivo)
            ├─ ResizeObserver              ← 8 observer simultanei
            └─ cleanup: taskkill + pty.kill() ← double-kill
```

### 1.2 Problemi Identificati

#### P1 — Contesti GPU multipli (CRITICAL)
```typescript
// XTermWrapper.tsx:55 — Ogni istanza crea un nuovo Terminal xterm.js
const term = new Terminal({ ... });  // x8 = 8 canvas WebGL in Chromium
```
Chromium/WebView2 limita i contesti WebGL a ~8-16. Con 8 terminali si satura il limite, causando context loss, fallback a DOM rendering (piu' lento), e frame drop.

#### P2 — Spawn simultaneo processi shell (CRITICAL)
```typescript
// XTermWrapper.tsx:21-26 — Timing batch inadeguato
const TIMING: Record<number, { batchSize: number; delay: number }> = {
  4: { batchSize: 4, delay: 0 },      // 4 terminali: SPAWNANO TUTTI INSIEME
  6: { batchSize: 3, delay: 100 },    // 6 terminali in 200ms totali
  8: { batchSize: 2, delay: 150 },    // 8 terminali in 450ms totali
};
```
8 `powershell.exe` x 50-100MB RAM ciascuno = **400-800MB spike all'avvio**. Il CPU spike durante l'inizializzazione PowerShell causa frame drop nell'intera UI.

#### P3 — Nessuna virtualizzazione del rendering (CRITICAL)
```typescript
// TerminalPane.tsx:77 — isActive cambia solo il colore bordo
<div style={isActive ? ACTIVE_STYLE : INACTIVE_STYLE}>
  <XTermWrapper ... />
</div>
```
Tutti gli 8 `XTermWrapper` montano, creano il loro `Terminal` xterm.js, e processano output PTY in real-time. Non esiste meccanismo per:
- Sospendere rendering di terminali non visibili
- Catturare lo stato come snapshot statico
- Throttlare l'output PTY per terminali in background

#### P4 — Scrollback in memoria JS (HIGH)
```typescript
// XTermWrapper.tsx:64
scrollback: 5000,  // x8 terminali = 40.000 righe in memoria JS
```

#### P5 — ResizeObserver x8 (HIGH)
```typescript
// XTermWrapper.tsx:244-259 — Ogni terminale ha il suo ResizeObserver
const fitObserver = new ResizeObserver((entries) => {
  if (!opened) setupTerminal();
  else { fitAddon.fit(); pty?.resize(term.cols, term.rows); }
});
```

#### P6 — Double-kill su cleanup (MEDIUM)
```typescript
// XTermWrapper.tsx:277-281
if (pid) { invoke("kill_process_tree", { pid }).catch(() => {}); }  // taskkill /F /T
pty?.kill();  // tauri-pty kill
```

#### P7 — Bug `ptyId` — Limite agenti rotto (MEDIUM)
```typescript
// terminalStore.ts:127-134
getAgentCount: () => {
  let count = 0;
  terminals.forEach((t) => {
    if (t.agent && t.ptyId) count++;  // ptyId e' SEMPRE null!
  });
  return count;  // Restituisce sempre 0
},
```
`setTerminalPtyId()` esiste ma non viene mai chiamato. Risultato: `MAX_CONCURRENT_AGENTS = 4` non viene mai applicato.

#### P8 — Shell hardcoded (LOW)
```typescript
// XTermWrapper.tsx:82
pty = spawn("powershell.exe", [], { ... });  // Shell sempre powershell.exe
```
Nessun supporto per cmd.exe, WSL, git-bash, o shell custom.

---

## 2. Architettura Target — Ispirata a Warp

### 2.1 Filosofia Warp

Warp ha risolto il problema dei terminali multipli con:
1. **Renderer GPU custom in Rust** (wgpu) — ~1.9ms per frame, 144+ FPS
2. **Unico contesto GPU** per tutti i terminali
3. **Grid model forkato da Alacritty** — buffer ottimizzati con scrollback nativo
4. **Entity-Component-Handle pattern** — unico `App` owner di tutte le sessioni
5. **Async I/O via tokio** — letture PTY non bloccanti
6. **Per-block grid isolation** — ogni comando ha la sua griglia

### 2.2 Adattamento per Traflix Space

| Principio Warp | Implementazione Traflix |
|----------------|------------------------|
| Renderer GPU custom in Rust | Canvas 2D singolo in frontend + xterm.js virtualizzato (1 istanza) |
| Unico contesto GPU | Unico canvas HTML5 (o max 2 con pool) |
| Grid model in Rust | `terminal_engine` crate: grid buffer + ANSI parser in Rust |
| Async I/O tokio | Letture PTY in tokio task, output inviato via Tauri events |
| Entity ownership centralizzata | `TerminalManager` in Rust possiede tutte le sessioni PTY |

---

## 3. Nuova Architettura

```
┌──────────────────────────────────────────────────────────────────┐
│                    FRONTEND (React + TypeScript)                  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  WorkspaceGrid                                             │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │  │
│  │  │ Pane 1   │ │ Pane 2   │ │ Pane 3   │ │ Pane 4   │      │  │
│  │  │ (static) │ │ (static) │ │ (ACTIVE) │ │ (static) │      │  │
│  │  │ snapshot │ │ snapshot │ │ xterm.js │ │ snapshot │      │  │
│  │  └──────────┘ └──────────┘ └────┬─────┘ └──────────┘      │  │
│  │                                 │                           │  │
│  │                    ┌────────────┴────────────┐              │  │
│  │                    │  TerminalPool           │              │  │
│  │                    │  - activeTermId         │              │  │
│  │                    │  - xtermInstance (x1)   │              │  │
│  │                    │  - snapshots: Map<id,   │              │  │
│  │                    │    ImageBitmap>         │              │  │
│  │                    └────────────┬────────────┘              │  │
│  └─────────────────────────────────┼───────────────────────────┘  │
│                                    │                              │
│  ┌─────────────────────────────────┼───────────────────────────┐  │
│  │  FrameReceiver                  │                           │  │
│  │  - ascolta eventi Tauri         │                           │  │
│  │  - routing output a xterm.js    │                           │  │
│  │  - bufferizza per inattivi      │                           │  │
│  └─────────────────────────────────┼───────────────────────────┘  │
│                                    │                              │
└────────────────────────────────────┼──────────────────────────────┘
                                     │ Tauri Events (batched)
┌────────────────────────────────────┼──────────────────────────────┐
│                    BACKEND (Rust)  │                              │
│                                    │                              │
│  ┌─────────────────────────────────┼───────────────────────────┐  │
│  │  terminal_engine::TerminalManager                           │  │
│  │                                                             │  │
│  │  sessions: HashMap<TerminalId, TerminalSession>             │  │
│  │                                                             │  │
│  │  ┌─────────────────────────────────────────────────────┐    │  │
│  │  │ TerminalSession                                     │    │  │
│  │  │  - pty: ConPTY handle                               │    │  │
│  │  │  - grid: GridBuffer (celle + attributi + scrollback) │    │  │
│  │  │  - parser: AnsiParser (vt100)                       │    │  │
│  │  │  - cursor: CursorPosition                           │    │  │
│  │  │  - active: bool (throttling output)                 │    │  │
│  │  └─────────────────────────────────────────────────────┘    │  │
│  │                                                             │  │
│  │  ┌─────────────────────────────────────────────────────┐    │  │
│  │  │  Frame Scheduler (event-driven, non a intervallo)    │    │  │
│  │  │  - Emette frame immediatamente su nuovo output PTY   │    │  │
│  │  │  - Debounce 8ms per batching                         │    │  │
│  │  │  - Throttling 500ms per terminali inattivi           │    │  │
│  │  │  - Event emission: app.emit("terminal-frame", diff) │    │  │
│  │  └─────────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Nuovo Data Flow

```
[Utente clicca workspace] -> WorkspaceView monta griglia (N pani vuoti)
  -> TerminalPool crea 1 xterm.js (condiviso)
  -> TerminalPool associa xterm.js al primo pane (o nessuno, attende click)
  -> [Utente clicca pane 2] -> invoke("terminal_set_active", {id: "2"})
    -> Rust: spawna shell per terminale 2 (se non ancora spawnato)
    -> Rust: avvia frame scheduler per terminale 2
    -> Rust: emette eventi "terminal-frame" con frame diff
    -> Frontend: FrameReceiver applica output a xterm.js
    -> Frontend: cattura snapshot del terminale precedentemente attivo

[Output shell] -> ConPTY -> tokio::spawn(read loop) -> ANSI parser -> grid update
  -> appena ci sono celle modificate: calcola diff -> debounce 8ms -> emit "terminal-frame"
  -> FrameReceiver (frontend) -> xterm.write(data)  [solo se terminale attivo]
  -> se inattivo: applica throttling 500ms, aggiorna grid in background (no rendering)

[Resize finestra] -> solo terminale attivo: fitAddon.fit() + pty.resize()
  -> terminali inattivi: nessuna azione (snapshot statici)

[Scroll terminale] -> frontend richiede scrollback chunk a Rust
  -> invoke("terminal_get_scrollback", {id, offset, limit})
```

---

## 4. Fase 1 — Terminal Engine in Rust

### 4.1 Nuovo crate: `src-tauri/src/terminal_engine/`

```
terminal_engine/
├── mod.rs                 # TerminalManager: HashMap di sessioni
├── session.rs             # TerminalSession: PTY handle + grid + parser
├── grid.rs                # GridBuffer: matrice 2D con scrollback illimitato
├── cell.rs                # Cell: char + attributi (fg, bg, bold, italic, underline)
├── parser.rs              # AnsiParser: state machine VT100 -> grid updates
├── frame.rs               # FrameDiff: solo celle cambiate da inviare al frontend
├── scheduler.rs           # FrameScheduler: tokio interval per emissione frame
├── commands.rs            # Tauri commands: spawn, write, resize, kill, set_active
└── snapshot.rs            # FrameSnapshot: stato completo per snapshot statici
```

### 4.2 Dipendenze Rust

```toml
portable-pty = "0.9"              # PTY cross-platform (ConPTY su Windows, forkpty su Unix)
                                   #   Autore: wez (wezterm). Battle-tested, base di tauri-plugin-pty.
vt100 = "0.16"                    # ANSI/VT100 parser, mantenuto attivamente, ~50KB compilato.
                                   #   Alternativa: alacritty_terminal = "0.26" — piu' completo
                                   #   (selection, search, reflow) ma ~2MB. Usiamo vt100 per il
                                   #   PoC, upgrade ad alacritty_terminal se servono feature avanzate.
parking_lot = "0.12"              # RwLock/Mutex piu' veloci di std::sync (no spin su contention)
dashmap = "6"                     # HashMap concorrente lock-free per sessioni terminali
tokio = { version = "1", features = ["full"] }  # Gia' presente
```

**Nota su `vt100` vs `alacritty_terminal`:**
Entrambi sono su crates.io e mantenuti. `vt100` 0.16.2 e' un parser puro — processa byte ANSI e restituisce uno screen state. `alacritty_terminal` 0.26.0 e' un emulatore terminale completo con grid model, selection, search, reflow. Per il proof-of-concept usiamo `vt100` (piu' leggero, meno dipendenze). Se in futuro servono feature come selezione testo o reflow su resize, migriamo a `alacritty_terminal`.

### 4.3 Grid Buffer (`grid.rs`)

```rust
pub struct Cell {
    pub ch: char,
    pub fg: Color,
    pub bg: Color,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

pub struct GridBuffer {
    pub cols: u16,
    pub rows: u16,                     // Righe visibili (viewport)
    pub cells: Vec<Vec<Cell>>,         // Scrollback + viewport
    pub scrollback_limit: usize,       // Default: 10.000
    pub cursor: CursorPosition,
    pub title: String,
}

impl GridBuffer {
    pub fn new(cols: u16, rows: u16) -> Self;
    pub fn put_char(&mut self, ch: char);
    pub fn scroll_up(&mut self, count: u16);
    pub fn resize(&mut self, cols: u16, rows: u16);
    pub fn diff_since(&self, last_frame: &Frame) -> FrameDiff;
    pub fn snapshot(&self) -> FrameSnapshot;
    pub fn get_scrollback(&self, offset: usize, limit: usize) -> Vec<Vec<Cell>>;
}
```

### 4.4 ANSI Parser (`parser.rs`)

```rust
use vt100::Parser;

pub struct AnsiParser {
    parser: Parser,
    cols: u16,
    rows: u16,
}

impl AnsiParser {
    pub fn new(cols: u16, rows: u16) -> Self;
    pub fn process(&mut self, data: &[u8]);  // Parsing chunk bytes da PTY
    pub fn extract_cells(&self) -> Vec<(u16, u16, Cell)>;
    pub fn cursor_position(&self) -> CursorPosition;
    pub fn window_title(&self) -> Option<String>;
}
```

### 4.5 Frame Diff (`frame.rs`)

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct FrameDiff {
    pub terminal_id: String,
    pub cursor: CursorPosition,
    pub cursor_visible: bool,
    pub title: Option<String>,
    pub dirty_cells: Vec<CellUpdate>,      // Solo celle cambiate
    pub scrolled_lines: u16,
    pub clear_screen: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CellUpdate {
    pub row: u16, pub col: u16,
    pub cell: Cell,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FrameSnapshot {
    pub terminal_id: String,
    pub cols: u16, pub rows: u16,
    pub cells: Vec<Vec<Cell>>,
    pub cursor: CursorPosition,
    pub cursor_visible: bool,
    pub title: String,
}
```

### 4.6 Frame Scheduler (`scheduler.rs`)

**Approccio: event-driven con debounce, NON a intervallo fisso.**

Invece di un tokio::interval a 16ms (che introduce latenza fino a 16ms anche quando
c'e' output pronto), il scheduler emette frame **immediatamente** quando il parser
produce celle modificate, con un debounce di 8ms per batching. Quando il terminale
e' silenzioso, non viene emesso nulla — zero carico.

```rust
pub struct FrameScheduler {
    debounce_window: Duration,     // 8ms: accumula cambiamenti prima di emettere
    inactive_throttle: Duration,   // 500ms: throttling per terminali inattivi
}

impl FrameScheduler {
    /// Registra un terminale per emissione frame event-driven.
    /// Chiamato internamente dal parse loop quando vengono rilevate celle modificate.
    /// Usa debounce: se arriva altro output entro 8ms, accumula e batcha.
    pub fn schedule_emit(&self, app: &AppHandle, terminal_id: &str, active: bool);

    /// Forza emissione immediata (es. fine processo, clear screen)
    pub fn flush(&self, app: &AppHandle, terminal_id: &str);

    /// Ferma il debounce timer per un terminale
    pub fn stop(&self, terminal_id: &str);
}
```

**Vantaggi rispetto all'intervallo fisso:**
- Latenza percepita zero: un tasto premuto appare subito, non aspetta il prossimo tick
- Zero CPU quando il terminale e' idle (nessun timer che scatta a vuoto)
- Batching automatico: output veloce (es. `dir /s`) viene accumulato in chunk da 8ms
- Throttling naturale: terminali inattivi emettono max ogni 500ms anche se producono output

### 4.7 Terminal Session (`session.rs`)

```rust
pub struct TerminalSession {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pty: Option<pty_handle>,
    pub grid: GridBuffer,
    pub parser: AnsiParser,
    pub active: bool,
    pub agent_id: Option<String>,
    pub last_frame: Option<Frame>,
    pub exit_code: Option<i32>,
}

impl TerminalSession {
    pub async fn spawn(&mut self, app_handle: AppHandle) -> Result<()>;
    async fn read_loop(pty: pty_handle, parser_tx: Sender<Vec<u8>>);
    async fn parse_loop(parser_rx: Receiver<Vec<u8>>, grid: Arc<RwLock<GridBuffer>>);
    pub fn write(&self, data: &[u8]) -> Result<()>;
    pub fn resize(&mut self, cols: u16, rows: u16);
    pub fn kill(&mut self);
}
```

### 4.8 Terminal Manager (`mod.rs`)

```rust
use dashmap::DashMap;

pub struct TerminalManager {
    sessions: DashMap<String, Arc<RwLock<TerminalSession>>>,
    scheduler: FrameScheduler,
}

impl TerminalManager {
    pub fn new() -> Self;
    pub async fn spawn(&self, app: AppHandle, config: TerminalConfig) -> Result<String>;
    pub fn write(&self, id: &str, data: &[u8]) -> Result<()>;
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()>;
    pub async fn kill(&self, id: &str);
    pub fn set_active(&self, id: Option<&str>);
    pub fn get_snapshot(&self, id: &str) -> Result<FrameSnapshot>;
    pub fn get_scrollback(&self, id: &str, offset: usize, limit: usize) -> Result<Vec<Vec<Cell>>>;
    pub fn start_event_loop(&self, app: AppHandle);
}
```

### 4.9 Tauri Commands (`commands.rs`)

```rust
#[tauri::command] async fn terminal_spawn(app: AppHandle, terminal_id: String, shell: String, cwd: String, cols: u16, rows: u16) -> Result<(), String>;
#[tauri::command] async fn terminal_write(app: AppHandle, terminal_id: String, data: Vec<u8>) -> Result<(), String>;
#[tauri::command] async fn terminal_resize(app: AppHandle, terminal_id: String, cols: u16, rows: u16) -> Result<(), String>;
#[tauri::command] async fn terminal_kill(app: AppHandle, terminal_id: String) -> Result<(), String>;
#[tauri::command] async fn terminal_set_active(app: AppHandle, terminal_id: String) -> Result<(), String>;
#[tauri::command] async fn terminal_get_snapshot(app: AppHandle, terminal_id: String) -> Result<FrameSnapshot, String>;
#[tauri::command] async fn terminal_get_scrollback(app: AppHandle, terminal_id: String, offset: usize, limit: usize) -> Result<Vec<Vec<Cell>>, String>;
```

### 4.10 Integrazione `main.rs`

```rust
mod terminal_engine;

// In setup():
app.manage(TerminalManager::new());
let manager = app.state::<TerminalManager>();
let handle = app.handle().clone();
manager.start_event_loop(handle);

// In invoke_handler:
terminal_engine::commands::terminal_spawn,
terminal_engine::commands::terminal_write,
// ... etc
```

---

## 5. Fase 2 — Frontend Terminal Display

### 5.1 Nuova struttura file

```
src/components/terminal/
├── TerminalPool.tsx          # Gestisce l'unica istanza xterm.js condivisa
├── TerminalPane.tsx          # REWRITE: container per terminale (snapshot o live)
├── TerminalSnapshot.tsx      # Canvas con dataURL dello stato inattivo (da html2canvas)
├── TerminalInputHandler.tsx  # Clipboard, Drag & Drop, keyboard (ereditato da XTermWrapper)
├── FrameReceiver.ts          # Ascoltatore eventi Tauri, routing output
├── useTerminalEngine.ts       # Hook: comunica con backend Rust
└── types.ts                  # FrameDiff, CellUpdate, FrameSnapshot, TerminalCell
```

### 5.2 `TerminalPool.tsx` — L'unica istanza xterm.js

```typescript
/**
 * TerminalPool gestisce L'UNICA istanza xterm.js condivisa tra tutti i pani.
 * 
 * Principi:
 * - Solo 1 Terminal xterm.js creato (non N)
 * - L'istanza viene "attaccata" al DOM del terminale attivo
 * - Quando l'utente cambia terminale:
 *   1. Cattura snapshot via html2canvas del container xterm.js corrente
 *   2. Stacca l'elemento xterm.js dal container precedente (DOM manipulation)
 *   3. Attacca l'elemento xterm.js al nuovo container
 *   4. Carica lo stato dal backend Rust (term.write del FrameSnapshot)
 * 
 * CRITICAL: xterm.js NON supporta term.open() multiplo su container diversi.
 * Usiamo DOM manipulation diretta: term.element?.remove() + container.appendChild(term.element!)
 * Questo e' il punto piu' fragile dell'architettura — VA TESTATO PER PRIMO.
 */

export function useTerminalPool() {
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  const snapshotsRef = useRef<Map<string, string>>(new Map());  // dataURL invece di ImageBitmap
  
  const initXTerm = useCallback((container: HTMLElement) => {
    if (xtermRef.current) return;
    
    const term = new Terminal({
      theme: STOCK_THEME,
      fontFamily: '"Cascadia Mono", "Cascadia Code", "Consolas", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 0,  // Scrollback gestito dal backend Rust
      allowProposedApi: true,
    });
    
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    // Prima apertura: term.open() e' safe
    term.open(container);
    fitAddon.fit();
    
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
  }, []);
  
  /**
   * Attacca xterm.js a un nuovo container (dopo la prima apertura).
   * Usa DOM manipulation diretta perche' term.open() non supporta richiamate.
   */
  const attachTo = useCallback(async (container: HTMLElement, terminalId: string) => {
    const term = xtermRef.current;
    if (!term) return;
    
    // 1. Salva snapshot del terminale precedente (se esiste)
    if (activeTerminalIdRef.current) {
      await captureSnapshot(activeTerminalIdRef.current);
    }
    
    // 2. Stacca xterm.js dal container corrente (DOM manipulation)
    detachFromCurrent();
    
    // 3. Attacca al nuovo container
    const element = term.element;
    if (element && element.parentElement !== container) {
      element.remove();  // Rimuovi dal vecchio parent
      container.appendChild(element);  // Appendi al nuovo container
      fitAddonRef.current?.fit();
    } else if (!element) {
      // Fallback: se element e' null (prima volta o edge case),
      // chiama open() sul nuovo container
      term.open(container);
      fitAddonRef.current?.fit();
    }
    
    // 4. Carica stato dal backend Rust
    const snapshot = await invoke<FrameSnapshot>("terminal_get_snapshot", { terminalId });
    renderSnapshot(term, snapshot);
    
    // 5. Notifica backend
    await invoke("terminal_set_active", { terminalId });
    activeTerminalIdRef.current = terminalId;
  }, []);
  
  /**
   * Stacca xterm.js dal container corrente senza distruggerlo.
   * IMPORTANTE: non chiamare term.dispose()! Vogliamo mantenere l'istanza viva.
   */
  const detachFromCurrent = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;
    
    // Opzione: clear + mantieni in memoria
    // L'elemento verra' rimosso dal DOM in attachTo()
    term.clear();
    activeTerminalIdRef.current = null;
  }, []);
  
  /**
   * Cattura snapshot del terminale corrente usando html2canvas.
   * Molto piu' semplice che reimplementare il rendering cell-by-cell da Rust.
   * 
   * Dipendenza da aggiungere: npm install html2canvas
   */
  const captureSnapshot = useCallback(async (terminalId: string) => {
    const term = xtermRef.current;
    if (!term?.element) return;
    
    try {
      // html2canvas cattura il DOM dell'elemento xterm.js come immagine
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(term.element, {
        backgroundColor: "#0c0c0c",
        scale: 1,  // 1x per performance, niente retina
        logging: false,
      });
      const dataUrl = canvas.toDataURL("image/png");
      snapshotsRef.current.set(terminalId, dataUrl);
    } catch (err) {
      // Fallback: se html2canvas fallisce, salva FrameSnapshot come dati grezzi
      console.warn("[TerminalPool] html2canvas fallito, uso FrameSnapshot grezzo:", err);
      const snapshot = await invoke<FrameSnapshot>("terminal_get_snapshot", { terminalId });
      // Converti FrameSnapshot in dataURL tramite canvas offscreen
      const dataUrl = renderSnapshotToDataURL(snapshot);
      snapshotsRef.current.set(terminalId, dataUrl);
    }
  }, []);
  
  const dispose = useCallback(() => {
    xtermRef.current?.dispose();
    xtermRef.current = null;
    fitAddonRef.current = null;
    snapshotsRef.current.clear();
  }, []);
  
  return {
    initXTerm, attachTo, detachFromCurrent, captureSnapshot, dispose,
    getSnapshot: (id: string) => snapshotsRef.current.get(id) ?? null,
  };
}
```

**Nota su `html2canvas`:**
Aggiungere al `package.json`: `"html2canvas": "^1.4.1"`. Cattura il rendering DOM di xterm.js
direttamente, evitando di dover reimplementare un renderer cell-by-cell da zero.
Se html2canvas non funziona in WebView2 (da testare), il fallback e' renderizzare
il FrameSnapshot del backend su un canvas offscreen (piu' lento ma garantito).

### 5.3 `TerminalPane.tsx` — REWRITE

```typescript
/**
 * Nuovo TerminalPane:
 * - ATTIVO: monta container xterm.js live
 * - INATTIVO: mostra snapshot statico (canvas con ImageBitmap)
 * - Click su snapshot -> attiva il terminale
 * - Lazy shell spawn: la shell spawna solo al primo focus
 */

export const TerminalPane = memo(function TerminalPane({
  terminalId, shell, cwd, title, agentId, isActive, onActivate, pool,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const spawnedRef = useRef(false);
  
  useEffect(() => {
    if (!isActive || !containerRef.current) return;
    
    // Inizializzazione lazy: al primo focus, initXTerm + spawn shell
    // Se xterm.js e' gia' stato inizializzato altrove, attachTo fa solo DOM swap
    if (!pool.xtermRef.current) {
      pool.initXTerm(containerRef.current);
    }
    
    if (!spawnedRef.current) {
      spawnedRef.current = true;
      invoke("terminal_spawn", { terminalId, shell, cwd, cols: 80, rows: 24 });
    }
    
    pool.attachTo(containerRef.current, terminalId);
  }, [isActive, terminalId, shell, cwd, pool]);
  
  if (!isActive) {
    const snapshot = pool.getSnapshot(terminalId);
    return (
      <div style={INACTIVE_STYLE} onClick={() => onActivate(terminalId)}>
        {snapshot ? <SnapshotCanvas dataUrl={snapshot} title={title} />
                  : <PlaceholderPane title={title} />}
      </div>
    );
  }
  
  return (
    <div style={ACTIVE_STYLE}>
      <div ref={containerRef} style={CONTAINER_STYLE} />
    </div>
  );
});
```

### 5.4 `FrameReceiver.ts`

```typescript
/**
 * Ascoltatore centralizzato eventi "terminal-frame" dal backend Rust.
 * Routing: terminale attivo -> xterm.js, inattivi -> buffer (il backend aggiorna grid)
 */

class FrameReceiver {
  private handlers = new Map<string, FrameHandler>();
  private buffers = new Map<string, FrameDiff[]>();
  private activeId: string | null = null;
  
  constructor() {
    listen<FrameDiff | FrameDiff[]>("terminal-frame", (event) => {
      const diffs = Array.isArray(event.payload) ? event.payload : [event.payload];
      for (const diff of diffs) {
        if (diff.terminal_id === this.activeId) {
          this.handlers.get(diff.terminal_id)?.(diff);
        } else {
          const buf = this.buffers.get(diff.terminal_id) || [];
          buf.push(diff);
          this.buffers.set(diff.terminal_id, buf);
        }
      }
    });
  }
  
  register(terminalId: string, handler: FrameHandler) { ... }
  setActive(terminalId: string | null) { ... }
  unregister(terminalId: string) { ... }
}

export const frameReceiver = new FrameReceiver();
```

### 5.5 `useTerminalEngine.ts` — Hook

```typescript
export function useTerminalEngine() {
  const spawn = useCallback(async (config: {
    terminalId: string; shell: string; cwd: string; cols: number; rows: number;
  }) => invoke("terminal_spawn", config), []);
  
  const write = useCallback(async (terminalId: string, data: string) => {
    const encoder = new TextEncoder();
    return invoke("terminal_write", { terminalId, data: Array.from(encoder.encode(data)) });
  }, []);
  
  const resize = useCallback(async (terminalId: string, cols: number, rows: number) =>
    invoke("terminal_resize", { terminalId, cols, rows }), []);
  
  const kill = useCallback(async (terminalId: string) =>
    invoke("terminal_kill", { terminalId }), []);
  
  const setActive = useCallback(async (terminalId: string | null) => {
    frameReceiver.setActive(terminalId);
    return invoke("terminal_set_active", { terminalId: terminalId || "" });
  }, []);
  
  const getSnapshot = useCallback(async (terminalId: string) =>
    invoke<FrameSnapshot>("terminal_get_snapshot", { terminalId }), []);
  
  const getScrollback = useCallback(async (terminalId: string, offset: number, limit: number) =>
    invoke("terminal_get_scrollback", { terminalId, offset, limit }), []);
  
  return { spawn, write, resize, kill, setActive, getSnapshot, getScrollback };
}
```

---

## 6. Fase 3 — Lifecycle & Resource Management

### 6.1 Lazy Shell Spawn

```
PRIMA: 8 shell spawnate al mount di WorkspaceGrid (tutte insieme)
DOPO:  0 shell spawnate al mount. Solo quando l'utente clicca un pane:
       1. invoke("terminal_spawn") -> Rust spawna la shell
       2. Se shell gia' spawnata: riattiva solamente
       3. Se utente non clicca mai un pane: nessuna shell mai spawnata
```

### 6.2 Agent Launch Queue

```
PRIMA: Tutti gli agenti lanciati simultaneamente in onTerminalReady
DOPO:  Coda lancio agenti, max 2 contemporanei:
       1. Terminale spawnato -> notifica "ready"
       2. Se agent_id != null -> accoda richiesta
       3. Queue worker processa max 2 alla volta
       4. Delay 2 secondi tra un agente e l'altro
```

```typescript
// src/lib/agentLauncher.ts
class AgentLaunchQueue {
  private queue: Array<{ terminalId: string; agentId: string }> = [];
  private active = 0;
  private maxConcurrent = 2;
  
  enqueue(terminalId: string, agentId: string) {
    this.queue.push({ terminalId, agentId });
    this.processNext();
  }
  
  private async processNext() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
    const { terminalId, agentId } = this.queue.shift()!;
    this.active++;
    try {
      const agent = AGENTS.find(a => a.id === agentId);
      if (agent) {
        await invoke("terminal_write", {
          terminalId,
          data: `${agent.command} ${agent.args.join(" ")}\r\n`,
        });
      }
    } finally {
      this.active--;
      setTimeout(() => this.processNext(), 2000);
    }
  }
}
```

### 6.3 Output Throttling

```
- Terminale attivo:     frame emesso immediatamente su output, debounce 8ms per batching
- Terminale inattivo:   frame emesso max ogni 500ms (throttling)
- Evento unico: multipli frame (da diversi terminali) batchati in unico evento Tauri
- Nessun timer attivo quando nessun terminale produce output (zero CPU idle)
```

### 6.4 Cleanup Semplificato

```
PRIMA: Double-kill (taskkill /F /T + pty.kill())
DOPO:  Singolo kill via TerminalManager::kill():
       1. Chiude handle ConPTY
       2. Termina processo shell
       3. Rimuove sessione da DashMap
       4. Ferma frame scheduler
```

### 6.5 Memoria Scrollback

```
PRIMA: 5000 righe x 8 = 40.000 righe in JS
DOPO:  Scrollback illimitato in Rust, frontend solo viewport corrente
       Scroll up -> invoke("terminal_get_scrollback") -> chunk da Rust
```

---

## 7. Stato Management — Nuovo Terminal Store

```typescript
// src/stores/terminalStore.ts — REWRITE
export interface TerminalState {
  id: string;
  workspaceId: string;
  title: string;
  shell: string;
  cwd: string;
  agent: string | null;
  isActive: boolean;
  spawned: boolean;        // NEW: shell spawnata almeno una volta
  exitCode: number | null; // NEW: exit code
}

interface TerminalStore {
  terminals: Map<string, TerminalState>;
  activeTerminalId: string | null;
  
  addTerminal: (config: TerminalConfig) => void;
  removeTerminal: (id: string) => void;
  removeWorkspaceTerminals: (workspaceId: string) => void;
  setActiveTerminal: (id: string) => void;
  updateTitle: (id: string, title: string) => void;
  markSpawned: (id: string) => void;
  markExited: (id: string, exitCode: number) => void;
  getByWorkspace: (workspaceId: string) => TerminalState[];
}
```

---

## 8. Rimozioni

### File da eliminare
```
src/components/terminal/XTermWrapper.tsx     # Sostituito da TerminalPool + TerminalPane
src/hooks/useTerminal.ts                      # Sostituito da useTerminalEngine
src-tauri/src/process.rs                      # taskkill non necessario
```

### Da terminalStore.ts (rimuovere)
```
- ptyId field
- setTerminalPtyId()
- getAgentCount() con check ptyId (rotto)
- createTerminal() -> addTerminal()
```

---

## 9. Ordine di Implementazione (Critico)

L'ordine NON e' sequenziale per fase (Fase 1 -> Fase 2 -> Fase 3). Va eseguito
partendo dai punti piu' rischiosi, validando ogni step prima di procedere.

### Step 0 — Proof of Concept (il pipeline minimo)
**Obiettivo:** Verificare che il pipeline Rust PTY -> vt100 -> Tauri event -> xterm.js funzioni.
- [ ] Aggiungere `portable-pty`, `vt100`, `dashmap`, `parking_lot` a Cargo.toml
- [ ] Creare `terminal_engine` con il minimo: `mod.rs` + `commands.rs`
- [ ] Implementare `terminal_spawn`: spawn PTY via portable-pty, read loop, parse con vt100
- [ ] Implementare Tauri event `terminal-frame`: invia raw bytes parsati a xterm.js
- [ ] Frontend: listener eventi in un componente test, `term.write(data)`
- [ ] **Test:** Un singolo terminale spawnato da Rust funziona correttamente (input/output)
- [ ] **Test:** Latenza percepita — un tasto premuto appare immediatamente
- **Tempo:** 1 giorno. Se fallisce qui, il piano va rivisto.

### Step 1 — TerminalPool attach/detach (il punto piu' fragile)
**Obiettivo:** Verificare che xterm.js possa essere spostato tra container DOM senza rompersi.
- [ ] Implementare `TerminalPool.initXTerm(container)` — prima apertura con `term.open()`
- [ ] Implementare DOM swap: `element.remove()` + `container.appendChild(element)` + `fitAddon.fit()`
- [ ] **Test:** Switch tra 2 container — xterm.js si sposta, mantiene lo stato, input funziona
- [ ] **Test:** Switch tra 4 container in successione rapida — nessun memory leak
- [ ] Se il DOM swap non funziona: fallback a distruggere/ricreare xterm.js ad ogni switch (costo accettabile ~20ms)
- **Tempo:** 0.5 giorni.

### Step 2 — Snapshot con html2canvas
**Obiettivo:** Catturare lo stato visivo di xterm.js prima dello switch.
- [ ] Aggiungere `html2canvas` a package.json
- [ ] Implementare `captureSnapshot()` con html2canvas
- [ ] **Test:** Snapshot generato correttamente, visualizzato in TerminalSnapshot
- [ ] **Test:** html2canvas funziona in WebView2 (testa su Tauri build)
- [ ] Se html2canvas non funziona: fallback a canvas offscreen con FrameSnapshot del backend
- **Tempo:** 0.5 giorni.

### Step 3 — Frame Scheduler event-driven
**Obiettivo:** Emissione frame efficiente con debounce invece di intervallo fisso.
- [ ] Implementare scheduler con debounce 8ms e throttling 500ms per inattivi
- [ ] **Test:** Output rapido (`dir /s`) batchato correttamente
- [ ] **Test:** Terminale silenzioso non emette eventi (zero CPU)
- **Tempo:** 0.5 giorni.

### Step 4 — Lazy spawn + Agent queue
**Obiettivo:** Nessuna shell spawnata prima del focus utente.
- [ ] Implementare lazy spawn in TerminalPane (solo al primo focus)
- [ ] Implementare AgentLaunchQueue con max 2 concorrenti
- [ ] **Test:** Workspace 8 terminali: 0 shell all'apertura, spawna solo al click
- [ ] **Test:** 5 agenti configurati: solo 2 partono, gli altri in coda
- **Tempo:** 1 giorno.

### Step 5 — Sostituzione e cleanup
**Obiettivo:** Rimuovere il vecchio sistema, attivare il nuovo.
- [ ] Rimpiazzare XTermWrapper con TerminalPool in WorkspaceGrid
- [ ] Aggiornare terminalStore (rimuovere ptyId, getAgentCount, createTerminal)
- [ ] Rimuovere `useTerminal.ts`, `process.rs`
- [ ] Aggiornare `main.rs` con i nuovi comandi
- [ ] **Test:** Regressione completa — tutte le feature funzionanti
- **Tempo:** 1 giorno.

### Step 6 — Performance tuning e test finali
**Obiettivo:** Validare tutte le metriche di successo.
- [ ] Profilare memoria con 8 terminali
- [ ] Misurare FPS con Performance API
- [ ] Verificare nessun context loss WebGL
- [ ] Test di carico: output massivo su tutti i terminali
- **Tempo:** 1 giorno.

### Riepilogo ordine
```
Step 0: PoC pipeline (1g)         ← BLOCCANTE: se fallisce, ripensa l'approccio
Step 1: TerminalPool DOM swap     ← BLOCCANTE: punto piu' fragile
Step 2: Snapshot html2canvas      ← Dipende da Step 1
Step 3: Frame Scheduler           ← Dipende da Step 0
Step 4: Lazy spawn + Agent queue  ← Dipende da Step 0,1
Step 5: Sostituzione finale       ← Dipende da Step 1-4
Step 6: Test e tuning             ← Dipende da Step 5
```

---

## 10. Capacita' Tauri

```json
{
  "permissions": [
    // ... esistenti ...
    "core:event:allow-listen",
    "core:event:allow-emit",
    "pty:default"
  ]
}
```

---

## 11. Stima Effort

| Fase | Descrizione | Stima |
|------|-------------|-------|
| 1a | `terminal_engine` crate: grid, cell, parser base | 2 giorni |
| 1b | `terminal_engine`: session, scheduler, commands | 2 giorni |
| 1c | Integrazione `main.rs`, event loop, test | 1 giorno |
| 2a | Frontend: TerminalPool, FrameReceiver, types | 2 giorni |
| 2b | Frontend: TerminalPane REWRITE, TerminalSnapshot | 1.5 giorni |
| 2c | Frontend: input handler, clipboard, drag-drop | 1 giorno |
| 3 | Lifecycle: lazy spawn, agent queue, cleanup | 1.5 giorni |
| 4 | Test, debug, performance tuning | 2 giorni |
| **Totale** | | **~12 giorni** |

---

## 12. Metrice di Successo

- [ ] Workspace 8 terminali: UI a 60fps costanti
- [ ] Tempo apertura workspace: <100ms
- [ ] Memoria frontend: <50MB per terminali
- [ ] Switch terminale: <50ms
- [ ] Nessun context loss WebGL
- [ ] 0 `taskkill` calls
- [ ] Max 2 agenti contemporanei
- [ ] Scrollback on-demand, mai in JS

---

## 13. Riferimenti

- **Warp:** `https://github.com/warpdotdev/warp` — GPU rendering, SumTree, WarpUI
- **Alacritty Grid:** `https://github.com/alacritty/alacritty`
- **vt100 crate:** `https://crates.io/crates/vt100` (0.16.2)
- **portable-pty crate:** `https://crates.io/crates/portable-pty` (0.9.0)
- **ConPTY API:** `https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session`
- **xterm.js v5:** `https://github.com/xtermjs/xterm.js`
- **html2canvas:** `https://html2canvas.hertzen.com/` (snapshot rendering)
- **alacritty_terminal crate:** `https://crates.io/crates/alacritty_terminal` (0.26.0) — alternativa avanzata a vt100

---

*Fine del piano di rebuild. Pronto per implementazione.*
