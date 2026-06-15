use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::ptr;

use tracing::info;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, TerminateProcess, UpdateProcThreadAttribute,
    PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTUPINFOEXW,
};

pub struct ConPty {
    inner: std::sync::Mutex<ConPtyInner>,
}

struct ConPtyInner {
    hpc: HPCON,
    input_write: HANDLE,
    output_read: HANDLE,
    process_info: PROCESS_INFORMATION,
}

unsafe impl Send for ConPty {}
unsafe impl Sync for ConPty {}

impl ConPty {
    pub fn new(cols: u16, rows: u16, shell: &str, cwd: Option<&str>) -> Result<Self, String> {
        let shell_lower = shell.to_lowercase();
        let effective_shell = if shell_lower == "bash" || shell_lower == "bash.exe" {
            info!("Shell 'bash' su Windows, fallback a powershell.exe");
            "powershell.exe"
        } else {
            shell
        };
        unsafe {
            let mut input_read = HANDLE::default();
            let mut input_write = HANDLE::default();

            let mut output_read = HANDLE::default();
            let mut output_write = HANDLE::default();

            if CreatePipe(&mut input_read, &mut input_write, Some(ptr::null()), 0).is_err() {
                return Err("Failed to create input pipe".into());
            }

            if CreatePipe(&mut output_read, &mut output_write, Some(ptr::null()), 0).is_err() {
                let _ = CloseHandle(input_read);
                let _ = CloseHandle(input_write);
                return Err("Failed to create output pipe".into());
            }

            let size = COORD {
                X: cols as i16,
                Y: rows as i16,
            };

            let hpc = CreatePseudoConsole(size, input_read, output_write, 0).map_err(|_| {
                let _ = CloseHandle(input_read);
                let _ = CloseHandle(input_write);
                let _ = CloseHandle(output_read);
                let _ = CloseHandle(output_write);
                "Failed to create pseudo console".to_string()
            })?;

            let mut shell_wide: Vec<u16> = OsString::from(effective_shell)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            let mut startup_info: STARTUPINFOEXW = std::mem::zeroed();
            startup_info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;

            let mut attr_list_size = 0;
            let _ = InitializeProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST(ptr::null_mut()),
                1,
                0,
                &mut attr_list_size,
            );

            let mut attr_list_buffer = vec![0u8; attr_list_size as usize];
            let attr_list_ptr =
                LPPROC_THREAD_ATTRIBUTE_LIST(attr_list_buffer.as_mut_ptr() as *mut _);

            if InitializeProcThreadAttributeList(attr_list_ptr, 1, 0, &mut attr_list_size)
                .is_err()
            {
                let _ = ClosePseudoConsole(hpc);
                let _ = CloseHandle(input_read);
                let _ = CloseHandle(input_write);
                let _ = CloseHandle(output_read);
                let _ = CloseHandle(output_write);
                return Err("Failed to init attribute list".into());
            }

            startup_info.lpAttributeList = attr_list_ptr;

            if UpdateProcThreadAttribute(
                startup_info.lpAttributeList,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                Some(&hpc as *const HPCON as *const std::ffi::c_void),
                std::mem::size_of::<HPCON>(),
                None,
                None,
            )
            .is_err()
            {
                let _ = DeleteProcThreadAttributeList(startup_info.lpAttributeList);
                let _ = ClosePseudoConsole(hpc);
                let _ = CloseHandle(input_read);
                let _ = CloseHandle(input_write);
                let _ = CloseHandle(output_read);
                let _ = CloseHandle(output_write);
                return Err("Failed to update attribute".into());
            }

            let mut process_info = PROCESS_INFORMATION::default();

            let cwd_wide = cwd.map(|c| {
                OsString::from(c)
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect::<Vec<u16>>()
            });

            let cmdline = PWSTR(shell_wide.as_mut_ptr());
            let cwd_param = cwd_wide
                .as_ref()
                .map(|v| PCWSTR(v.as_ptr()))
                .unwrap_or(PCWSTR(ptr::null()));

            let created = CreateProcessW(
                None,
                cmdline,
                None,
                None,
                false,
                PROCESS_CREATION_FLAGS(EXTENDED_STARTUPINFO_PRESENT),
                None,
                cwd_param,
                &startup_info.StartupInfo,
                &mut process_info,
            );

            let _ = DeleteProcThreadAttributeList(startup_info.lpAttributeList);
            let _ = CloseHandle(input_read);
            let _ = CloseHandle(output_write);

            if created.is_err() {
                let _ = ClosePseudoConsole(hpc);
                let _ = CloseHandle(input_write);
                let _ = CloseHandle(output_read);
                return Err(format!("Failed to create process '{}'", shell));
            }

            Ok(Self {
                inner: std::sync::Mutex::new(ConPtyInner {
                    hpc,
                    input_write,
                    output_read,
                    process_info,
                }),
            })
        }
    }

    pub fn write(&self, data: &[u8]) -> Result<usize, String> {
        let handle = self.inner.lock().unwrap().input_write;
        if handle.is_invalid() {
            return Err("PTY is closed".into());
        }
        unsafe {
            let mut bytes_written = 0u32;
            let result = WriteFile(
                handle,
                Some(data),
                Some(&mut bytes_written),
                None,
            );
            if result.is_err() {
                return Err("Failed to write to PTY".into());
            }
            Ok(bytes_written as usize)
        }
    }

    pub fn read_blocking(&self, buf: &mut [u8]) -> Result<usize, String> {
        let handle = self.inner.lock().unwrap().output_read;
        if handle.is_invalid() {
            return Ok(0);
        }
        unsafe {
            let mut bytes_read = 0u32;
            let result = ReadFile(
                handle,
                Some(buf),
                Some(&mut bytes_read),
                None,
            );
            if result.is_err() {
                return Err("Failed to read from PTY".into());
            }
            Ok(bytes_read as usize)
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let hpc = self.inner.lock().unwrap().hpc;
        if hpc.is_invalid() {
            return Err("PTY is closed".into());
        }
        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };
        unsafe {
            if ResizePseudoConsole(hpc, size).is_err() {
                return Err("Failed to resize PTY".into());
            }
        }
        Ok(())
    }

    pub fn terminate_process(&self) {
        let inner = self.inner.lock().unwrap();
        inner.terminate_process();
    }

    pub fn kill(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        inner.terminate_process();
        inner.close_handles();
        Ok(())
    }

    pub fn pid(&self) -> u32 {
        self.inner.lock().unwrap().process_info.dwProcessId
    }
}

impl ConPtyInner {
    fn terminate_process(&self) {
        unsafe {
            if !self.process_info.hProcess.is_invalid() {
                let _ = TerminateProcess(self.process_info.hProcess, 0);
            }
        }
    }

    fn close_handles(&mut self) {
        unsafe {
            if !self.process_info.hProcess.is_invalid() {
                let _ = CloseHandle(self.process_info.hProcess);
                let _ = CloseHandle(self.process_info.hThread);
                self.process_info.hProcess = HANDLE::default();
                self.process_info.hThread = HANDLE::default();
            }
            if !self.hpc.is_invalid() {
                ClosePseudoConsole(self.hpc);
                self.hpc = HPCON::default();
            }
            if !self.input_write.is_invalid() {
                let _ = CloseHandle(self.input_write);
                self.input_write = HANDLE::default();
            }
            if !self.output_read.is_invalid() {
                let _ = CloseHandle(self.output_read);
                self.output_read = HANDLE::default();
            }
        }
    }
}

impl Drop for ConPtyInner {
    fn drop(&mut self) {
        self.terminate_process();
        self.close_handles();
    }
}

const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x00080000;
