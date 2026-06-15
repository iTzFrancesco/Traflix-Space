use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::ptr;

use tracing::{info, error};

use windows::Win32::Foundation::{CloseHandle, HANDLE, HANDLE_FLAG_INHERIT};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile, SetHandleInformation};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
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
        let effective_shell = if shell_lower == "powershell" || shell_lower == "powershell.exe" {
            "powershell.exe -NoProfile -ExecutionPolicy Bypass"
        } else {
            shell
        };
        
        unsafe {
            let mut input_read = HANDLE::default();
            let mut input_write = HANDLE::default();
            let mut output_read = HANDLE::default();
            let mut output_write = HANDLE::default();

            // 1. Creiamo pipe con ereditarietà DISABILITATA di default
            if CreatePipe(&mut input_read, &mut input_write, None, 0).is_err() {
                return Err("Failed to create input pipe".into());
            }
            if CreatePipe(&mut output_read, &mut output_write, None, 0).is_err() {
                let _ = CloseHandle(input_read);
                let _ = CloseHandle(input_write);
                return Err("Failed to create output pipe".into());
            }

            // 2. Abilitiamo l'ereditarietà SOLO per gli handle slave (quelli che vanno alla Pseudo Console)
            let _ = SetHandleInformation(input_read, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT.0);
            let _ = SetHandleInformation(output_write, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT.0);

            let size = COORD { X: cols as i16, Y: rows as i16 };

            // 3. Creazione Pseudo Console
            let hpc = CreatePseudoConsole(size, input_read, output_write, 0).map_err(|e| {
                let _ = CloseHandle(input_read); let _ = CloseHandle(input_write);
                let _ = CloseHandle(output_read); let _ = CloseHandle(output_write);
                format!("Failed to create pseudo console: {}", e)
            })?;

            // 4. CHIUDIAMO SUBITO GLI HANDLE SLAVE NEL GENITORE
            // Questo è il passo critico saltato in precedenza. ConPTY duplica questi handle internamente.
            // Se rimangono aperti nel genitore, il kernel non può mai chiudere la pipe, bloccando ReadFile.
            let _ = CloseHandle(input_read);
            let _ = CloseHandle(output_write);

            let mut shell_wide: Vec<u16> = OsString::from(effective_shell).encode_wide().chain(std::iter::once(0)).collect();
            let mut startup_info: STARTUPINFOEXW = std::mem::zeroed();
            startup_info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;

            let mut attr_list_size = 0;
            let _ = InitializeProcThreadAttributeList(LPPROC_THREAD_ATTRIBUTE_LIST(ptr::null_mut()), 1, 0, &mut attr_list_size);
            let mut attr_list_buffer = vec![0u8; attr_list_size as usize];
            let attr_list_ptr = LPPROC_THREAD_ATTRIBUTE_LIST(attr_list_buffer.as_mut_ptr() as *mut _);

            if InitializeProcThreadAttributeList(attr_list_ptr, 1, 0, &mut attr_list_size).is_err() {
                let _ = ClosePseudoConsole(hpc);
                return Err("Failed to init attribute list".into());
            }
            startup_info.lpAttributeList = attr_list_ptr;

            if UpdateProcThreadAttribute(
                startup_info.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                Some(&hpc as *const HPCON as *const std::ffi::c_void), std::mem::size_of::<HPCON>(),
                None, None
            ).is_err() {
                let _ = DeleteProcThreadAttributeList(startup_info.lpAttributeList);
                let _ = ClosePseudoConsole(hpc);
                return Err("Failed to update attribute".into());
            }

            let mut process_info = PROCESS_INFORMATION::default();
            let cwd_wide = cwd.map(|c| OsString::from(c).encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>());
            let cmdline = PWSTR(shell_wide.as_mut_ptr());
            let cwd_param = cwd_wide.as_ref().map(|v| PCWSTR(v.as_ptr())).unwrap_or(PCWSTR(ptr::null()));

            // 5. Creazione Processo con bInheritHandles = FALSE
            // Microsoft raccomanda FALSE per ConPTY quando si usa STARTUPINFOEXW
            let created = CreateProcessW(
                None, cmdline, None, None, false,
                PROCESS_CREATION_FLAGS(EXTENDED_STARTUPINFO_PRESENT),
                None, cwd_param, &startup_info.StartupInfo, &mut process_info
            );

            let _ = DeleteProcThreadAttributeList(startup_info.lpAttributeList);

            if created.is_err() {
                let err_code = windows::Win32::Foundation::GetLastError();
                let _ = ClosePseudoConsole(hpc);
                let _ = CloseHandle(input_write);
                let _ = CloseHandle(output_read);
                return Err(format!("CreateProcessW Error: {:?}", err_code));
            }

            info!(pid = process_info.dwProcessId, "Processo creato con successo");

            let conpty = Self {
                inner: std::sync::Mutex::new(ConPtyInner {
                    hpc, input_write, output_read, process_info,
                }),
            };

            // Inizializzazione buffer
            let _ = conpty.resize(cols, rows);
            let _ = conpty.write(b"\r\n");

            Ok(conpty)
        }
    }

    pub fn write(&self, data: &[u8]) -> Result<usize, String> {
        let handle = self.inner.lock().unwrap().input_write;
        if handle.is_invalid() { return Err("PTY is closed".into()); }
        unsafe {
            let mut bytes_written = 0u32;
            let _ = WriteFile(handle, Some(data), Some(&mut bytes_written), None);
            Ok(bytes_written as usize)
        }
    }

    pub fn read_blocking(&self, buf: &mut [u8]) -> Result<usize, String> {
        let handle = self.inner.lock().unwrap().output_read;
        if handle.is_invalid() { return Ok(0); }
        unsafe {
            let mut bytes_read = 0u32;
            let result = ReadFile(handle, Some(buf), Some(&mut bytes_read), None);
            if result.is_err() {
                let err_code = windows::Win32::Foundation::GetLastError();
                if err_code == windows::Win32::Foundation::WIN32_ERROR(109) { return Ok(0); }
                return Err(format!("Read Error: {:?}", err_code));
            }
            Ok(bytes_read as usize)
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let hpc = self.inner.lock().unwrap().hpc;
        if hpc.is_invalid() { return Err("PTY closed".into()); }
        let size = COORD { X: cols as i16, Y: rows as i16 };
        unsafe { let _ = ResizePseudoConsole(hpc, size); }
        Ok(())
    }

    pub fn kill(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        unsafe {
            if !inner.process_info.hProcess.is_invalid() {
                let _ = TerminateProcess(inner.process_info.hProcess, 0);
                let _ = CloseHandle(inner.process_info.hProcess);
                let _ = CloseHandle(inner.process_info.hThread);
            }
            if !inner.hpc.is_invalid() { ClosePseudoConsole(inner.hpc); }
            if !inner.input_write.is_invalid() { let _ = CloseHandle(inner.input_write); }
            if !inner.output_read.is_invalid() { let _ = CloseHandle(inner.output_read); }
            inner.hpc = HPCON::default();
        }
        Ok(())
    }

    pub fn pid(&self) -> u32 { self.inner.lock().unwrap().process_info.dwProcessId }
}

impl Drop for ConPtyInner {
    fn drop(&mut self) {
        unsafe {
            if !self.process_info.hProcess.is_invalid() {
                let _ = TerminateProcess(self.process_info.hProcess, 0);
                let _ = CloseHandle(self.process_info.hProcess);
                let _ = CloseHandle(self.process_info.hThread);
            }
            if !self.hpc.is_invalid() { ClosePseudoConsole(self.hpc); }
            if !self.input_write.is_invalid() { let _ = CloseHandle(self.input_write); }
            if !self.output_read.is_invalid() { let _ = CloseHandle(self.output_read); }
        }
    }
}

const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x00080000;
