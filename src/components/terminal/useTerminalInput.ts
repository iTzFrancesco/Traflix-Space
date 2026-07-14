import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import { readText, readImage, writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { writeFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { downloadDir } from "@tauri-apps/api/path";
import { Terminal } from "xterm";
import { invokeWithTimeout } from "../../lib/timeout";

// ────────────────────────────────────────────────────────────
// Module-level cache: percorsi file ricevuti dagli eventi Tauri drag-drop
// (tauri://drag-enter / tauri://drag-drop)
// ────────────────────────────────────────────────────────────
let tauriDragFilePaths: string[] | null = null;

let tauriDragInitialized = false;

function ensureTauriDragListeners() {
  if (tauriDragInitialized) return;
  tauriDragInitialized = true;

  // Il core di Tauri emette questi eventi quando l'utente trascina file
  // da Windows Explorer nella finestra. Contengono i path completi.
  listen(TauriEvent.DRAG_ENTER, (event) => {
    tauriDragFilePaths = (event.payload as { paths: string[] }).paths;
  }).catch(() => { /* Ignora se l'evento non è disponibile */ });

  listen(TauriEvent.DRAG_DROP, (event) => {
    tauriDragFilePaths = (event.payload as { paths: string[] }).paths;
  }).catch(() => {});

  listen(TauriEvent.DRAG_LEAVE, () => {
    tauriDragFilePaths = null;
  }).catch(() => {});
}

// Prova a estrarre i path dei file dall'evento DOM drop,
// usando vari metodi (File.path, text/uri-list, text/plain)
function extractFilePathsFromDOM(e: DragEvent): string[] | null {
  // 1. File.path (estensione Tauri v1, può non funzionare in v2)
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    const out: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const p = (file as unknown as Record<string, unknown>).path;
      if (typeof p === "string" && p.length > 0) {
        out.push(p);
      }
    }
    if (out.length === files.length) return out; // tutti i file hanno il path
  }

  // 2. text/uri-list (file:// URI su Windows)
  const uriList = e.dataTransfer?.getData("text/uri-list");
  if (uriList) {
    const out = uriList
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
      .map((u) => {
        if (u.startsWith("file:///")) return decodeURIComponent(u.slice(8));
        return u;
      });
    if (out.length > 0) return out;
  }

  // 3. text/plain (fallback grezzo)
  const text = e.dataTransfer?.getData("text/plain");
  if (text && text.trim().length > 0) {
    // Su Windows quando si trascina un singolo file, text/plain contiene il path
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 0) return lines;
  }

  return null;
}

// ────────────────────────────────────────────────────────────
export function useTerminalInput(
  terminalId: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
  xtermRef?: RefObject<Terminal | null>,
) {
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Inizializza i listener Tauri drag-drop (una tantum)
    ensureTauriDragListeners();

    // ── Keydown handler (capture phase) ────────────────────
    // Intercettiamo Ctrl+V, Shift+Insert, Ctrl+C, Ctrl+Insert
    // PRIMA che xterm.js li processi.
    const handleKeyDown = (e: KeyboardEvent) => {
      const isPaste =
        (e.ctrlKey && e.key.toLowerCase() === "v") ||
        (e.shiftKey && e.key === "Insert");

      const isCopy =
        (e.ctrlKey && e.key.toLowerCase() === "c") ||
        (e.ctrlKey && e.key === "Insert");

      // ── Paste ──
      if (isPaste) {
        e.preventDefault();
        e.stopPropagation();
        handlePaste();
        return;
      }

      // ── Copy / SIGINT ──
      if (isCopy) {
        const term = xtermRef?.current;
        if (term && term.hasSelection()) {
          const selected = term.getSelection();
          term.clearSelection();
          e.preventDefault();
          e.stopPropagation();
          clipboardWriteText(selected).catch(() => {
            // fallback: execCommand
            try { navigator.clipboard?.writeText?.(selected); } catch { /* ok */ }
          });
          return;
        }
        // Nessuna selezione: lascia passare l'evento a xterm.js che invierà \x03
        return;
      }
    };

    // ── Paste event handler (capture phase) ────────────────
    // Catch-all per context menu paste e altre vie che non generano keydown.
    const handlePasteCapture = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      handlePaste();
    };

    const handlePaste = async () => {
      const tid = terminalIdRef.current;
      if (!tid) return;

      // 1. Tenta lettura testo via Tauri plugin
      let pastedText: string | null = null;
      try {
        const text = await readText();
        if (text) pastedText = text;
      } catch {
        // readText ha fallito
      }

      // 2. Se non c'è testo, prova a leggere immagine
      if (!pastedText) {
        try {
          const image = await readImage();
          if (image) {
            const size = await image.size();
            const rgba = await image.rgba();

            const canvas = document.createElement("canvas");
            canvas.width = size.width;
            canvas.height = size.height;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              const imageData = ctx.createImageData(size.width, size.height);
              imageData.data.set(rgba);
              ctx.putImageData(imageData, 0, 0);

              const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob((b) => {
                  if (b) resolve(b);
                  else reject(new Error("Failed to encode image as PNG"));
                }, "image/png");
              });

              const now = new Date();
              const pad = (n: number) => String(n).padStart(2, "0");
              const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
              const filename = `pasted_image_${ts}.png`;

              const buf = await blob.arrayBuffer();
              await writeFile(filename, new Uint8Array(buf), {
                baseDir: BaseDirectory.Download,
              });

              const downloadPath = await downloadDir();
              pastedText = `${downloadPath}\\${filename}`;
            }
          }
        } catch {
          // readImage ha fallito
        }
      }

      // 3. Se abbiamo un contenuto, scrivilo al terminale
      //    Incapsuliamo in bracketed paste markers (\x1b[200~ / \x1b[201~)
      //    così le applicazioni che lo supportano (PSReadLine, pi, agent AI,
      //    bash readline, vim, nano, ecc.) trattano il paste come blocco
      //    unico invece di eseguire ogni riga come comando separato.
      if (pastedText) {
        const normalized = pastedText
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n");
        const bracketed = "\x1b[200~" + normalized + "\x1b[201~";
        await invokeWithTimeout(
          () => invoke("terminal_write", {
            terminalId: tid,
            data: Array.from(new TextEncoder().encode(bracketed)),
          }),
          10000,
        );
      } else {
        await invokeWithTimeout(
          () => invoke("terminal_write", {
            terminalId: tid,
            data: Array.from(
              new TextEncoder().encode(
                "\r\n\x1b[33m[Appunti vuoti o formato non supportato]\x1b[0m\r\n",
              ),
            ),
          }),
          10000,
        );
      }
    };

    // ── Drag / Drop handlers ────────────────────────────
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const tid = terminalIdRef.current;

      // 1) Usa i path ricevuti dal core Tauri (tauri://drag-enter / tauri://drag-drop)
      if (tauriDragFilePaths && tauriDragFilePaths.length > 0) {
        const text = tauriDragFilePaths.join(" ");
        tauriDragFilePaths = null; // consumato
        await invoke("terminal_write", {
          terminalId: tid,
          data: Array.from(new TextEncoder().encode(text)),
        });
        return;
      }

      // 2) Fallback: estrai path dall'evento DOM
      const paths = extractFilePathsFromDOM(e);
      if (paths && paths.length > 0) {
        const text = paths.join(" ");
        await invoke("terminal_write", {
          terminalId: tid,
          data: Array.from(new TextEncoder().encode(text)),
        });
        return;
      }
    };

    // Registra listener
    container.addEventListener("keydown", handleKeyDown, true);
    container.addEventListener("paste", handlePasteCapture, true);
    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("drop", handleDrop);

    return () => {
      container.removeEventListener("keydown", handleKeyDown, true);
      container.removeEventListener("paste", handlePasteCapture, true);
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("drop", handleDrop);
    };
  }, [containerRef]);
}
