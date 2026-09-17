//! ConPTY provider ownership for the native Windows runtime.

use std::ffi::{OsStr, OsString, c_void};
use std::fs::File;
use std::io::{self, Write};
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
    InitializeProcThreadAttributeList, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};

const JOB_TERMINATION_EXIT_CODE: u32 = 1;
#[cfg(debug_assertions)]
const ATOMIC_JOB_EXIT_MARKER_ENV: &str = "HMUX_RUNTIME_TEST_CONPTY_ATOMIC_JOB_EXIT_MARKER";

pub(crate) struct SpawnedConPty {
    pub(crate) process: ConPtyProcess,
    pub(crate) output: File,
}

pub(crate) struct SuspendedConPty {
    process: ConPtyProcess,
    output: File,
    primary_thread: OwnedHandle,
}

impl SuspendedConPty {
    #[must_use]
    pub(crate) fn process(&self) -> &ConPtyProcess {
        &self.process
    }

    pub(crate) fn resume(self) -> io::Result<SpawnedConPty> {
        if unsafe { ResumeThread(self.primary_thread.raw()) } == u32::MAX {
            let error = io::Error::last_os_error();
            let _ = self.process.terminate_job();
            return Err(io::Error::new(
                error.kind(),
                format!("ResumeThread failed: {error}"),
            ));
        }
        Ok(SpawnedConPty {
            process: self.process,
            output: self.output,
        })
    }
}

pub(crate) struct ConPtyProcess {
    process_id: u32,
    input: Mutex<Option<File>>,
    control: Mutex<ConPtyControl>,
}

impl ConPtyProcess {
    pub(crate) fn spawn_suspended(
        program: &Path,
        arguments: &[String],
        current_directory: &Path,
        environment_changes: &[(OsString, Option<OsString>)],
        rows: u16,
        columns: u16,
    ) -> io::Result<SuspendedConPty> {
        let job = configured_job()?;
        let (console_input, host_input) = inheritable_pipe(PipeHostEnd::Write)?;
        let (host_output, console_output) = inheritable_pipe(PipeHostEnd::Read)?;
        let coordinates = coordinates(rows, columns)?;
        let mut pseudo_console = 0;
        let created = unsafe {
            CreatePseudoConsole(
                coordinates,
                console_input.raw(),
                console_output.raw(),
                0,
                &raw mut pseudo_console,
            )
        };
        if created != 0 {
            return Err(io::Error::other(format!(
                "CreatePseudoConsole failed with HRESULT {created:#x}"
            )));
        }
        let pseudo_console = OwnedPseudoConsole::new(pseudo_console)?;

        let mut attributes =
            AttributeList::with_pseudo_console_and_job(pseudo_console.raw(), job.raw())?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>())
            .expect("extended startup structure size fits in u32");
        // Make the pseudoconsole attribute the sole standard-stream
        // authority. Otherwise CreateProcess can retain the Host's launch
        // packet stdin; that pipe reaches EOF as soon as the broker returns
        // and an interactive cmd.exe exits normally before the first attach.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
        startup.lpAttributeList = attributes.raw();

        let application = wide_null(program.as_os_str())?;
        let mut command_line = make_command_line(program.as_os_str(), arguments)?;
        let current_directory = wide_null(normalize_process_path(current_directory).as_os_str())?;
        let environment = make_environment_block(environment_changes)?;
        let mut process_information = PROCESS_INFORMATION::default();
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_ptr().cast::<c_void>(),
                current_directory.as_ptr(),
                &raw const startup.StartupInfo,
                &raw mut process_information,
            )
        };
        // ConPTY consumes these pipe endpoints asynchronously while attaching
        // the first client. Windows requires the host to retain them through
        // CreateProcess, then release them so EOF remains observable later.
        drop(console_input);
        drop(console_output);
        if created == 0 {
            return Err(io::Error::last_os_error());
        }
        exit_after_atomic_job_assignment_for_test(process_information.dwProcessId)?;
        drop(attributes);

        let process = OwnedHandle::from_nullable(process_information.hProcess)
            .ok_or_else(|| io::Error::other("CreateProcessW returned no process handle"))?;
        let primary_thread = match OwnedHandle::from_nullable(process_information.hThread) {
            Some(thread) => thread,
            None => {
                unsafe {
                    TerminateProcess(process.raw(), JOB_TERMINATION_EXIT_CODE);
                }
                return Err(io::Error::other(
                    "CreateProcessW returned no primary thread handle",
                ));
            }
        };
        let process_id = process_information.dwProcessId;
        let input = unsafe { File::from_raw_handle(host_input.into_raw().cast()) };
        let output = unsafe { File::from_raw_handle(host_output.into_raw().cast()) };
        Ok(SuspendedConPty {
            process: ConPtyProcess {
                process_id,
                input: Mutex::new(Some(input)),
                control: Mutex::new(ConPtyControl {
                    pseudo_console: Some(pseudo_console),
                    process,
                    job,
                    terminated: false,
                }),
            },
            output,
            primary_thread,
        })
    }

    #[must_use]
    pub(crate) fn process_id(&self) -> u32 {
        self.process_id
    }

    pub(crate) fn write_all(&self, bytes: &[u8]) -> io::Result<()> {
        self.write_with_progress(bytes).1
    }

    pub(crate) fn write_with_progress(&self, bytes: &[u8]) -> (usize, io::Result<()>) {
        let mut input = match self.input.lock() {
            Ok(input) => input,
            Err(_) => {
                return (
                    0,
                    Err(io::Error::other("ConPTY input lock was poisoned")),
                );
            }
        };
        let Some(input) = input.as_mut() else {
            return (
                0,
                Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "ConPTY input is closed",
                )),
            );
        };
        write_all_with_progress(input, bytes)
    }

    pub(crate) fn resize(&self, rows: u16, columns: u16) -> io::Result<()> {
        let control = self
            .control
            .lock()
            .map_err(|_| io::Error::other("ConPTY control lock was poisoned"))?;
        let pseudo_console = control
            .pseudo_console
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "ConPTY is closed"))?;
        let result = unsafe { ResizePseudoConsole(pseudo_console.raw(), coordinates(rows, columns)?) };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "ResizePseudoConsole failed with HRESULT {result:#x}"
            )))
        }
    }

    pub(crate) fn terminate_job(&self) -> io::Result<()> {
        self.input
            .lock()
            .map_err(|_| io::Error::other("ConPTY input lock was poisoned"))?
            .take();
        let mut control = self
            .control
            .lock()
            .map_err(|_| io::Error::other("ConPTY control lock was poisoned"))?;
        if control.terminated {
            return Ok(());
        }
        if unsafe { TerminateJobObject(control.job.raw(), JOB_TERMINATION_EXIT_CODE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        control.terminated = true;
        Ok(())
    }

    pub(crate) fn wait_timeout(&self, timeout: Duration) -> io::Result<Option<u32>> {
        let control = self
            .control
            .lock()
            .map_err(|_| io::Error::other("ConPTY control lock was poisoned"))?;
        let timeout = timeout
            .as_millis()
            .min(u128::from(u32::MAX - 1)) as u32;
        match unsafe { WaitForSingleObject(control.process.raw(), timeout) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0_u32;
                if unsafe { GetExitCodeProcess(control.process.raw(), &raw mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(code))
            }
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub(crate) fn wait_for_job_exit(&self, timeout: Duration) -> io::Result<()> {
        let control = self
            .control
            .lock()
            .map_err(|_| io::Error::other("ConPTY control lock was poisoned"))?;
        let timeout = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        match unsafe { WaitForSingleObject(control.job.raw(), timeout) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "provider Job did not become empty before the deadline",
            )),
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub(crate) fn close_console(&self) -> io::Result<()> {
        self.input
            .lock()
            .map_err(|_| io::Error::other("ConPTY input lock was poisoned"))?
            .take();
        self.control
            .lock()
            .map_err(|_| io::Error::other("ConPTY control lock was poisoned"))?
            .pseudo_console
            .take();
        Ok(())
    }
}

fn write_all_with_progress<W: Write + ?Sized>(
    writer: &mut W,
    bytes: &[u8],
) -> (usize, io::Result<()>) {
    let mut written = 0;
    while written < bytes.len() {
        match writer.write(&bytes[written..]) {
            Ok(0) => {
                return (
                    written,
                    Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "ConPTY input accepted no bytes",
                    )),
                );
            }
            Ok(count) => written = written.saturating_add(count),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return (written, Err(error)),
        }
    }
    (written, writer.flush())
}

struct ConPtyControl {
    pseudo_console: Option<OwnedPseudoConsole>,
    process: OwnedHandle,
    job: OwnedHandle,
    terminated: bool,
}

impl Drop for ConPtyControl {
    fn drop(&mut self) {
        if !self.terminated {
            unsafe {
                TerminateJobObject(self.job.raw(), JOB_TERMINATION_EXIT_CODE);
            }
        }
        self.pseudo_console.take();
    }
}

fn configured_job() -> io::Result<OwnedHandle> {
    let job = OwnedHandle::from_nullable(unsafe { CreateJobObjectW(null(), null()) })
        .ok_or_else(io::Error::last_os_error)?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast::<c_void>(),
            u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                .expect("job limit structure size fits in u32"),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

#[cfg(debug_assertions)]
fn exit_after_atomic_job_assignment_for_test(process_id: u32) -> io::Result<()> {
    let Some(marker) = std::env::var_os(ATOMIC_JOB_EXIT_MARKER_ENV) else {
        return Ok(());
    };
    let process = hmux_client::exact_local_process_generation(process_id)
        .map_err(|error| io::Error::other(error.to_string()))?;
    let encoded = serde_json::to_vec(&process).map_err(io::Error::other)?;
    std::fs::write(marker, encoded)?;
    std::process::exit(86);
}

#[cfg(not(debug_assertions))]
fn exit_after_atomic_job_assignment_for_test(_process_id: u32) -> io::Result<()> {
    Ok(())
}

enum PipeHostEnd {
    Read,
    Write,
}

fn inheritable_pipe(host_end: PipeHostEnd) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let security = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .expect("security attributes size fits in u32"),
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&raw mut read, &raw mut write, &raw const security, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let read = OwnedHandle::from_nullable(read)
        .ok_or_else(|| io::Error::other("CreatePipe returned no read handle"))?;
    let write = OwnedHandle::from_nullable(write)
        .ok_or_else(|| io::Error::other("CreatePipe returned no write handle"))?;
    let host = match host_end {
        PipeHostEnd::Read => read.raw(),
        PipeHostEnd::Write => write.raw(),
    };
    if unsafe { SetHandleInformation(host, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((read, write))
}

fn coordinates(rows: u16, columns: u16) -> io::Result<COORD> {
    let x = i16::try_from(columns)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "columns exceed ConPTY range"))?;
    let y = i16::try_from(rows)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "rows exceed ConPTY range"))?;
    if x == 0 || y == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "ConPTY dimensions must be non-zero",
        ));
    }
    Ok(COORD { X: x, Y: y })
}

struct OwnedHandle(HANDLE);

// Windows kernel handles are process-wide and may be transferred between
// threads. Access to each live handle is serialized by the owning mutex.
unsafe impl Send for OwnedHandle {}

impl OwnedHandle {
    fn from_nullable(raw: HANDLE) -> Option<Self> {
        (!raw.is_null()).then_some(Self(raw))
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    fn into_raw(self) -> HANDLE {
        let raw = self.0;
        std::mem::forget(self);
        raw
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct OwnedPseudoConsole(HPCON);

// The pseudoconsole handle is moved with ConPtyControl and all operations on
// it are serialized by the same mutex.
unsafe impl Send for OwnedPseudoConsole {}

impl OwnedPseudoConsole {
    fn new(raw: HPCON) -> io::Result<Self> {
        if raw == 0 {
            Err(io::Error::other("CreatePseudoConsole returned no console"))
        } else {
            Ok(Self(raw))
        }
    }

    fn raw(&self) -> HPCON {
        self.0
    }
}

impl Drop for OwnedPseudoConsole {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.0);
        }
    }
}

struct AttributeList {
    storage: Vec<usize>,
    job_list: Box<[HANDLE; 1]>,
    initialized: bool,
}

impl AttributeList {
    fn with_pseudo_console_and_job(pseudo_console: HPCON, job: HANDLE) -> io::Result<Self> {
        let mut bytes = 0_usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &raw mut bytes);
        }
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut list = Self {
            storage: vec![0; bytes.div_ceil(size_of::<usize>())],
            job_list: Box::new([job]),
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(list.raw(), 2, 0, &raw mut bytes) } == 0 {
            return Err(io::Error::last_os_error());
        }
        list.initialized = true;
        if unsafe {
            UpdateProcThreadAttribute(
                list.raw(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                pseudo_console as *const c_void,
                size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if unsafe {
            UpdateProcThreadAttribute(
                list.raw(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                list.job_list.as_ptr().cast::<c_void>(),
                size_of::<HANDLE>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(list)
    }

    fn raw(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr().cast::<c_void>()
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.raw());
            }
        }
    }
}

fn wide_null(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut encoded = value.encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows process value contains NUL",
        ));
    }
    encoded.push(0);
    Ok(encoded)
}

fn normalize_process_path(path: &Path) -> std::path::PathBuf {
    let encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    let verbatim = ['\\' as u16, '\\' as u16, '?' as u16, '\\' as u16];
    if encoded.starts_with(&verbatim)
        && encoded.get(4).is_some_and(|unit| {
            (*unit >= 'A' as u16 && *unit <= 'Z' as u16)
                || (*unit >= 'a' as u16 && *unit <= 'z' as u16)
        })
        && encoded.get(5) == Some(&(':' as u16))
        && encoded.get(6) == Some(&('\\' as u16))
    {
        return std::path::PathBuf::from(OsString::from_wide(&encoded[4..]));
    }
    let verbatim_unc = [
        '\\' as u16,
        '\\' as u16,
        '?' as u16,
        '\\' as u16,
        'U' as u16,
        'N' as u16,
        'C' as u16,
        '\\' as u16,
    ];
    if encoded.starts_with(&verbatim_unc) {
        let mut unc = vec!['\\' as u16, '\\' as u16];
        unc.extend_from_slice(&encoded[verbatim_unc.len()..]);
        return std::path::PathBuf::from(OsString::from_wide(&unc));
    }
    path.to_path_buf()
}

fn make_command_line(program: &OsStr, arguments: &[String]) -> io::Result<Vec<u16>> {
    let mut command_line = Vec::new();
    append_quoted_argument(&mut command_line, program)?;
    for argument in arguments {
        command_line.push(' ' as u16);
        append_quoted_argument(&mut command_line, OsStr::new(argument))?;
    }
    command_line.push(0);
    Ok(command_line)
}

fn append_quoted_argument(command_line: &mut Vec<u16>, argument: &OsStr) -> io::Result<()> {
    let encoded = argument.encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows process argument contains NUL",
        ));
    }
    let quote = encoded.is_empty()
        || encoded
            .iter()
            .any(|unit| *unit == ' ' as u16 || *unit == '\t' as u16 || *unit == '"' as u16);
    if quote {
        command_line.push('"' as u16);
    }
    let mut backslashes = 0_usize;
    for unit in encoded {
        if unit == '\\' as u16 {
            backslashes += 1;
            continue;
        }
        if unit == '"' as u16 {
            command_line.extend(std::iter::repeat_n('\\' as u16, backslashes * 2 + 1));
        } else {
            command_line.extend(std::iter::repeat_n('\\' as u16, backslashes));
        }
        backslashes = 0;
        command_line.push(unit);
    }
    if quote {
        command_line.extend(std::iter::repeat_n('\\' as u16, backslashes * 2));
        command_line.push('"' as u16);
    } else {
        command_line.extend(std::iter::repeat_n('\\' as u16, backslashes));
    }
    Ok(())
}

fn make_environment_block(
    changes: &[(OsString, Option<OsString>)],
) -> io::Result<Vec<u16>> {
    let mut entries = std::env::vars_os().collect::<Vec<_>>();
    for (key, value) in changes {
        let encoded_key = environment_key(key)?;
        entries.retain(|(candidate, _)| {
            environment_key(candidate)
                .is_ok_and(|candidate| windows_key_sort(&candidate) != windows_key_sort(&encoded_key))
        });
        if let Some(value) = value {
            entries.push((key.clone(), value.clone()));
        }
    }
    entries.sort_by(|(left, _), (right, _)| {
        windows_key_sort(&environment_key(left).unwrap_or_default())
            .cmp(&windows_key_sort(&environment_key(right).unwrap_or_default()))
    });
    let mut block = Vec::new();
    for (key, value) in entries {
        let key = environment_key(&key)?;
        let value = value.encode_wide().collect::<Vec<_>>();
        if value.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows environment value contains NUL",
            ));
        }
        block.extend(key);
        block.push('=' as u16);
        block.extend(value);
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    Ok(block)
}

fn environment_key(key: &OsStr) -> io::Result<Vec<u16>> {
    let encoded = key.encode_wide().collect::<Vec<_>>();
    let invalid_equals = encoded
        .iter()
        .enumerate()
        .any(|(index, unit)| *unit == '=' as u16 && index != 0);
    if encoded.is_empty() || encoded == ['=' as u16] || encoded.contains(&0) || invalid_equals {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows environment key is invalid",
        ));
    }
    Ok(encoded)
}

fn windows_key_sort(key: &[u16]) -> Vec<u16> {
    key.iter()
        .map(|unit| match *unit {
            65..=90 => *unit + 32,
            _ => *unit,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PrefixThenFail {
        remaining: usize,
    }

    impl Write for PrefixThenFail {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.remaining == 0 {
                return Err(io::Error::other("write failed"));
            }
            let written = bytes.len().min(self.remaining);
            self.remaining -= written;
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct FlushFailure;

    impl Write for FlushFailure {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::other("flush failed"))
        }
    }

    #[test]
    fn write_progress_preserves_the_accepted_prefix_on_failure() {
        let (written, outcome) =
            write_all_with_progress(&mut PrefixThenFail { remaining: 2 }, b"prompt");

        assert_eq!(written, 2);
        assert_eq!(outcome.unwrap_err().to_string(), "write failed");
    }

    #[test]
    fn write_progress_reports_a_complete_write_with_an_uncertain_flush() {
        let (written, outcome) = write_all_with_progress(&mut FlushFailure, b"prompt");

        assert_eq!(written, 6);
        assert_eq!(outcome.unwrap_err().to_string(), "flush failed");
    }

    #[test]
    fn command_line_uses_windows_argument_escaping() {
        let encoded = make_command_line(
            OsStr::new(r"C:\Program Files\probe.exe"),
            &["plain".into(), "space here".into(), "quote\"here".into()],
        )
        .unwrap();
        let command_line = String::from_utf16(&encoded[..encoded.len() - 1]).unwrap();

        assert_eq!(
            command_line,
            r#""C:\Program Files\probe.exe" plain "space here" "quote\"here""#
        );
    }

    #[test]
    fn process_cwd_uses_the_win32_spelling_for_verbatim_drive_paths() {
        assert_eq!(
            normalize_process_path(Path::new(r"\\?\C:\workspace\project")),
            Path::new(r"C:\workspace\project")
        );
    }

    #[test]
    fn process_cwd_uses_the_standard_spelling_for_verbatim_unc_paths() {
        assert_eq!(
            normalize_process_path(Path::new(r"\\?\UNC\server\share\project")),
            Path::new(r"\\server\share\project")
        );
    }
}
