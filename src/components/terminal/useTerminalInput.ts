import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readText, readImage } from "@tauri-apps/plugin-clipboard-manager";
import { writeFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { downloadDir } from "@tauri-apps/api/path";

export function useTerminalInput(terminalId: string, containerRef: React.RefObject<HTMLDivElement | null>) {
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePasteFromClipboard = async () => {
      const tid = terminalIdRef.current;
      try {
        const text = await readText();
        if (text) {
          const normalized = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r");
          await invoke("terminal_write", { terminalId: tid, data: Array.from(new TextEncoder().encode(normalized)) });
          return;
        }
      } catch { }

      try {
        const image = await readImage();
        if (!image) return;

        const size = await image.size();
        const rgba = await image.rgba();

        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

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
        await writeFile(filename, new Uint8Array(buf), { baseDir: BaseDirectory.Download });

        const downloadPath = await downloadDir();
        const dest = `${downloadPath}\\${filename}`;

        await invoke("terminal_write", { terminalId: tid, data: Array.from(new TextEncoder().encode(dest)) });
      } catch {
        await invoke("terminal_write", {
          terminalId: tid,
          data: Array.from(new TextEncoder().encode("\r\n\x1b[33m[Clipboard contains non-text content]\x1b[0m\r\n")),
        });
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const isPaste =
        (e.ctrlKey && e.key.toLowerCase() === "v") ||
        (e.shiftKey && e.key === "Insert");
      if (!isPaste) return;
      e.preventDefault();
      e.stopPropagation();
      handlePasteFromClipboard();
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const tid = terminalIdRef.current;

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const paths: string[] = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const path = (file as File & { path?: string }).path;
          paths.push(path || file.name);
        }
        const text = paths.join(" ");
        await invoke("terminal_write", { terminalId: tid, data: Array.from(new TextEncoder().encode(text)) });
        return;
      }

      const text = e.dataTransfer?.getData("text/plain");
      if (text) {
        await invoke("terminal_write", { terminalId: tid, data: Array.from(new TextEncoder().encode(text)) });
      }
    };

    container.addEventListener("keydown", handleKeyDown, true);
    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("drop", handleDrop);

    return () => {
      container.removeEventListener("keydown", handleKeyDown, true);
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("drop", handleDrop);
    };
  }, [containerRef]);
}
