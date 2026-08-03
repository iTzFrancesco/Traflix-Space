import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readText, readImage, writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { writeFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { downloadDir } from "@tauri-apps/api/path";
import { Terminal } from "xterm";
import { invokeWithTimeout } from "../../lib/timeout";
import { useTerminalStore } from "../../stores/terminalStore";

// ────────────────────────────────────────────────────────────
// Module-level: mappa container → terminalId per drag&drop
// e cache dei path ricevuti da Tauri drag-drop events.
// ────────────────────────────────────────────────────────────
const containerMap = new Map<HTMLElement, string>();
let tauriDragFilePaths: string[] | null = null;
let tauriDragInitialized = false;

function findTerminalIdAtPoint(x: number, y: number): string | null {
  // Tauri reports a PhysicalPosition, while the DOM expects CSS pixels.
  // Prefer the DPI-adjusted point, then retain the raw fallback for webviews
  // that already provide logical coordinates.
  const scale = window.devicePixelRatio || 1;
  const points = [[x / scale, y / scale], [x, y]];

  for (const [pointX, pointY] of points) {
    const el = document.elementFromPoint(pointX, pointY);
    let current: HTMLElement | null = el instanceof HTMLElement ? el : null;
    while (current) {
      const tid = current.dataset.terminalId;
      if (tid) return tid;
      current = current.parentElement;
    }

    // Native drops may land on the xterm canvas rather than a DOM descendant
    // visible to elementFromPoint. The registered container bounds are a
    // reliable fallback and also work with multiple terminals.
    for (const [container, tid] of containerMap) {
      const rect = container.getBoundingClientRect();
      if (
        pointX >= rect.left && pointX <= rect.right &&
        pointY >= rect.top && pointY <= rect.bottom
      ) {
        return tid;
      }
    }
  }
  return null;
}

function formatPathsForTerminal(paths: string[]): string {
  // Quotes preserve a dropped Windows path as one shell argument when it
  // contains spaces. Double quotes are accepted by PowerShell, cmd and common
  // Unix shells used by the integrated terminal.
  return paths.map((path) => `"${path}"`).join(" ");
}

async function writePathsToTerminal(paths: string[], x: number, y: number) {
  const tid = findTerminalIdAtPoint(x, y);
  if (!tid) return;
  const text = formatPathsForTerminal(paths);
  useTerminalStore.getState().markAgentInput(tid);
  await invokeWithTimeout(
    () => invoke("terminal_write", {
      terminalId: tid,
      data: Array.from(new TextEncoder().encode(text)),
    }),
    10000,
  );
}

function ensureTauriDragListeners() {
  if (tauriDragInitialized) return;
  tauriDragInitialized = true;

  // onDragDropEvent è l'API nativa Tauri v2. Quando il native handler
  // è attivo (default), il DOM drop event NON viene mai sparato — wry
  // consuma l'evento a livello nativo. Quindi gestiamo tutto qui.
  getCurrentWebview().onDragDropEvent(async (event) => {
    const p = event.payload;
    if (p.type === "enter") {
      tauriDragFilePaths = p.paths ?? null;
    } else if (p.type === "drop") {
      const filePaths = p.paths ?? null;
      tauriDragFilePaths = filePaths;
      if (filePaths && filePaths.length > 0) {
        await writePathsToTerminal(filePaths, p.position.x, p.position.y);
      }
    } else if (p.type === "leave") {
      tauriDragFilePaths = null;
    }
  }).catch(() => {
    // Ignora se l'evento non è disponibile
  });
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

    // Registra questo container nella mappa per drag&drop
    container.dataset.terminalId = terminalId;
    containerMap.set(container, terminalId);

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
        useTerminalStore.getState().markAgentInput(tid);
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
        const text = formatPathsForTerminal(tauriDragFilePaths);
        tauriDragFilePaths = null; // consumato
        useTerminalStore.getState().markAgentInput(tid);
        await invoke("terminal_write", {
          terminalId: tid,
          data: Array.from(new TextEncoder().encode(text)),
        });
        return;
      }

      // 2) Fallback: estrai path dall'evento DOM
      const paths = extractFilePathsFromDOM(e);
      if (paths && paths.length > 0) {
        const text = formatPathsForTerminal(paths);
        useTerminalStore.getState().markAgentInput(tid);
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
      delete container.dataset.terminalId;
      containerMap.delete(container);
    };
  }, [containerRef, terminalId, xtermRef]);
}
