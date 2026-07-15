# Wayfinder Map — Browser interno + Skills Drag-and-Drop

## Destination

Rendere funzionanti due feature critiche di Traflix Space:
1. **Browser interno**: visualizzare URL (localhost e remoti) dentro l'app
2. **Skills drag-and-drop**: trascinare una skill dal pannello Skills e rilasciarla su un terminale per attivarla

## Notes

- **Dominio**: Tauri v2, React 19, WebView2 (Windows)
- **Skills da consultare**: `research`, `backend-expert`, `systematic-debugging`
- **Approccio**: prima ricerca (AFK) su come implementare correttamente, poi prototipo/fix

## Decisions so far

- **[Ticket 1: Browser backend fix](./research-browser-backend.md)** — Ricerca completata. Implementato:
  - ✅ CSP fix: aggiunto `frame-src` per localhost in `tauri.conf.json`
  - ✅ `openInChildWebview()`: funzione per aprire URL esterni in child WebviewWindow Tauri
  - ✅ Error overlay migliorato: messaggi differenziati per errore locale vs esterno
  - ✅ Bottoni "Apri in finestra" e "Apri nel browser esterno" nell'error overlay
  - ✅ Permission `core:webview:allow-create-webview-window` aggiunta
  - ⏳ Da fare: proxy Rust per URL remoti non iframe-friendly (Opzione C)

- **[Ticket 2: Skills drag-and-drop fix](./research-skills-drag-drop.md)** — Ricerca completata. Implementato:
  - ✅ `TerminalPane.handleDrop`: ora accetta sia `application/json` che `text/plain`
  - ✅ Fallback: match del nome skill da `text/plain` contro la lista skills conosciute
  - ⏳ Da fare (altro agente su SkillsPanel.tsx): custom PointerSensor `DragAwarePointerSensor`

## Ticket 1: Browser interno non funziona

**Problema**: `BrowserView.tsx` usa un `<iframe>` ma:
1. La CSP in `tauri.conf.json` blocca `frame-src` → nessun URL esterno può caricare
2. Tauri v2 ha restrizioni aggiuntive sugli iframe
3. Molti siti hanno `X-Frame-Options: DENY`
4. Non c'è un vero backend Rust per il proxy/navigazione

**Soluzioni implementate**:
- CSP ampliata con `frame-src` per localhost su qualsiasi porta
- `openInChildWebview()` per URL remoti via `WebviewWindow` Tauri
- Backend Rust proxy (Opzione C) in sospeso

## Ticket 2: Skills drag-and-drop nel terminale non funziona

**Problema**: in `SkillsPanel.tsx` coesistono due sistemi di drag:
1. `@dnd-kit` (useSortable) per riordino dentro il pannello
2. HTML5 nativo (`draggable`, `onDragStart`) per drag verso terminale

I due sistemi interferiscono. L'altro agente sta modificando SkillsPanel.tsx con un approccio diverso.

**Soluzioni implementate (side terminale)**:
- `TerminalPane.handleDrop` ora accetta `application/json` + `text/plain`
- Fallback per compatibilità con diversi formati di drag
- SkillStore già pronto per gestire pending drops e debounce

## Out of scope

- Non si investigano browser engine esterni (Chromium embedded, WebView2 standalone)
- Non si riscrive l'intero pannello skills
