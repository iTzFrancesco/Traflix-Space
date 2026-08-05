use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewBuilder, WebviewUrl};

const BROWSER_LABEL: &str = "browser";

#[derive(Clone, Serialize)]
struct BrowserUrlChanged {
    url: String,
    loading: bool,
}

fn is_allowed_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank"
}

fn browser_webview<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<tauri::Webview<R>, String> {
    app.get_webview(BROWSER_LABEL)
        .ok_or_else(|| "Browser non inizializzato".to_string())
}

#[tauri::command]
pub async fn browser_create(app: AppHandle) -> Result<(), String> {
    if app.get_webview(BROWSER_LABEL).is_some() {
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "Finestra principale non disponibile".to_string())?;

    let builder = WebviewBuilder::new(
        BROWSER_LABEL,
        WebviewUrl::External(tauri::Url::parse("about:blank").map_err(|error| error.to_string())?),
    )
    .incognito(true)
    .focused(false)
    .on_navigation(is_allowed_url)
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_page_load(|webview, payload| {
        let loading = matches!(payload.event(), PageLoadEvent::Started);
        let _ = webview.emit(
            "browser-url-changed",
            BrowserUrlChanged {
                url: payload.url().to_string(),
                loading,
            },
        );
    });

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|error| error.to_string())?;
    if !is_allowed_url(&parsed) || parsed.as_str() == "about:blank" {
        return Err("Il Browser accetta solo URL http:// o https://".to_string());
    }

    browser_webview(&app)?
        .navigate(parsed)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle) -> Result<(), String> {
    browser_webview(&app)?
        .reload()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_reset(app: AppHandle) -> Result<(), String> {
    browser_webview(&app)?
        .navigate(tauri::Url::parse("about:blank").map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_back(app: AppHandle) -> Result<(), String> {
    browser_webview(&app)?
        .eval("window.history.back();")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_forward(app: AppHandle) -> Result<(), String> {
    browser_webview(&app)?
        .eval("window.history.forward();")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_get_url(app: AppHandle) -> Result<String, String> {
    browser_webview(&app)?
        .url()
        .map(|url| url.to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_close(app: AppHandle) -> Result<(), String> {
    if let Some(browser) = app.get_webview(BROWSER_LABEL) {
        browser.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}
