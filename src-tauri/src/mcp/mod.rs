pub mod commands;

use std::fs::OpenOptions;
use std::io::Write;
use std::net::{TcpStream, SocketAddr};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

const CREATE_NO_WINDOW: u32 = 0x08000000;

use serde::Serialize;
use tracing::{info, warn};

const MCP_DIR: &str = r"C:\Users\Francesco\OneDrive\Documenti\developer\GitHub\AgenticCoding-Tools\mcp";

pub fn log_path() -> PathBuf {
    Path::new(MCP_DIR).join("mcp_error.log")
}
const MCP_HOST: &str = "127.0.0.1";
const MCP_PORT: u16 = 8000;
const HEALTH_RETRIES: u32 = 6;
const HEALTH_RETRY_DELAY_MS: u64 = 500;

#[derive(Serialize, Clone)]
pub struct McpStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub healthy: bool,
}

pub struct McpManager {
    process: Mutex<Option<Child>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
        }
    }

    pub fn start(&self) -> Result<u32, String> {
        let mut guard = self.process.lock().map_err(|e| e.to_string())?;

        if let Some(ref mut child) = *guard {
            match child.try_wait() {
                Ok(Some(_)) => *guard = None,
                Ok(None) => return Err("MCP server già in esecuzione".into()),
                Err(e) => {
                    warn!("Errore controllo processo MCP: {e}");
                    *guard = None;
                }
            }
        }

        let log_path = Path::new(MCP_DIR).join("mcp_error.log");
        let stderr_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("Impossibile aprire log: {e}"))?;

        writeln!(&stderr_file, "\n--- MCP server avvio {} ---", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))
            .ok();

        let child = Command::new("uv")
            .args([
                "run",
                "--with",
                "mcp",
                "--with",
                "python-dotenv",
                "server.py",
            ])
            .current_dir(MCP_DIR)
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(stderr_file)
            .spawn()
            .map_err(|e| format!("Impossibile avviare MCP server: {e}"))?;

        let pid = child.id();
        info!("MCP server avviato, PID: {pid}");
        *guard = Some(child);
        Ok(pid)
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            let _ = child.wait();
            info!("MCP server (PID {pid}) fermato");
            Ok(())
        } else {
            Err("MCP server non in esecuzione".into())
        }
    }

    pub fn status(&self) -> McpStatus {
        let mut guard = match self.process.lock() {
            Ok(g) => g,
            Err(_) => return McpStatus { running: false, pid: None, healthy: false },
        };

        let is_alive = match *guard {
            Some(ref mut child) => child.try_wait().map(|s| s.is_none()).unwrap_or(false),
            None => false,
        };

        let pid = if is_alive {
            guard.as_ref().map(|c| c.id())
        } else {
            None
        };

        let healthy = if is_alive {
            let addr: SocketAddr = format!("{MCP_HOST}:{MCP_PORT}").parse().unwrap();
            let mut ok = false;
            for _ in 0..HEALTH_RETRIES {
                if TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok() {
                    ok = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(HEALTH_RETRY_DELAY_MS));
            }
            ok
        } else {
            false
        };

        if is_alive && !healthy {
            warn!("MCP server (PID {}) vivo ma porta {MCP_PORT} non risponde", pid.unwrap_or(0));
        }

        McpStatus { running: is_alive, pid, healthy }
    }
}

pub fn read_logs() -> Result<String, String> {
    let path = log_path();
    if !path.exists() {
        return Ok("(nessun log)".into());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Errore lettura log: {e}"))?;
    let lines: Vec<&str> = content.lines().collect();
    let tail = lines.iter().rev().take(50).cloned().collect::<Vec<_>>();
    Ok(tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
}
