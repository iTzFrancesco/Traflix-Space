import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface McpStatus {
  running: boolean;
  pid: number | null;
  healthy: boolean;
}

interface McpStore {
  status: McpStatus;
  loading: boolean;
  checkStatus: () => Promise<void>;
  startServer: () => Promise<void>;
  stopServer: () => Promise<void>;
}

export const useMcpStore = create<McpStore>()((set) => ({
  status: { running: false, pid: null, healthy: false },
  loading: false,

  checkStatus: async () => {
    try {
      const status = await invoke<McpStatus>("mcp_status");
      set({ status });
    } catch {
      set({ status: { running: false, pid: null, healthy: false } });
    }
  },

  startServer: async () => {
    set({ loading: true });
    try {
      const pid = await invoke<number>("mcp_start");
      set({ status: { running: true, pid, healthy: false }, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  stopServer: async () => {
    set({ loading: true });
    try {
      await invoke("mcp_stop");
      set({ status: { running: false, pid: null, healthy: false }, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
