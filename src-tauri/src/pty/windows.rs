use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::ptr;

use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{CreatePipe, ReadFile, WriteFile};
use windows::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows::Win32::System::Pipes::PeekNamedPipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, PROCESS_CREATION_FLAGS,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTUPINFOEXW,
};

pub struct ConPty {
    hpc: HPCON,
    input_write: HANDLE,
    output_read: HANDLE,
    process_info: PROCESS_INFORMATION,
    cols: u16,
    rows: u16,
    shell: String,
}

unsafe impl Send for ConPty {}

impl ConPty {
    pub fn new(cols: u16, rows: u16, shell: &str, cwd: Option<&str>) -> Result<Self, String> {
        unsafe {
            let mut input_read = HANDLE::default();
            let mut input_write = HANDLE::default();

            let mut output_read = HANDLE::default();
            let mut output_write = HANDLE::default();

            if CreatePipe(&mut input_read, &mut input_write, ptr::null(), 0).is_err() {
                return Err("Failed to create input pipe".into());
            }

            if CreatePipe(&mut output_read, &mut output_write, ptr::null(), 0).is_err() {
                let _ = CloseHandle(input_read);
                let _ = CloseHandle(input_write);
                return Err("Failed to create output pipe".into());
            }

            let size = COORD {
                X: cols as i16,
                Y: rows as i16,
            };

            let mut hpc = HPCON::default();
            let hr = CreatePseudoConsole(size, input_read, output_write, 0, &mut hpc as *mut HPCON);

            if hr.is_err() {
                let _ = CloseHandle(input_read);
                let _ = CloseHandle(input_write);
                let _ = CloseHandle(output_read);
                let _ = CloseHandle(output_write);
                return Err("Failed to create pseudo console".into());
            }

            let shell_wide: Vec<u16> = OsString::from(shell)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            let mut startup_info: STARTUPINFOEXW = std::mem::zeroed();
            startup_info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;

            let mut attr_list_size = 0;
            let _ = InitializeProcThreadAttributeList(None, 1, 0, &mut attr_list_size);

            let mut attr_list_buffer = vec![0u8; attr_list_size as usize];
            let attr_list_ptr = attr_list_buffer.as_mut_ptr() as *mut _;

            if InitializeProcThreadAttributeList(Some(attr_list_ptr), 1, 0, &mut attr_list_size)
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
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                Some(&hpc as *const HPCON as *const std::ffi::c_void),
                std::mem::size_of::<HPCON>(),
                ptr::null_mut(),
                ptr::null_mut(),
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

            let cwd_ptr = cwd_wide
                .as_ref()
                .map(|v| v.as_ptr())
                .unwrap_or(std::ptr::null());

            let created = CreateProcessW(
                None,
                &mut shell_wide.clone(),
                None,
                None,
                false,
                PROCESS_CREATION_FLAGS(EXTENDED_STARTUPINFO_PRESENT),
                None,
                cwd_ptr,
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
                hpc,
                input_write,
                output_read,
                process_info,
                cols,
                rows,
                shell: shell.to_string(),
            })
        }
    }

    pub fn write(&self, data: &[u8]) -> Result<usize, String> {
        unsafe {
            let mut bytes_written = 0u32;
            let result = WriteFile(
                self.input_write,
                Some(data),
                Some(&mut bytes_written),
                ptr::null_mut(),
            );
            if result.is_err() {
                return Err("Failed to write to PTY".into());
            }
            Ok(bytes_written as usize)
        }
    }

    pub fn read(&self, buf: &mut [u8]) -> Result<usize, String> {
        unsafe {
            let mut bytes_available = 0u32;
            let mut total_bytes_available = 0u32;
            let mut bytes_left = 0u32;

            if PeekNamedPipe(
                self.output_read,
                None,
                0,
                Some(&mut bytes_available as *mut u32),
                Some(&mut total_bytes_available as *mut u32),
                Some(&mut bytes_left as *mut u32),
            )
            .is_err()
            {
                return Err("Failed to peek pipe".into());
            }

            if bytes_available == 0 {
                return Ok(0);
            }

            let to_read = std::cmp::min(buf.len() as u32, total_bytes_available);

            let mut bytes_read = 0u32;
            let result = ReadFile(
                self.output_read,
                Some(&mut buf[..to_read as usize]),
                Some(&mut bytes_read),
                ptr::null_mut(),
            );

            if result.is_err() {
                return Err("Failed to read from PTY".into());
            }

            Ok(bytes_read as usize)
        }
    }

    pub fn read_blocking(&self, buf: &mut [u8]) -> Result<usize, String> {
        unsafe {
            let mut bytes_read = 0u32;
            let result = ReadFile(
                self.output_read,
                Some(buf),
                Some(&mut bytes_read),
                ptr::null_mut(),
            );
            if result.is_err() {
                return Err("Failed to read from PTY".into());
            }
            Ok(bytes_read as usize)
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };
        unsafe {
            if ResizePseudoConsole(self.hpc, size).is_err() {
                return Err("Failed to resize PTY".into());
            }
        }
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    pub fn kill(&mut self) -> Result<(), String> {
        unsafe {
            if !self.process_info.hProcess.is_invalid() {
                let _ = TerminateProcess(self.process_info.hProcess, 0);
                let _ = CloseHandle(self.process_info.hProcess);
                let _ = CloseHandle(self.process_info.hThread);
            }
            if !self.hpc.is_invalid() {
                ClosePseudoConsole(self.hpc);
            }
            if !self.input_write.is_invalid() {
                let _ = CloseHandle(self.input_write);
            }
            if !self.output_read.is_invalid() {
                let _ = CloseHandle(self.output_read);
            }
        }
        Ok(())
    }

    pub fn is_alive(&self) -> bool {
        unsafe {
            let status = WaitForSingleObject(self.process_info.hProcess, 0);
            status != WAIT_OBJECT_0
        }
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    pub fn pid(&self) -> u32 {
        self.process_info.dwProcessId
    }
}

impl Drop for ConPty {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x00080000;
