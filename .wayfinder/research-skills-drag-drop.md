# Ricerca: Skills Drag-and-Drop — Perché non funziona e come fixarlo

## Problema

Le skill card in `SkillsPanel.tsx` hanno due sistemi di drag che coesistono:
1. **@dnd-kit `useSortable`**: per riordinare le card dentro il pannello
2. **HTML5 native drag (`draggable` + `onDragStart`)**: per trascinare la skill nel terminale

Quando l'utente prova a trascinare una skill card su un terminale, il drag-to-terminal
non parte o i dati non vengono trasferiti correttamente.

## Analisi approfondita del codice

### SkillsPanel.tsx — Struttura SkillCard

```
<div ref={setNodeRef} style={style}>           ← useSortable container
  <button {...attributes} {...listeners}>       ← Grip handle (riordino @dnd-kit)
    <GripVertical />
  </button>
  <div draggable onDragStart={handleDragStart}> ← Content body (native drag-to-terminal)
    name + description
  </div>
  <button>                                      ← Favorite toggle
    <Star />
  </button>
</div>
```

### Cause del conflitto

**Causa 1: Interferenza PointerSensor**
- @dnd-kit usa `PointerSensor` con `activationConstraint: { distance: 8 }`
- Il `PointerSensor` cattura `pointerdown` sull'elemento (anche se gli `listeners`
  sono sul grip handle, il `DndContext` avvolge TUTTI gli elementi)
- Quando `pointerdown` avviene sul div content (con `draggable="true"`),
  @dnd-kit può chiamare `preventDefault()` o catturare il pointer event
- Questo impedisce al browser di iniziare il native HTML5 drag
- L'evento `dragstart` non si attiva MAI

**Causa 2: useSortable transform**
- `useSortable` applica `transform: CSS.Transform.toString(transform)` al container
- Le trasformazioni CSS possono interferire con il hit testing del native drag
- L'elemento draggable potrebbe non essere dove il browser pensa sia

**Causa 3: WebView2 drag-drop nativo**
- Su Windows/WebView2 (usato da Tauri), il drag-drop nativo di WebView2
  potrebbe intercettare gli eventi prima del frontend
- Tauri Webview ha `dragDropEnabled: true` di default
- Questo è pensato per file drops, ma può interferire con HTML5 native drag

**Causa 4: Sistema di eventi concorrenti**
- @dnd-kit usa pointer events (pointerdown/pointermove/pointerup)
- HTML5 drag usa eventi separati (dragstart/dragover/drop)
- Su WebView2, quando un pointer event è catturato, il drag nativo non parte
- I due sistemi NON sono compatibili se attivi sullo stesso elemento

## Soluzioni proposte

### Soluzione 1: Separare COMPLETAMENTE i due sistemi

Rimuovere `useSortable` dalla SkillCard. Sostituire il riordino con bottoni ↑↓
per spostare le skill nella lista. Il native HTML5 drag rimane per il drag-to-terminal.

**Pro**: Semplice, funziona sempre, nessun conflitto
**Contro**: Perde il drag-to-reorder UX, meno intuitivo

### Soluzione 2: @dnd-kit per TUTTO (anche terminal drag)

Usare solo @dnd-kit e rimuovere il native HTML5 drag:
- Customizzare `DragOverlay` per mostrare il nome della skill durante il drag
- Aggiungere un custom sensor che riconosce quando si draga FUORI dal pannello
- Quando l'utente rilascia sopra un terminale, @dnd-kit rileva la drop zone
- Comunicare il drop al terminale via event o direttamente

**Pro**: Unico sistema di drag, UI coerente
**Contro**: Complesso da implementare, @dnd-kit non è progettato per drop fuori dal suo contesto

### Soluzione 3: Disabilitare @dnd-kit quando si draga FUORI ⭐ CONSIGLIATA

Approccio ibrido:
1. Usare `useSortable` SOLO sul grip handle (già così)
2. Disabilitare il PointerSensor per l'intero DndContext
3. Usare invece un KeyboardSensor per il riordino
4. Lasciare il native HTML5 drag sul body della card
5. Il riordino via @dnd-kit avviene SOLO tramite keyboard

**Pro**: Libera i pointer events per il native drag, semplice da implementare
**Contro**: Perde il drag-to-reorder col mouse

### Soluzione 4: Custom PointerSensor che ignora elementi draggable ⭐⭐ MIGLIORE

Creare un custom sensor per @dnd-kit che NON attivi il sortable quando
il click inizia su un elemento con `draggable="true"`:

```typescript
class DragAwarePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent: event }: PointerEvent) => {
        // Se l'elemento o un parent ha draggable, non attivare @dnd-kit
        let el = event.target as HTMLElement | null;
        while (el) {
          if (el.hasAttribute('draggable') && el.getAttribute('draggable') === 'true') {
            return false;
          }
          el = el.parentElement;
        }
        return true;
      },
    },
  ];
}
```

**Pro**: Mantiene TUTTA la funzionalità (riordino + drag-to-terminal), niente compromessi
**Contro**: Richiede implementazione custom sensor (poco codice)

### Soluzione 5: Tauri onDragDropEvent API

Utilizzare l'API `onDragDropEvent` di Tauri invece di HTML5 native drag:
- Invece di `draggable`, usare `mousedown` + `mousemove` per iniziare il drag manualmente
- Il Tauri `onDragDropEvent` gestisce l'over/drop a livello di webview
- Non c'è conflitto con @dnd-kit perché usa eventi Tauri, non DOM

**Pro**: Funziona a livello WebView2, nessun conflitto DOM
**Contro**: API pensata per FILE drop, non per custom data; richiede setup più complesso

## Raccomandazione: Soluzione 4 (custom sensor)

Implementare `DragAwarePointerSensor` che ignora i click su elementi `draggable`.
Questo è il minimo sforzo per massimo risultato:
- 20 righe di codice custom sensor
- Non tocca la logica esistente
- Mantiene riordino drag col mouse e drag-to-terminal
- Funziona su WebView2/Windows

### Fix aggiuntivo: disabilitare dragDropEnabled di WebView2

In `tauri.conf.json`, per la finestra principale:
```json
"windows": [{
  "dragDropEnabled": false
}]
```

Oppure via API JS:
```typescript
import { getCurrentWebview } from '@tauri-apps/api/webview';
await getCurrentWebview().setAutoResize(true);
// Nota: dragDropEnabled è solo un'opzione di creazione, non modificabile dopo
```

**Attenzione**: Disabilitare `dragDropEnabled` impedisce anche il file drop nativo.
Valutare se serve.

### Debug: Verificare il flusso eventi

Per confermare il problema, aggiungere log temporanei:
```typescript
// In SkillsPanel.tsx, handleTerminalDragStart:
onDragStart={(e) => {
  console.log('[SKILL] dragstart fired', e.type);
  e.dataTransfer.setData('text/plain', name); // fallback formato semplice
  e.dataTransfer.setData('application/json', JSON.stringify({...}));
}}

// In TerminalPane.tsx, handleDragOver:
onDragOver={(e) => {
  console.log('[TERM] dragover', e.dataTransfer.types);
  e.preventDefault(); // essenziale per permettere drop!
}}
```

## Fonti

- @dnd-kit docs: https://docs.dndkit.com/api-documentation/sensors
- @dnd-kit PointerSensor: https://docs.dndkit.com/api-documentation/sensors/pointer
- Tauri v2 Webview drag-drop: `@tauri-apps/api/webview.d.ts` (dragDropEnabled option)
- WebView2 drag-drop: Microsoft WebView2 documentation
- HTML5 Drag and Drop: MDN Web Docs
