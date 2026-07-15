# Ricerca: Browser interno — Backend e Architettura

## Problema

`BrowserView.tsx` usa un `<iframe>` per mostrare URL, ma non funziona per nessun URL esterno
e ha comportamenti inconsistenti anche su localhost.

## Cause identificate

### 1. CSP blocca frame-src

In `tauri.conf.json`:
```json
"csp": "default-src 'self'; script-src 'self'; connect-src 'self' ipc://localhost;
        style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:;
        worker-src 'self' blob:;"
```

Non c'è `frame-src` → WebView2 blocca TUTTI i tentativi di navigazione dell'iframe
verso URL esterni. Anche localhost è bloccato se non esplicitamente permesso.

### 2. Cross-origin restrictions

Anche se CSP lo permettesse, i siti web moderni bloccano il caricamento in iframe via:
- `X-Frame-Options: DENY` / `SAMEORIGIN`
- `Content-Security-Policy: frame-ancestors 'none'`

### 3. Nessun backend proxy

L'implementazione attuale è solo frontend: l'iframe tenta di caricare l'URL direttamente.
Non c'è un backend Rust che:
- Fetachi pagine per conto dell'utente
- Inietti script per gestire i link
- Gestisca autenticazione/sessioni
- Riscriva CSP delle pagine caricate

### 4. Tauri v2: restrizioni iframe

Tauri v2 permette iframe ma con limitazioni:
- Il `WebView` non supporta webview annidate (non si può creare una webview dentro un'altra)
- Le uniche opzioni sono: child window separata o iframe nella stessa webview
- La CSP deve essere configurata esplicitamente

## Soluzioni proposte

### Opzione A: iframe + CSP fix (per localhost development) ⭐ PIÙ PRATICA

Aggiungere alla CSP in `tauri.conf.json`:
```json
"csp": "default-src 'self'; frame-src 'self' http://localhost:* http://127.0.0.1:* https://localhost:*; ..."
```

**Pro**: Semplice, funziona per localhost (caso d'uso principale in development)
**Contro**: Non funziona per URL remoti, molti siti bloccano iframe, non è un vero "browser"

### Opzione B: Child WebviewWindow separata

Usare `new WebviewWindow('browser-xxx', { url: 'https://...' })` per aprire URL
in una finestra webview separata (Tauri v2 nativo).

```typescript
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const webview = new WebviewWindow('browser-' + Date.now(), {
  url: 'https://example.com',
  title: 'Browser',
  width: 1024,
  height: 768,
});
```

**Pro**: Funziona per QUALSIASI URL, niente CSP restrictions, WebView2 puro
**Contro**: Si apre come finestra separata, non embedded nel pannello laterale

### Opzione C: Custom Protocol Proxy (Rust)

Implementare un custom protocol Tauri (es. `traflix-browse://`) che:
1. Riceve un URL dal frontend
2. Fa una richiesta HTTP in Rust (con `reqwest`)
3. Riscrive i link relativi/assoluti per passare attraverso il proxy
4. Inietta un base tag per risolvere i path relativi
5. Restituisce il contenuto modificato al frontend

```
Frontend: traflix-browse://proxy?url=https://example.com
  → Rust: fetch https://example.com
  → Rust: rewrite links to traflix-browse://proxy?url=...
  → Rust: return modified HTML
  → Iframe: render HTML
```

**Pro**: Embedded nel pannello, bypassa X-Frame-Options, controllo completo
**Contro**: Complesso da implementare, problemi con JS/SPA, riscrittura CSS/images

### Opzione D: Secondary Tauri Window + IPC bridge

Aprire un URL in una seconda `WebviewWindow` ma COMUNICARE con essa via IPC:
- La webview secondaria carica l'URL target
- Comunica eventi con la webview principale via `emit`/`listen`
- La webview principale controlla la navigazione

**Pro**: Funziona per ogni URL, WebView2 nativo
**Contro**: Non embedded, richiede gestione eventi tra webview

## Raccomandazione

**Short term (fix immediato)**: 
1. Aggiungere `frame-src` alla CSP per localhost
2. L'iframe continuerà a funzionare per sviluppo locale (localhost:1420, 3000, 5173)

**Medium term (vero browser embedded)**: 
Implementare Opzione C (Custom Protocol Proxy) con un backend Rust che:
- Usa `reqwest` per fetchare pagine
- Riscrive link per passare attraverso il proxy
- Inietta JS per gestire form submission e navigazione
- Supporta cookies e sessioni di base

**Long term (browser a tutto schermo)**:
Valutare Opzione B + D per aprire URL complessi/SPA in webview separate
quando il proxy non è sufficiente.

## Implementazione Backend Rust (Opzione C)

```rust
// Nuovo modulo: src-tauri/src/browser/
// - commands.rs: browse_url, browse_back, browse_forward
// - proxy.rs: fetch + rewrite links
// - custom_protocol.rs: Registrazione custom protocol

#[tauri::command]
async fn browse_url(url: String) -> Result<BrowserResponse, String> {
    // 1. Fetch pagina
    // 2. Riscrivi link per passare dal proxy
    // 3. Inietta base tag
    // 4. Restituisci HTML + headers
}
```

Dipendenze Cargo da aggiungere:
```toml
reqwest = { version = "0.12", features = ["cookies"] }
scraper = "0.20"  # Per parse/rewrite HTML
url = "2"
```

## Fonti

- Tauri v2 CSP docs: https://v2.tauri.app/configure/security/
- Tauri v2 Webview API: `@tauri-apps/api/webview.d.ts` (child webview support)
- Tauri v2 WebviewWindow: `@tauri-apps/api/webviewWindow.d.ts` (new window)
- WebView2 iframe restrictions: Microsoft WebView2 documentation
