import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  // The repository can contain provider checkouts with their own HTML entrypoints.
  // Restrict dependency crawling to Traflix's application entrypoint.
  optimizeDeps: {
    entries: ["index.html"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Provider checkouts are not part of the Traflix frontend. Their
      // internal agent metadata often contains Windows reparse links that
      // OneDrive cannot stat reliably, so chokidar must not enter them.
      ignored: [
        "**/src-tauri/**",
        "**/agenti-riferimento/**",
        "**/.agents/**",
        "**/.claude/**",
        "**/.codex/**",
        "**/.cline/**",
        "**/.fallow/**",
        "**/.opencode/**",
        "**/.pi/**",
        "**/.playwright-mcp/**",
        "**/.wayfinder/**",
        "**/.warp/**",
        "**/.worktreeinclude",
        "agenti-riferimento/cline/**",
        "agenti-riferimento/codebuff/**",
        "agenti-riferimento/codex/**",
        "agenti-riferimento/open-code/**",
        "agenti-riferimento/opencode/**",
        "agenti-riferimento/p/**",
        "agenti-riferimento/pi/**",
        "agenti-riferimento/warp/**",
      ],
    },
    fs: {
      strict: false,
    },
  },
}));
