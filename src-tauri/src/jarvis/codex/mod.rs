//! Codex App Server integration (spec: "Traflix Space — Jarvis Codex App
//! Server Integration").
//!
//! C1 — Runtime: a single global `codex app-server` process managed by
//! [`runtime::CodexRuntimeManager`], speaking JSON-RPC 2.0 over stdio JSONL
//! ([`rpc::JsonRpcClient`]).
//!
//! Later chunks add: account (C2), models/settings (C3), threads/turns (C4),
//! dynamic tools (C5/C6), streaming events (C7), TTS (C8), steering (C9).

pub mod account;
pub mod events;
pub mod models;
pub mod rpc;
pub mod runtime;
pub mod threads;
pub mod tools;
pub mod types;

pub use runtime::CodexRuntimeManager;
