/**
 * Ascoltatore centralizzato eventi "terminal-frame" dal backend Rust.
 * Routing: terminale attivo -> handler, inattivi -> buffer
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FrameDiff } from "./types";

type FrameHandler = (diff: FrameDiff) => void;

class FrameReceiver {
  private handlers = new Map<string, FrameHandler>();
  private buffers = new Map<string, FrameDiff[]>();
  private activeId: string | null = null;
  private unlisten: UnlistenFn | null = null;
  private initialized = false;

  async init() {
    if (this.initialized) return;
    this.unlisten = await listen<FrameDiff | FrameDiff[]>("terminal-frame", (event) => {
      const diffs = Array.isArray(event.payload) ? event.payload : [event.payload];
      for (const diff of diffs) {
        if (diff.terminalId === this.activeId) {
          this.handlers.get(diff.terminalId)?.(diff);
        } else {
          const buf = this.buffers.get(diff.terminalId) || [];
          buf.push(diff);
          this.buffers.set(diff.terminalId, buf);
        }
      }
    });
    this.initialized = true;
  }

  register(terminalId: string, handler: FrameHandler) {
    this.handlers.set(terminalId, handler);
    const buf = this.buffers.get(terminalId);
    if (buf && buf.length > 0) {
      for (const diff of buf) {
        handler(diff);
      }
      this.buffers.delete(terminalId);
    }
  }

  setActive(terminalId: string | null) {
    this.activeId = terminalId;
    if (terminalId) {
      const buf = this.buffers.get(terminalId);
      if (buf) {
        const handler = this.handlers.get(terminalId);
        if (handler) {
          for (const diff of buf) {
            handler(diff);
          }
        }
        this.buffers.delete(terminalId);
      }
    }
  }

  unregister(terminalId: string) {
    this.handlers.delete(terminalId);
    this.buffers.delete(terminalId);
  }

  destroy() {
    this.unlisten?.();
    this.handlers.clear();
    this.buffers.clear();
    this.initialized = false;
  }
}

export const frameReceiver = new FrameReceiver();
