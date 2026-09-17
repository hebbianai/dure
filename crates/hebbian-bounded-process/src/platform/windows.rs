use crate::supervisor::{OutputStream, ReadState, SupervisedProcess};
use crate::windows_job::WindowsJob;
use crate::{CommandFailure, CommandSpec};
use std::ffi::{OsStr, c_void};
use std::fs::File;
use std::io::{self, Read};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, IntoRawHandle};
use std::os::windows::process::ExitStatusExt;
use std::process::ExitStatus;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_BROKEN_PIPE, GENERIC_READ, GENERIC_WRITE, HANDLE,
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::{CreatePipe, PeekNamedPipe};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
    GetExitCodeProcess, InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

mod executable;

const JOB_TERMINATION_EXIT_CODE: u32 = 1;

pub(crate) fn spawn(
    specification: &CommandSpec,
) -> Result<impl SupervisedProcess + Send, CommandFailure> {
    let job = WindowsJob::create(None).map_err(|_| CommandFailure::Spawn)?;
    let spawned = spawn_suspended(specification)?;
    complete_handoff(OwnedWindowsProcess::new(spawned, job))
}

trait SuspendedLaunch {
    fn assign(&mut self) -> Result<(), CommandFailure>;
    fn resume(&mut self) -> Result<(), CommandFailure>;
}

fn complete_handoff<P: SuspendedLaunch>(mut process: P) -> Result<P, CommandFailure> {
    process.assign()?;
    process.resume()?;
    Ok(process)
}

struct SpawnedProcess {
    process: OwnedHandle,
    primary_thread: OwnedHandle,
    stdout: File,
    stderr: Option<File>,
}

fn spawn_suspended(specification: &CommandSpec) -> Result<SpawnedProcess, CommandFailure> {
    let input = crate::input::prepare(specification)?;
    let stdin = match input.as_ref() {
        Some(file) => inheritable_input(file)?,
        None => null_device(GENERIC_READ)?,
    };
    let (stdout_read, stdout_write) = inheritable_pipe(OutputStream::Stdout)?;
    let (stderr_read, stderr) = if specification.captures_stderr() {
        let (read, write) = inheritable_pipe(OutputStream::Stderr)?;
        (Some(read), write)
    } else {
        (None, null_device(GENERIC_WRITE)?)
    };
    let inherited_handles = [stdin.raw(), stdout_write.raw(), stderr.raw()];
    let mut attributes = AttributeList::with_handle_list(&inherited_handles)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>())
        .expect("extended startup structure size fits in u32");
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin.raw();
    startup.StartupInfo.hStdOutput = stdout_write.raw();
    startup.StartupInfo.hStdError = stderr.raw();
    startup.lpAttributeList = attributes.raw();

    let application = executable::resolve(specification)?;
    let mut command_line = make_command_line(specification)?;
    let current_directory = specification
        .current_directory()
        .map(|directory| wide_null(directory.as_os_str()))
        .transpose()?;
    let environment_block = make_environment_block(specification)?;
    let environment = environment_block
        .as_ref()
        .map_or(null(), |block| block.as_ptr().cast::<c_void>());
    let mut process_information = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment,
            current_directory
                .as_ref()
                .map_or(null(), |directory| directory.as_ptr()),
            (&raw const startup.StartupInfo),
            &raw mut process_information,
        )
    };
    if created == 0 {
        return Err(CommandFailure::Spawn);
    }

    drop(attributes);
    drop(stdin);
    drop(stdout_write);
    drop(stderr);
    let process = OwnedHandle::from_nullable(process_information.hProcess);
    let primary_thread = OwnedHandle::from_nullable(process_information.hThread);
    let (process, primary_thread) = match (process, primary_thread) {
        (Some(process), Some(primary_thread)) => (process, primary_thread),
        (Some(process), None) => {
            unsafe {
                TerminateProcess(process.raw(), JOB_TERMINATION_EXIT_CODE);
            }
            return Err(CommandFailure::Spawn);
        }
        _ => return Err(CommandFailure::Spawn),
    };
    let stdout = unsafe { File::from_raw_handle(stdout_read.into_raw()) };
    let stderr = stderr_read.map(|read| unsafe { File::from_raw_handle(read.into_raw()) });
    Ok(SpawnedProcess {
        process,
        primary_thread,
        stdout,
        stderr,
    })
}

fn inheritable_input(file: &File) -> Result<OwnedHandle, CommandFailure> {
    let mut duplicate = null_mut();
    // Give this launch its own inheritable duplicate; never change inheritance
    // on a caller-owned handle. The explicit startup handle list includes it.
    let copied = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            file.as_raw_handle(),
            GetCurrentProcess(),
            &raw mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if copied == 0 {
        return Err(CommandFailure::StdinPrepare);
    }
    OwnedHandle::from_nullable(duplicate).ok_or(CommandFailure::StdinPrepare)
}

fn inheritable_pipe(stream: OutputStream) -> Result<(OwnedHandle, OwnedHandle), CommandFailure> {
    let security = inheritable_security_attributes();
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&raw mut read, &raw mut write, &raw const security, 0) } == 0 {
        return Err(stream.unavailable());
    }
    let read = OwnedHandle::from_nullable(read).ok_or_else(|| stream.unavailable())?;
    let write = OwnedHandle::from_nullable(write).ok_or_else(|| stream.unavailable())?;
    if unsafe { SetHandleInformation(read.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(stream.configure());
    }
    Ok((read, write))
}

fn null_device(access: u32) -> Result<OwnedHandle, CommandFailure> {
    let security = inheritable_security_attributes();
    let path = "NUL\0".encode_utf16().collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &raw const security,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    OwnedHandle::from_file(handle).ok_or(CommandFailure::Spawn)
}

fn inheritable_security_attributes() -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .expect("security attribute structure size fits in u32"),
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    }
}

struct OwnedWindowsProcess {
    process: OwnedHandle,
    primary_thread: Option<OwnedHandle>,
    stdout: Option<File>,
    stderr: Option<File>,
    job: WindowsJob,
    assigned: bool,
    status: Option<ExitStatus>,
    finished: bool,
}

impl OwnedWindowsProcess {
    fn new(spawned: SpawnedProcess, job: WindowsJob) -> Self {
        Self {
            process: spawned.process,
            primary_thread: Some(spawned.primary_thread),
            stdout: Some(spawned.stdout),
            stderr: spawned.stderr,
            job,
            assigned: false,
            status: None,
            finished: false,
        }
    }

    fn assign_to_job(&mut self) -> Result<(), CommandFailure> {
        self.job
            .assign(unsafe { BorrowedHandle::borrow_raw(self.process.raw()) })
            .map_err(|_| CommandFailure::Cleanup)?;
        self.assigned = true;
        Ok(())
    }

    fn resume_primary_thread(&mut self) -> Result<(), CommandFailure> {
        let thread = self.primary_thread.take().ok_or(CommandFailure::Cleanup)?;
        if unsafe { ResumeThread(thread.raw()) } != 1 {
            return Err(CommandFailure::Cleanup);
        }
        Ok(())
    }

    fn terminate(&mut self) -> io::Result<()> {
        if self.finished {
            return Ok(());
        }
        let result = if self.assigned {
            self.job.terminate(JOB_TERMINATION_EXIT_CODE)
        } else if unsafe { TerminateProcess(self.process.raw(), JOB_TERMINATION_EXIT_CODE) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
        self.finished = true;
        result
    }
}

impl SuspendedLaunch for OwnedWindowsProcess {
    fn assign(&mut self) -> Result<(), CommandFailure> {
        self.assign_to_job()
    }

    fn resume(&mut self) -> Result<(), CommandFailure> {
        self.resume_primary_thread()
    }
}

impl SupervisedProcess for OwnedWindowsProcess {
    fn terminate(&mut self) -> Result<(), CommandFailure> {
        OwnedWindowsProcess::terminate(self).map_err(|_| CommandFailure::Cleanup)
    }

    fn read_available(
        &mut self,
        stream: OutputStream,
        captured: &mut Vec<u8>,
        output_limit: usize,
    ) -> Result<ReadState, CommandFailure> {
        let pipe = match stream {
            OutputStream::Stdout => &mut self.stdout,
            OutputStream::Stderr => &mut self.stderr,
        };
        let Some(pipe) = pipe.as_mut() else {
            return Ok(ReadState::Complete);
        };
        let mut available = 0_u32;
        let peeked = unsafe {
            PeekNamedPipe(
                pipe.as_raw_handle().cast::<c_void>(),
                null_mut(),
                0,
                null_mut(),
                &raw mut available,
                null_mut(),
            )
        };
        if peeked == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                return Ok(ReadState::Complete);
            }
            return Err(stream.read_failure());
        }
        if available == 0 {
            return Ok(ReadState::Pending);
        }

        let retained_limit = output_limit.saturating_add(1);
        let retained_capacity = retained_limit.saturating_sub(captured.len());
        let read_limit = usize::try_from(available)
            .unwrap_or(usize::MAX)
            .min(8 * 1024)
            .min(retained_capacity.max(1));
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match pipe.read(&mut buffer[..read_limit]) {
                Ok(0) => return Ok(ReadState::Complete),
                Ok(length) => {
                    let retained = retained_capacity.min(length);
                    captured.extend_from_slice(&buffer[..retained]);
                    return Ok(if captured.len() > output_limit {
                        ReadState::Exceeded
                    } else {
                        ReadState::Pending
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
                    return Ok(ReadState::Complete);
                }
                Err(_) => return Err(stream.read_failure()),
            }
        }
    }

    fn close_output(&mut self, stream: OutputStream) {
        match stream {
            OutputStream::Stdout => self.stdout.take(),
            OutputStream::Stderr => self.stderr.take(),
        };
    }

    fn observe_exit(&mut self) -> Result<bool, CommandFailure> {
        if self.status.is_some() {
            return Ok(true);
        }
        match unsafe { WaitForSingleObject(self.process.raw(), 0) } {
            WAIT_TIMEOUT => Ok(false),
            WAIT_OBJECT_0 => {
                let mut code = 0_u32;
                if unsafe { GetExitCodeProcess(self.process.raw(), &raw mut code) } == 0 {
                    return Err(CommandFailure::ProcessWait);
                }
                self.status = Some(ExitStatus::from_raw(code));
                Ok(true)
            }
            _ => Err(CommandFailure::ProcessWait),
        }
    }

    fn finish(&mut self) -> Result<ExitStatus, CommandFailure> {
        self.job
            .terminate(JOB_TERMINATION_EXIT_CODE)
            .map_err(|_| CommandFailure::Cleanup)?;
        self.finished = true;
        self.status.ok_or(CommandFailure::ProcessWait)
    }
}

impl Drop for OwnedWindowsProcess {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

struct OwnedHandle(std::os::windows::io::OwnedHandle);

impl OwnedHandle {
    fn from_nullable(raw: HANDLE) -> Option<Self> {
        // SAFETY: the successful native call transfers one non-null handle.
        (!raw.is_null())
            .then(|| Self(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) }))
    }

    fn from_file(raw: HANDLE) -> Option<Self> {
        (raw != INVALID_HANDLE_VALUE)
            .then(|| Self::from_nullable(raw))
            .flatten()
    }

    fn raw(&self) -> HANDLE {
        self.0.as_raw_handle()
    }

    fn into_raw(self) -> HANDLE {
        self.0.into_raw_handle()
    }
}

struct AttributeList {
    storage: Vec<usize>,
    initialized: bool,
}

impl AttributeList {
    fn with_handle_list(handles: &[HANDLE]) -> Result<Self, CommandFailure> {
        let mut bytes = 0_usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &raw mut bytes);
        }
        if bytes == 0 {
            return Err(CommandFailure::Spawn);
        }
        let words = bytes.div_ceil(size_of::<usize>());
        let mut list = Self {
            storage: vec![0; words],
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(list.raw(), 1, 0, &raw mut bytes) } == 0 {
            return Err(CommandFailure::Spawn);
        }
        list.initialized = true;
        if unsafe {
            UpdateProcThreadAttribute(
                list.raw(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast::<c_void>(),
                std::mem::size_of_val(handles),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(CommandFailure::Spawn);
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

fn wide_null(value: &OsStr) -> Result<Vec<u16>, CommandFailure> {
    let mut encoded = value.encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(CommandFailure::Spawn);
    }
    encoded.push(0);
    Ok(encoded)
}

fn make_command_line(specification: &CommandSpec) -> Result<Vec<u16>, CommandFailure> {
    let mut command_line = Vec::new();
    command_line.push('"' as u16);
    let program = specification.program().as_os_str().encode_wide();
    for code_unit in program {
        if code_unit == 0 || code_unit == '"' as u16 {
            return Err(CommandFailure::Spawn);
        }
        command_line.push(code_unit);
    }
    command_line.push('"' as u16);
    for argument in specification.arguments() {
        command_line.push(' ' as u16);
        append_quoted_argument(&mut command_line, argument)?;
    }
    command_line.push(0);
    Ok(command_line)
}

fn make_environment_block(specification: &CommandSpec) -> Result<Option<Vec<u16>>, CommandFailure> {
    if !specification.clears_environment() && specification.environment().is_empty() {
        return Ok(None);
    }
    let mut entries = if specification.clears_environment() {
        Vec::new()
    } else {
        std::env::vars_os().collect::<Vec<_>>()
    };
    for (key, value) in specification.environment() {
        let encoded_key = environment_key(key)?;
        entries.retain(|(candidate, _)| {
            environment_key(candidate)
                .is_ok_and(|candidate| !windows_key_eq(&candidate, &encoded_key))
        });
        entries.push((key.clone(), value.clone()));
    }
    entries.sort_by(|(left, _), (right, _)| {
        windows_key_sort(&environment_key(left).unwrap_or_default()).cmp(&windows_key_sort(
            &environment_key(right).unwrap_or_default(),
        ))
    });

    let mut block = Vec::new();
    for (key, value) in entries {
        let key = environment_key(&key)?;
        let value = value.encode_wide().collect::<Vec<_>>();
        if value.contains(&0) {
            return Err(CommandFailure::Spawn);
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
    Ok(Some(block))
}

fn environment_key(key: &OsStr) -> Result<Vec<u16>, CommandFailure> {
    let encoded = key.encode_wide().collect::<Vec<_>>();
    let invalid_equals = encoded
        .iter()
        .enumerate()
        .any(|(index, unit)| *unit == '=' as u16 && index != 0);
    if encoded.is_empty() || encoded == ['=' as u16] || encoded.contains(&0) || invalid_equals {
        return Err(CommandFailure::Spawn);
    }
    Ok(encoded)
}

fn windows_key_eq(left: &[u16], right: &[u16]) -> bool {
    windows_key_sort(left) == windows_key_sort(right)
}

fn windows_key_sort(key: &[u16]) -> Vec<u16> {
    key.iter()
        .map(|unit| match *unit {
            65..=90 => *unit + 32,
            _ => *unit,
        })
        .collect()
}

fn append_quoted_argument(
    command_line: &mut Vec<u16>,
    argument: &OsStr,
) -> Result<(), CommandFailure> {
    let encoded = argument.encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(CommandFailure::Spawn);
    }
    let quote = encoded.is_empty()
        || encoded
            .iter()
            .any(|code_unit| *code_unit == ' ' as u16 || *code_unit == '\t' as u16);
    if quote {
        command_line.push('"' as u16);
    }
    let mut backslashes = 0_usize;
    for code_unit in encoded {
        if code_unit == '\\' as u16 {
            backslashes += 1;
        } else {
            if code_unit == '"' as u16 {
                command_line.extend(std::iter::repeat_n('\\' as u16, backslashes + 1));
            }
            backslashes = 0;
        }
        command_line.push(code_unit);
    }
    if quote {
        command_line.extend(std::iter::repeat_n('\\' as u16, backslashes));
        command_line.push('"' as u16);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn command_line_uses_windows_argument_escaping() {
        let mut specification = CommandSpec::new(r"C:\Program Files\probe.exe");
        specification.args([r"plain", r"space here", r#"quote"here"#, r"trailing \"]);

        let encoded = make_command_line(&specification).unwrap();
        let command_line = String::from_utf16(&encoded[..encoded.len() - 1]).unwrap();

        assert_eq!(
            command_line,
            r#""C:\Program Files\probe.exe" plain "space here" quote\"here "trailing \\""#
        );
    }

    #[derive(Default)]
    struct CleanupCalls {
        direct_process: usize,
        job: usize,
    }

    struct FakeLaunch {
        assign_fails: bool,
        resume_fails: bool,
        assigned: bool,
        cleanup: Rc<RefCell<CleanupCalls>>,
    }

    impl SuspendedLaunch for FakeLaunch {
        fn assign(&mut self) -> Result<(), CommandFailure> {
            if self.assign_fails {
                return Err(CommandFailure::Cleanup);
            }
            self.assigned = true;
            Ok(())
        }

        fn resume(&mut self) -> Result<(), CommandFailure> {
            if self.resume_fails {
                Err(CommandFailure::Cleanup)
            } else {
                Ok(())
            }
        }
    }

    impl Drop for FakeLaunch {
        fn drop(&mut self) {
            let mut cleanup = self.cleanup.borrow_mut();
            if self.assigned {
                cleanup.job += 1;
            } else {
                cleanup.direct_process += 1;
            }
        }
    }

    fn failing_launch(
        assign_fails: bool,
        resume_fails: bool,
    ) -> (FakeLaunch, Rc<RefCell<CleanupCalls>>) {
        let cleanup = Rc::new(RefCell::new(CleanupCalls::default()));
        (
            FakeLaunch {
                assign_fails,
                resume_fails,
                assigned: false,
                cleanup: Rc::clone(&cleanup),
            },
            cleanup,
        )
    }

    #[test]
    fn assignment_failure_cleans_the_unassigned_suspended_process() {
        let (launch, cleanup) = failing_launch(true, false);

        assert!(matches!(
            complete_handoff(launch),
            Err(CommandFailure::Cleanup)
        ));
        assert_eq!(cleanup.borrow().direct_process, 1);
        assert_eq!(cleanup.borrow().job, 0);
    }

    #[test]
    fn resume_failure_cleans_the_assigned_job() {
        let (launch, cleanup) = failing_launch(false, true);

        assert!(matches!(
            complete_handoff(launch),
            Err(CommandFailure::Cleanup)
        ));
        assert_eq!(cleanup.borrow().direct_process, 0);
        assert_eq!(cleanup.borrow().job, 1);
    }
}
