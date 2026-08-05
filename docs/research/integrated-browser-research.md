# Traflix Space — ricerca browser integrato

Data: 2026-08-05

## Contesto locale

Traflix Space usa Tauri 2 su Windows con WebView2, React 19 e un pannello destro già organizzato in sezioni `Files` e `Git changes` (`src/components/layout/RightPanel.tsx`). La configurazione abilita già le permission core per creare WebView e modificarne posizione/dimensione (`src-tauri/capabilities/default.json`), ma l'app non crea ancora WebView secondarie.

## Opzioni considerate

### `<iframe>` React

È la soluzione più semplice da integrare nel layout React e funziona bene per localhost o per pagine controllate dal team. Non è però un browser generico affidabile: il sito incorporato può impedire l'embed con `Content-Security-Policy: frame-ancestors` o `X-Frame-Options`. La policy `frame-ancestors` viene valutata dalla pagina caricata e può cancellare la navigazione dell'iframe.

Fonti:

- [MDN — CSP `frame-ancestors`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)
- [MDN — Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)

### `WebviewWindow` Tauri separata

È semplice da creare e può caricare direttamente un URL remoto, ma apre una finestra separata. Non soddisfa il requisito di un mini-browser dentro la sezione laterale e richiede inoltre una gestione separata di focus, dimensioni e chiusura.

### WebView2 figlio nativo dentro la finestra `main`

Tauri espone `Webview` per aggiungere un webview a una finestra esistente con posizione e dimensione proprie. L'API JavaScript documenta URL remoti e `setPosition`/`setSize`; l'API Rust espone inoltre `navigate`, `reload`, `url`, `on_navigation`, `on_new_window` e `on_download`. Questo consente una toolbar React sopra il webview e una superficie WebView2 nativa sotto di essa.

Fonti:

- [Tauri — JavaScript Webview API](https://v2.tauri.app/reference/javascript/api/namespacewebview/)
- [Tauri — Rust `Webview`](https://docs.rs/tauri/latest/tauri/webview/struct.Webview.html)
- [Tauri — Rust `WebviewBuilder`](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html)
- [Tauri — Rust `Window::add_child`](https://docs.rs/tauri/latest/tauri/window/struct.Window.html)

## Compatibilità URL

- URL `http://localhost:<porta>`, `http://127.0.0.1:<porta>` e `http://[::1]:<porta>` sono un caso d'uso naturale per il browser di sviluppo.
- Gli URL pubblici `https://...` possono essere caricati come navigazioni top-level nel WebView2 figlio, senza dipendere dai permessi di embedding dell'iframe.
- La barra deve accettare e normalizzare soltanto URL assoluti `http`/`https`. Schemi `file:`, `javascript:`, `data:`, `tauri:` e altri schemi esterni vanno bloccati o inoltrati al browser di sistema solo con un'azione esplicita.

La documentazione WebView2 distingue il caricamento remoto dal caricamento di contenuto locale. Per questo caso è preferibile la navigazione remota, non `file:` o `NavigateToString`, perché mantiene il comportamento e l'origine propri della pagina servita.

Fonte:

- [Microsoft — Using local content in WebView2 apps](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content)

## Sicurezza e capabilities

Il contenuto remoto non deve ereditare le permission locali di Traflix Space. La capability attuale usa `windows: ["main", "agent-notification"]`; per un webview secondario questo è troppo ampio, perché una capability associata a una finestra può applicarsi a tutti i webview di quella finestra. La configurazione va separata in capability per webview: shell principale e notifica con le permission locali, browser remoto con nessuna permission Tauri applicativa.

La capability remota di Tauri supporta pattern URL, ma la documentazione avverte esplicitamente del rischio di concedere accesso al sistema a sorgenti remote. La scelta consigliata è quindi: webview browser senza `invoke`/filesystem/shell/PTY, allowlist delle navigazioni HTTP(S) nel backend e gestione esplicita di popup, download e schemi esterni.

Fonti:

- [Tauri — Capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri — Capability `remote`](https://v2.tauri.app/reference/acl/capability/)
- [Tauri — CSP](https://v2.tauri.app/security/csp/)

## Popup e navigazione

WebView2 espone `NewWindowRequested` con URL, flag di user gesture e possibilità di gestire o annullare la nuova finestra. Il comportamento raccomandato per la prima versione è:

1. navigazioni top-level HTTP(S) consentite;
2. popup non avviati da un gesto utente bloccati;
3. popup HTTP(S) avviati dall'utente riutilizzati nella stessa superficie Browser oppure aperti nel browser di sistema con una scelta esplicita;
4. schemi esterni gestiti con una allowlist e mai navigati direttamente nel WebView2.

Fonte:

- [Microsoft — `CoreWebView2NewWindowRequestedEventArgs`](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2newwindowrequestedeventargs)

## Download, upload e permessi web

Download, upload, notifiche, camera/microfono, geolocalizzazione e autoplay non sono dettagli automatici di un iframe React: vanno trattati come policy del browser embedded. Il builder Tauri espone hook per download e nuova finestra; WebView2 espone permission request per categorie come file read/write e autoplay.

Prima versione consigliata:

- download tramite percorso scelto dall'utente, senza scritture silenziose;
- file upload lasciato al picker nativo del WebView2, da verificare su localhost e produzione;
- camera/microfono/geolocalizzazione negati di default e abilitabili solo in una fase successiva;
- storage persistente separato dal browser Edge personale, con opzione futura “Pulisci dati browser”.

Fonti:

- [Tauri — `WebviewBuilder::on_download`](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html)
- [Microsoft — WebView2 permission kinds](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionkind)
- [Microsoft — Custom management of network requests](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webresourcerequested)

## Raccomandazione

Implementare `Browser` come terza sezione del `RightPanel`, usando un WebView2 figlio nativo creato dal backend Tauri con `WebviewBuilder` e gestito dal frontend tramite comandi IPC sottili.

La toolbar React dovrebbe contenere URL, indietro, avanti, ricarica, stop e apertura esterna. Il backend dovrebbe possedere la superficie WebView2 e applicare la policy di navigazione, mentre React dovrebbe gestire solo stato visuale, layout, URL digitato e cronologia dei comandi.

Questo approccio soddisfa sia localhost sia URL HTTPS pubblici e non dipende dal fatto che il sito consenta l'embed. Il costo è maggiore rispetto a un iframe: serve sincronizzare coordinate native con il pannello React, separare le capabilities e implementare lifecycle, popup, download e messaggi di errore.

## Rischi da validare in un prototipo

- conversione corretta da `getBoundingClientRect()` a coordinate logiche della finestra Tauri;
- sovrapposizione del WebView2 con la toolbar React e con gli altri pannelli;
- ridimensionamento durante drag della sidebar e resize della finestra;
- persistenza della sessione/cookie senza concedere permission locali;
- autenticazione, file upload, download e popup su almeno un'app localhost e due siti HTTPS;
- comportamento del webview quando si cambia workspace o si chiude il pannello;
- disponibilità del WebView2 Runtime incluso/configurato dall'attuale installer MSI.
