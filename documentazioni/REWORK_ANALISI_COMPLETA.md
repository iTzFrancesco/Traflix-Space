# Rework Completo — Traflix Space

> Data: 2026-06-28
> Obiettivo: App usabile con 100 terminali, switch workspace istantaneo, 0 lag percepibile

---

## Indice

1. [Sintomi](#1-sintomi)
2. [Diagnosi delle cause profonde](#2-diagnosi)
3. [Piano d'azione dettagliato](#3-piano-dazione-dettagliato)
4. [Fase 1 — Rust Backend](#4-fase-1--rust-backend)
5. [Fase 2 — Frontend: Per-pane xterm](#5-fase-2--frontend-per-pane-xterm)
6. [Fase 3 — Frontend: Cleanup & Virtualizzazione](#6-fase-3--frontend-cleanup--virtualizzazione)
7. [Verifica e criteri di successo](#7-verifica-e-criteri-di-successo)

---

## 1. Sintomi

| # | Problema percepito | Gravità |
|---|--------------------|---------|
| 1 | Terminali "laggano" — output visibile dopo secondi | 🔴 BLOCKER |
| 2 | Cambio workspace = reset totale + lag + refresh | 🔴 BLOCKER |
| 3 | Aprire nuova workspace = freeze momentaneo | 🟠 ALTO |
| 4 | App crasha/PC si blocca con 100 terminali | 🟠 ALTO |
| 5 | Ridimensionamento finestra non ridimensiona il terminale | 🟡 MEDIO |
| 6 | Scrollback assente (non si può scorrere su) | 🟢 BASSO |

---

## 2. Diagnosi delle cause profonde

### 2A — 🔴 CRITICO: Oggetto `pool` ricreato ad ogni render

**File**: `src/components/terminal/TerminalPool.tsx:136-144`

```typescript
return {
    initXTerm, attachTo, detachCurrent, captureSnapshot, fit, dispose,
    term: xtermRef,
    getSnapshot: (id: string) => snapshotsRef.current.get(id) ?? null,  // NEW ARROW FN
    setSnapshot: (id: string, s: FrameSnapshot) => { snapshotsRef.current.set(id, s); },  // NEW ARROW FN
    get activeTerminalId() { return activeTerminalIdRef.current; },  // NEW GETTER
    get container() { return containerRef.current; },  // NEW GETTER
};
```

**Catena del danno**:
1. `useTerminalPool()` è chiamato in `WorkspaceView.tsx:132`
2. Ogni render di WorkspaceView crea un NUOVO oggetto `pool`
3. `pool` è passato a `WorkspaceGrid` → `TerminalPane`
4. `React.memo` su `TerminalPane` **non funziona** perché `pool` cambia ogni volta
5. `pool` è dipendenza di 3 `useEffect` in `TerminalPane`:
   - `useEffect([isActive, terminalId, pool.term])` — listener output
   - `useEffect([isActive, terminalId, shell, cwd, pool, agentId])` — spawn + attach
   - `useEffect([isActive, pool, terminalId])` — resize listener
6. OGNI render del padre triggera TUTTI e 3 gli effect → ri-attacca, ri-spawna, ri-iscrive

**Soluzione**: Eliminare `TerminalPool.tsx` completamente. Ogni `TerminalPane` gestisce la propria istanza xterm.js.

### 2B — 🔴 CRITICO: FrameScheduler.stop() non cancella i task

**File**: `src-tauri/src/terminal_engine/scheduler.rs:84-85`

```rust
pub fn stop(&self, _terminal_id: &str) {
    // VUOTO — non fa nulla
}
```

Ogni cambio di terminale attivo chiama:
- `scheduler.start(app, session)` — spawna un **nuovo** tokio task
- `scheduler.stop(old_terminal_id)` — non fa nulla

**Conseguenza**: Ogni switch di terminale lascia un task in esecuzione che:
- Ogni 500ms acquisisce read lock sul `TerminalSession`
- Itera su tutte le 1920 celle (80×24)
- Chiama `app.emit("terminal-frame", diff)` che nessuno ascolta

Con 50 switch = 50 task leaked. Con 100 terminali e uso continuo = centinaia di task.

**Soluzione**: Usare `HashMap<String, JoinHandle<()>>` + `CancellationToken` in `FrameScheduler`.

### 2C — 🔴 CRITICO: Cambio workspace = kill totale + reload

**File**: `src/components/workspace/WorkspaceView.tsx:140-164`

```typescript
useEffect(() => {
    if (!activeWorkspaceId) return;
    // UCCIDE TUTTE le sessioni PTY delle altre workspace
    for (const id of loadedMapRef.current.keys()) {
        if (id !== activeWorkspaceId) {
            terminalStore.killWorkspaceTerminals(id);
        }
    }
    // Ricarica il workspace attivo dal backend
    loadWorkspace(activeWorkspaceId);
}, [activeWorkspaceId, loadWorkspace]);
```

**Catena del danno**:
1. L'utente clicca su un workspace diverso nella sidebar
2. `setActiveWorkspace(newId)` → Zustand aggiorna → re-render
3. L'effect fire: KILLA TUTTI i terminali delle altre workspace
4. `loadedMap` viene svuotato delle altre entry
5. `loadWorkspace(newId)` chiama `invoke("get_workspace", { id })` → IPC costoso
6. Il workspace attuale viene ricaricato da capo
7. Tutti i terminali vengono creati nuovi (dal backend al frontend)

**Risultato**: Switchare workspace = ricaricare tutto da zero. Inaccettabile.

**Soluzione**: 
- NON killare le sessioni PTY al cambio workspace
- Tenere `loadedMap` popolato con cache LRU (già implementata ma killata)
- Solo i terminali VISIBILI montano component React
- Le workspace in background mantengono le sessioni Rust vive

### 2D — 🟠 ALTO: PTY resize non propagato al processo

**File**: `src-tauri/src/terminal_engine/session.rs:141-143`

```rust
pub fn resize(&mut self, cols: u16, rows: u16) {
    self.grid.resize(cols, rows);
    // MAI chiamato pair.master.resize()!
}
```

Il `PtyMaster` ottenuto da `portable-pty` non viene mai salvato dopo `spawn()`. Il metodo `master.resize()` non viene mai chiamato. Le applicazioni nel terminale (nano, vim, htop) non ricevono SIGWINCH — restano bloccate a 80×24.

**Soluzione**: Salvare `pair.master` in `TerminalSession` e chiamare `master.resize()` nel metodo `resize()`.

### 2E — 🟠 ALTO: Reader thread leak su kill

**File**: `src-tauri/src/terminal_engine/session.rs:88-123`

La `spawn_blocking` reader thread clona `reader_arc` (Arc<Mutex<Box<dyn Read>>>). Quando `kill()` setta `self.reader = None`, la Arc originale viene droppata, ma il clone nel reader thread mantiene vivo il reader. Il thread continua a leggere dal PTY anche dopo kill.

**Soluzione**: 
- Salvare `JoinHandle` del reader thread in `TerminalSession`
- In `kill()`, settare un flag atomico per fermare il loop
- Attendere/cancellare il JoinHandle

### 2F — 🟡 MEDIO: listener leak su unmount

**File**: `src/components/workspace/TerminalPane.tsx:66-83`

```typescript
let cancelled = false;
(async () => {
    const unlisten = await listen<TerminalOutput>("terminal-output", ...);
    if (!cancelled) unlistenRef.current = unlisten;
})();
return () => {
    cancelled = true;
    unlistenRef.current?.();
};
```

Se il componente smonta PRIMA che `listen()` risolva, la callback registra il listener ma `cancelled = true` impedisce di salvarlo in `unlistenRef.current`. Il listener Tauri rimane attivo per sempre.

**Soluzione**: Usare `unlistenRef` come `Array<UnlistenFn>` e pushare appena risolto, oppure usare pattern con `Promise.race` e cleanup forzato.

### 2G — 🟡 MEDIO: Zustand Map ricreata ad ogni set

**File**: `src/stores/terminalStore.ts`

Ogni `setActiveTerminal`, `updateTitle`, `markSpawned`, `markExited` crea una nuova `Map`. Anche se solo un terminale cambia, l'intera Map è nuova. Componenti che selezionano `terminals` si ri-renderizzano.

**Soluzione**: Usare `useShallow` nei selettori o convertire a `Record<string, TerminalState>`.

---

## 3. Piano d'azione dettagliato

### Struttura del lavoro

```
FASE 1 (Rust Backend)        FASE 2 (Frontend xterm)     FASE 3 (Frontend cleanup)
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│1A Scheduler Fix  │          │2A TerminalPane   │          │3A Store selectors│
│1B Resize Fix     │          │   rewrite        │          │3B Dead code      │
│1C Reader leak fix│          │2B Elimina Pool   │          │   removal        │
│                  │          │2C WorkspaceView   │          │3C Virtual scroll │
│                  │          │   fix             │          │3D Agent queue fix│
│                  │          │2D WorkspaceGrid   │          │                  │
│                  │          │   fix             │          │                  │
└─────────────────┘          └─────────────────┘          └─────────────────┘
         │                           │                           │
         └───────────────────────────┼───────────────────────────┘
                                     ▼
                          ┌─────────────────┐
                          │ REVIEW FINALE    │
                          │ + integration    │
                          │ test             │
                          └─────────────────┘
```

---

## 4. Fase 1 — Rust Backend

### 1A — FrameScheduler: task cancellation real

**File da modificare**: `scheduler.rs` + `mod.rs`

Stato attuale:
- `FrameScheduler` ha `inactive_interval` (solo)
- `start()` spawna un tokio::spawn con loop infinito
- `stop()` è vuoto

Nuovo design:

```rust
use std::collections::HashMap;
use tokio::sync::JoinHandle;

pub struct FrameScheduler {
    inactive_interval: Duration,
    tasks: HashMap<String, JoinHandle<()>>,
}

impl FrameScheduler {
    pub fn new() -> Self {
        Self {
            inactive_interval: Duration::from_millis(500),
            tasks: HashMap::new(),
        }
    }

    pub fn start(&mut self, app: AppHandle, session: Arc<RwLock<TerminalSession>>) {
        let id = session.blocking_read().id.clone();
        
        // Ferma eventuale task esistente per questo terminale
        self.stop(&id);
        
        let inactive_interval = self.inactive_interval;
        let handle = tokio::spawn(async move {
            loop {
                // Leggi sessione e manda diff...
                tokio::select! {
                    _ = tokio::time::sleep(inactive_interval) => {
                        // invia frame diff
                    }
                }
            }
        });
        
        self.tasks.insert(id, handle);
    }

    pub fn stop(&mut self, terminal_id: &str) {
        if let Some(handle) = self.tasks.remove(terminal_id) {
            handle.abort();
        }
    }
    
    pub fn stop_all(&mut self) {
        for (_, handle) in self.tasks.drain() {
            handle.abort();
        }
    }
}
```

Alternativa più pulita: usare `tokio_util::sync::CancellationToken`.

Dettaglio implementativo:

```rust
use tokio_util::sync::CancellationToken;

pub struct FrameScheduler {
    inactive_interval: Duration,
    tokens: HashMap<String, CancellationToken>,
}

impl FrameScheduler {
    pub fn start(&mut self, app: AppHandle, session: Arc<RwLock<TerminalSession>>) {
        let id = { session.read().await.id.clone() };
        let token = CancellationToken::new();
        let child_token = token.child_token();
        self.tokens.insert(id.clone(), token);
        
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = child_token.cancelled() => break,
                    _ = tokio::time::sleep(interval) => {
                        // ... normal loop body
                    }
                }
            }
        });
    }
    
    pub fn stop(&mut self, terminal_id: &str) {
        if let Some(token) = self.tokens.remove(terminal_id) {
            token.cancel();
        }
    }
}
```

Per usare `tokio_util`, aggiungere a `Cargo.toml`:
```toml
tokio-util = { version = "0.7", features = ["rt"] }
```

**Verifica**: 
- `cargo build` compila
- Cambiare terminale non accumula task (task manager / log)
- Dopo kill terminale, scheduler non emette più eventi

---

### 1B — PTY resize propagation

**File da modificare**: `session.rs` + `mod.rs`

Stato attuale: `resize()` modifica solo `grid.resize(cols, rows)`, non il PTY reale.

Fix: Salvare `pair.master` in `TerminalSession`.

Modifiche a `session.rs`:

```rust
use portable_pty::{CommandBuilder, PtySize, MasterPty};

pub struct TerminalSession {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pty: Option<Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send>>>>,
    pub master: Option<Arc<Mutex<Box<dyn MasterPty + Send>>>>,  // NUOVO
    pub reader: Option<Arc<Mutex<Box<dyn std::io::Read + Send>>>>,
    pub writer: Option<Arc<Mutex<Box<dyn std::io::Write + Send>>>>,
    pub grid: GridBuffer,
    pub parser: Arc<Mutex<AnsiParser>>,
    pub active: bool,
    pub agent_id: Option<String>,
    pub exit_code: Option<i32>,
}
```

In `spawn()`:
```rust
let master = pair.master.try_clone_master().map_err(|e| ...)?;  // NUOVO
self.pty = Some(Arc::new(Mutex::new(child_killer)));
self.master = Some(Arc::new(Mutex::new(master)));  // NUOVO
```

In `resize()`:
```rust
pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
    self.grid.resize(cols, rows);
    if let Some(ref master) = self.master {
        let mut master = master.lock().map_err(|_| "Master lock poisoned".to_string())?;
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: cols * 8,
            pixel_height: rows * 16,
        }).map_err(|e| format!("PTY resize error: {}", e))?;
    }
    Ok(())
}
```

**Nota**: `portable-pty` 0.8 ha `MasterPty::resize()` che prende `PtySize`.

**Verifica**:
- `cargo build` compila
- Ridimensionare finestra → applicazioni terminali ricevono SIGWINCH
- `htop` / `nano` si adattano alle nuove dimensioni

---

### 1C — Reader thread lifecycle

**File da modificare**: `session.rs`

Stato attuale: Il reader thread (`spawn_blocking`) non può essere fermato da kill().

Fix: Usare `Arc<AtomicBool>` come flag di stop salvato in `TerminalSession`.

```rust
use std::sync::atomic::{AtomicBool, Ordering};

pub struct TerminalSession {
    // ... campi esistenti ...
    pub reader_handle: Option<tokio::task::JoinHandle<()>>,  // NUOVO
    pub reader_stop: Arc<AtomicBool>,  // NUOVO
}
```

In `new()`:
```rust
reader_stop: Arc::new(AtomicBool::new(false)),
reader_handle: None,
```

In `spawn()`: dopo `spawn_blocking`:
```rust
// reader_stop è stato catturato dalla closure
self.reader_handle = Some(handle);
```

Reader thread:
```rust
let stop = self.reader_stop.clone();
tokio::task::spawn_blocking(move || {
    let mut buf = [0u8; 65536];
    loop {
        if stop.load(Ordering::Relaxed) { break; }  // NUOVO
        let n = { ... match reader.read(&mut buf) { ... } };
        // ...
    }
});
```

In `kill()`:
```rust
pub fn kill(&mut self) {
    self.reader_stop.store(true, Ordering::Relaxed);  // NUOVO: ferma reader thread
    if let Some(ref pty) = self.pty { ... }
    self.pty = None;
    self.master = None;  // NUOVO
    self.reader = None;
    self.writer = None;
}
```

**Verifica**:
- Killare terminale → reader thread termina entro 1 secondo
- Nessun leak di thread nel task manager
- Nuovi terminali funzionano dopo kill

---

## 5. Fase 2 — Frontend: Per-pane xterm

### 2A — TerminalPane rewrite (per-pane xterm)

**File**: `src/components/workspace/TerminalPane.tsx`

**Obiettivo**: Ogni `TerminalPane` crea e gestisce la propria istanza xterm.js.
Eliminare dipendenza da `pool` (TerminalPool).

Nuova interfaccia props:

```typescript
interface TerminalPaneProps {
  terminalId: string;
  shell: string;
  cwd: string;
  title: string;
  agentId?: string | null;
  isActive: boolean;
  onActivate: (id: string) => void;
  isVisible: boolean;  // NUOVO: per virtual scrolling
}
```

Nuovo lifecycle:

```
┌─────────────────────────────────────────────┐
│               TerminalPane mount             │
│  create xterm + FitAddon (ref)              │
└──────────────────┬──────────────────────────┘
                   │
          ┌────────┴────────┐
          ▼                 ▼
    isActive=true     isActive=false
          │                 │
    term.open(div)     term NOT open (hidden)
    fit() + focus()    snapshot canvas shown
    listen(output)     
    spawn(shell)      
          │                 │
          ├──click─────────►│
          │                 │
    onActivate(id)     snapshot capture → state
    ▼                                    │
    term.focus()                    unlisten()
          │                              │
          └──────────click───────────────┘
          
          ┌────────┴────────┐
          ▼                 ▼
        unmount         unmount
    dispose(xterm)    dispose(xterm)
    unlisten()        unlisten()
```

Dettaglio codice:

```typescript
export const TerminalPane = memo(function TerminalPane({
  terminalId, shell, cwd, title, agentId, isActive, onActivate, isVisible
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const [snapshot, setSnapshot] = useState<FrameSnapshot | null>(null);
  
  // 1. Crea xterm al mount
  useEffect(() => {
    const term = new Terminal({
      theme: STOCK_THEME,
      fontFamily: '"Cascadia Mono", monospace',
      fontSize: 14,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 500,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    
    return () => {
      unlistenRef.current?.();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);  // SOLO mount

  // 2. Apri/chiudi xterm nel container basato su isActive
  useEffect(() => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !containerRef.current) return;
    
    if (isActive) {
      term.open(containerRef.current);
      fitAddon.fit();
      term.focus();
      
      // Spawn PTY (lazy — solo primo attivamento)
      if (!spawnedRef.current) {
        spawnedRef.current = true;
        invoke("terminal_spawn", { terminalId, shell, cwd, cols: term.cols, rows: term.rows });
      }
      
      // Restore snapshot (se disponibile)
      if (snapshot) {
        renderSnapshotToTerm(term, snapshot);
        setSnapshot(null);  // clear dopo restore
      }
    }
    
    // Nessun cleanup: quando isActive=false, il contenitore rimane
    // ma non viene rimosso. Il div non ha xterm visibile fuori dallo
    // stato attivo.
  }, [isActive, terminalId, shell, cwd, snapshot]);
  
  // 3. Listener output terminale
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    
    (async () => {
      const unlisten = await listen<TerminalOutput>("terminal-output", (event) => {
        if (cancelled || event.payload.terminalId !== terminalId) return;
        xtermRef.current?.write(new Uint8Array(event.payload.data));
      });
      if (!cancelled) {
        if (unlistenRef.current) unlistenRef.current();
        unlistenRef.current = unlisten;
      }
    })();
    
    return () => {
      cancelled = true;
      // Non deregistrare qui — lasciamo correre il cleanup del mount principale
    };
  }, [isActive, terminalId]);  // MENO dipendenze
  
  // 4. Resize handler
  useEffect(() => {
    if (!isActive) return;
    const onResize = () => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;
      fitAddon.fit();
      invoke("terminal_resize", { terminalId, cols: term.cols, rows: term.rows });
    };
    window.addEventListener("resize", onResize);
    onResize();  // fit iniziale
    return () => window.removeEventListener("resize", onResize);
  }, [isActive, terminalId]);
  
  // 5. Keyboard input handler
  useTerminalInput(terminalId, containerRef);
  
  // 6. Activate callback
  const handleActivate = useCallback(() => onActivate(terminalId), [terminalId, onActivate]);
  
  // 7. Render: snapshot quando inattivo, xterm quando attivo
  if (!isActive) {
    // Mostra snapshot canvas
    return (
      <div style={INACTIVE_STYLE} onClick={handleActivate} tabIndex={-1} role="button">
        <TerminalSnapshot snapshot={snapshot} title={title} />
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

**Punti chiave**:
- `xtermRef` e `fitAddonRef` creati UNA VOLTA al mount
- `isActive = false` non distrugge xterm, solo non mostra
- Listener output si iscrive solo quando attivo
- Snapshot catturato quando si disattiva

### 2B — Elimina TerminalPool.tsx

**File da ELIMINARE**: `src/components/terminal/TerminalPool.tsx`

Nessuna sostituzione. Le funzionalità sono migrate in:
- `TerminalPane.tsx` → creazione/gestione xterm
- `TerminalSnapshot.tsx` → snapshot rendering (già esistente)

**Import da aggiornare**:
- `WorkspaceView.tsx`: rimuovere `import { useTerminalPool } from "../terminal/TerminalPool"`
- `WorkspaceGrid.tsx`: rimuovere prop `pool` dal type

### 2C — WorkspaceView: stop killing PTY on switch

**File**: `src/components/workspace/WorkspaceView.tsx`

Due modifiche principali:

**1. RIMUOVERE l'effect che killava i terminali** (righe 140-164)

Il vecchio effetto:
```typescript
useEffect(() => {
    if (!activeWorkspaceId) return;
    const terminalStore = useTerminalStore.getState();
    // KILLA TUTTE le altre workspace!!!
    for (const id of loadedMapRef.current.keys()) {
        if (id !== activeWorkspaceId) { terminalStore.killWorkspaceTerminals(id); }
    }
    // Rimuove da loadedMap
    ...
    loadWorkspace(activeWorkspaceId);
}, [activeWorkspaceId, loadWorkspace]);
```

Nuovo effetto:
```typescript
useEffect(() => {
    if (!activeWorkspaceId) return;
    // NON killare sessioni PTY — solo caricare se non già caricato
    if (!loadedMapRef.current.has(activeWorkspaceId)) {
        loadWorkspace(activeWorkspaceId);
    }
}, [activeWorkspaceId, loadWorkspace]);
```

**2. RIMUOVERE pool da WorkspaceView**

```typescript
// RIMOSSO: const pool = useTerminalPool();
// RIMOSSO: useEffect per initXTerm

// WorkspaceGrid ora non riceve pool
<WorkspaceGrid
    rows={activeLoaded.layout.rows}
    cols={activeLoaded.layout.cols}
    terminals={activeLoaded.terminals}
    onActivate={(id) => useTerminalStore.getState().setActiveTerminal(id)}
/>
```

**3. Mantenere LRU eviction** ma senza killare PTY:

```typescript
if (next.size > MAX_OPEN_WORKSPACES) {
    const currentActive = useWorkspaceStore.getState().activeWorkspaceId;
    const toEvict = openOrderRef.current.find(
        (k) => k !== currentActive && next.has(k),
    );
    if (toEvict) {
        // NON killare terminali — solo rimuovere dalla cache frontend
        next.delete(toEvict);
        openOrderRef.current = openOrderRef.current.filter((k) => k !== toEvict);
    }
}
```

### 2D — WorkspaceGrid: remove pool prop

**File**: `src/components/workspace/WorkspaceGrid.tsx`

Semplificazione:

```typescript
interface WorkspaceGridProps {
    rows: number;
    cols: number;
    terminals: TerminalConfig[];
    onActivate: (id: string) => void;
    // RIMOSSO: pool
}

export function WorkspaceGrid({ rows, cols, terminals, onActivate }: WorkspaceGridProps) {
    const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
    
    return (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, ... }}>
            {terminals.map((term) => (
                <TerminalPane
                    key={term.id}
                    terminalId={term.id}
                    shell={term.shell}
                    cwd={term.cwd}
                    title={term.title}
                    agentId={term.agentId}
                    isActive={term.id === activeTerminalId}
                    onActivate={onActivate}
                    // RIMOSSO: pool
                />
            ))}
        </div>
    );
}
```

---

## 6. Fase 3 — Frontend: Cleanup & Virtualizzazione

### 3A — Ottimizzazione selettori terminalStore

**File**: `src/stores/terminalStore.ts`

**Problema**: Map ricreata ad ogni set → re-render.

Fix: Convertire `Map` a `Record<string, TerminalState>` + selettori shallow.

```typescript
// Stato
terminals: Record<string, TerminalState> = {};  // invece di Map

// Setter
addTerminal: (config) => set((state) => ({
    terminals: { ...state.terminals, [config.id]: { ...newTerminal } },
})),

removeTerminal: (id) => set((state) => {
    const { [id]: _, ...rest } = state.terminals;
    return { terminals: rest };
}),
```

Aggiungere hook helper:
```typescript
// Hook con shallow comparison
export function useTerminalForWorkspace(workspaceId: string) {
    return useTerminalStore(
        (s) => Object.values(s.terminals).filter((t) => t.workspaceId === workspaceId),
        shallow,
    );
}
```

### 3B — Dead code removal

**File da ELIMINARE**:
- `src/components/terminal/FrameReceiver.ts` — mai inizializzato, eventi `terminal-frame` mai ascoltati
- `src/components/terminal/useTerminalEngine.ts` — mai importato

**Verifica**: `grep -r "FrameReceiver\|frameReceiver\|useTerminalEngine" src/` → 0 risultati.

### 3C — Virtual scrolling per grid

**File**: `src/components/workspace/WorkspaceGrid.tsx`

Per gestire 100 terminali senza lag, solo i terminali visibili dovrebbero montare componenti React.

```typescript
export function WorkspaceGrid({ rows, cols, terminals, onActivate }: WorkspaceGridProps) {
    const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
    const gridRef = useRef<HTMLDivElement>(null);
    const [visibleRange, setVisibleRange] = useState({ start: 0, end: rows * cols });
    
    // Con pochi terminali (≤ 8), render tutti
    // Con tanti terminali (> 8), render solo visibili + buffer
    const totalSlots = rows * cols;
    const useVirtualization = totalSlots > 8;
    
    useEffect(() => {
        if (!useVirtualization || !gridRef.current) return;
        const observer = new IntersectionObserver((entries) => {
            // Calcola range visibile
            // ...
        });
        // ...
    }, [useVirtualization]);
    
    const visibleTerminals = useVirtualization
        ? terminals.slice(visibleRange.start, visibleRange.end)
        : terminals;
    
    return (
        <div ref={gridRef} style={{ display: "grid", ... }}>
            {visibleTerminals.map((term) => (
                <TerminalPane key={term.id} ... />
            ))}
        </div>
    );
}
```

Per l'implementazione iniziale, lo virtual scrolling può essere rimandato a dopo la stabilizzazione delle Fasi 1-2. Il focus principale è: fix lag, fix switch workspace, fix pool.

### 3D — Agent launch queue cleanup

**File**: `src/lib/agentLauncher.ts`

Fix: Aggiungere abort signal:
```typescript
enqueue(terminalId: string, agentId: string) {
    // Verifica che il terminale esista ancora
    const exists = useTerminalStore.getState().terminals.get(terminalId);
    if (!exists) return;
    this.queue.push({ terminalId, agentId });
    // ...
}
```

---

## 7. Verifica e criteri di successo

### Criteri di accettazione

| # | Criterio | Come verificare |
|---|----------|-----------------|
| 1 | Switch workspace è istantaneo (< 200ms) | Timer console |
| 2 | Aprire 8 terminali non causa lag | Monitor FPS in DevTools |
| 3 | Switch tra terminali non accumula task leaked | `Get-Process` count / Rust log |
| 4 | Ridimensionare finestra ridimensiona terminali | Test visivo |
| 5 | Scroll funziona (xterm scrollback 500) | Test visivo |
| 6 | Uscita/Spawn PTY multiples funziona | `echo test` in 8 terminali |
| 7 | Nessun warning/errore in console | DevTools |

### Comandi di verifica

```powershell
# Verifica build Rust
cd src-tauri && cargo build 2>&1

# Verifica build frontend
npm run build

# Verifica TypeScript
npx tsc --noEmit
```

---

## Appendice A: Diagramma flusso dati NUOVO

```
┌──────────┐    terminal_spawn     ┌──────────────────┐
│Terminal 1│──────────────────────►│  Rust Backend     │
│ (xterm)  │◄──────────────────────│  - Session 1      │
│          │   terminal-output     │  - PTY reader thd │
└──────────┘   (event filtered)    │  - vt100 parser   │
                                    │  - GridBuffer     │
┌──────────┐    terminal_spawn     │                   │
│Terminal 2│──────────────────────►│  - Session 2      │
│ (xterm)  │◄──────────────────────│  - PTY reader thd │
│          │   terminal-output     │  - vt100 parser   │
└──────────┘   (event filtered)    └──────────────────┘

Workspace switch:
┌─────────────────────┐
│ Prima:              │     DOPO:
│ killWorkspaceTermina│ → NON uccidere sessioni
│ loadWorkspace       │ → Solo cambiare quali
│ respawn tutto      │   componenti sono montati
└─────────────────────┘

Memoria con 100 terminali:
┌─────────────────────────────────────┐
│ Frontend: only visible panes mount  │
│   ≈ 8 xterm.js × 2MB = 16MB        │
│ Backend: 100 session × 0.5MB = 50MB│
│ Totale stimato: ~100MB              │
└─────────────────────────────────────┘
```

## Appendice B: Riepilogo file modificati/creati/eliminati

### FILE MODIFICATI
| File | Cosa cambia |
|------|-------------|
| `src-tauri/src/terminal_engine/scheduler.rs` | Task cancellation con CancellationToken |
| `src-tauri/src/terminal_engine/session.rs` | MasterPty store, resize propagation, reader stop flag |
| `src-tauri/src/terminal_engine/mod.rs` | Adattamento nuove API scheduler/session |
| `src-tauri/src/terminal_engine/commands.rs` | resize ritorna Result |
| `src-tauri/Cargo.toml` | Aggiunta `tokio-util` |
| `src/components/workspace/TerminalPane.tsx` | REWRITE totale: per-pane xterm |
| `src/components/workspace/WorkspaceView.tsx` | Rimuovi pool, non killare PTY su switch |
| `src/components/workspace/WorkspaceGrid.tsx` | Rimuovi pool prop |
| `src/stores/terminalStore.ts` | Refactor Map → Record, selettori shallow |

### FILE ELIMINATI
| File | Motivo |
|------|--------|
| `src/components/terminal/TerminalPool.tsx` | Sostituito da per-pane xterm |
| `src/components/terminal/FrameReceiver.ts` | Dead code (mai inizializzato) |
| `src/components/terminal/useTerminalEngine.ts` | Dead code (mai importato) |

### FILE CREATI
Nessuno nuovo file. Tutte le modifiche sono su file esistenti.

---

## ⚠️ BUG NOT FIXED — Rework INCOMPLETO (28 Giugno 2026)

Il rework non è completo. I seguenti bug sono ancora presenti e devono essere risolti.

### Bug 1 — 🔴 CRITICO: Terminale si nasconde al cambio focus

**Sintomo**: Quando si clicca su un altro terminale (cambio focus), il terminale attualmente attivo si nasconde scomparendo dalla vista. Per farlo riapparire bisogna ricliccarlo.

**Causa**: Problema di timing in `fitAddon.fit()`. Quando il pane diventa attivo:
1. `isActive` cambia a `true`
2. React aggiorna il DOM: il container passa da `display:none` a `display:''`
3. L'effect `[isActive, ...]` esegue `fitAddon.fit()`
4. Il browser non ha ancora eseguito il layout del container (dimensioni = 0)
5. `fit()` calcola 0 colonne / 0 righe → terminale invisibile

**Fix** (`src/components/workspace/TerminalPane.tsx`):
```tsx
// effect 2 — usare requestAnimationFrame prima di fit()
if (isActive) {
  requestAnimationFrame(() => {
    fitAddon.fit();
    term.focus();
  });
  // ... resto del codice (spawn, restore snapshot, ecc.)
}
```

Oppure usare `ResizeObserver` invece di `fit()` reattivo.

---

### Bug 2 — 🔴 CRITICO: Input da tastiera non funziona / lagga

**Sintomo**: Scrivere nel terminale non produce output, o il testo appare in ritardo. Il terminale sembra non ricevere i tasti premuti.

**Causa**: Nel nuovo design per-pane xterm, l'istanza xterm.js non registra il callback `term.onData()`. Senza questo callback, i tasti premuti dall'utente non vengono mai inviati al backend Rust via `invoke("terminal_write", ...)`.

Nell'architettura precedente (TerminalPool), l'xterm condiviso aveva il suo `onData` registrato. Durante la riscrittura, questo passaggio è stato perso.

**Fix** (`src/components/workspace/TerminalPane.tsx`, effect 1 — mount):

Aggiungere dopo `term.loadAddon(fitAddon)`:
```tsx
term.onData((data) => {
  const encoder = new TextEncoder();
  invoke("terminal_write", {
    terminalId: terminalId,  // attenzione: terminalId deve essere catturato correttamente
    data: Array.from(encoder.encode(data)),
  }).catch(() => {});
});
```

**Attenzione**: `terminalId` deve essere catturato nella closure con un ref per avere il valore sempre fresco:
```tsx
const terminalIdRef = useRef(terminalId);
terminalIdRef.current = terminalId;
// ... in onData:
term.onData((data) => {
  const tid = terminalIdRef.current;
  invoke("terminal_write", {
    terminalId: tid,
    data: Array.from(new TextEncoder().encode(data)),
  }).catch(() => {});
});
```

---

### Prossimi passi

1. Fixare `fit()` con `requestAnimationFrame` (Bug 1)
2. Aggiungere `term.onData()` con ref a `terminalId` (Bug 2)
3. Ricostruire e testare
4. Verificare switch tra 8+ terminali senza lag
5. Verificare input tastiera in tempo reale
