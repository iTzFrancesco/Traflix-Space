# Traflix Space

Agentic Development Environment (ADE) — desktop app per workspace, terminali multi-pannello e integrazione AI agent.

**Stack**: React 19, Tauri 2 (Rust), xterm.js 5, Zustand 5, Tailwind CSS v4, ConPTY. Windows only.

## Getting started

```sh
npm install
npm run dev        # Vite dev (port 1420)
npm run tauri dev  # Tauri + Vite dev
```

`npm run build` esegue `tsc && vite build`. Vite ignora `src-tauri/**` — riavvia Tauri dopo modifiche Rust.

Per istruzioni operative dettagliate (comandi, architettura, store, IPC, version bumping, convenzioni) vedi [`AGENTS.md`](AGENTS.md).

## Projects

- [Traflix](https://traflix.it) — piattaforma di video-making sociale
