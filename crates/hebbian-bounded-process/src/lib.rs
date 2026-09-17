#![forbid(unsafe_op_in_unsafe_fn)]

#[cfg(not(any(unix, windows)))]
compile_error!("hebbian-bounded-process requires Unix process groups or Windows Job Objects");

mod command;
pub use command::{CommandSpec, OutputLimitAction};
mod input;
mod platform;
mod supervisor;

#[cfg(windows)]
pub mod windows_job;

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::{AsRawFd, BorrowedFd};
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
use std::os::fd::{FromRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::process::ExitStatus;
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimeoutStage {
    ProcessExit,
    StdoutDrain,
    StderrDrain,
}

impl TimeoutStage {
    #[must_use]
    pub fn token(self) -> &'static str {
        match self {
            Self::ProcessExit => "process_exit",
            Self::StdoutDrain => "stdout_drain",
            Self::StderrDrain => "stderr_drain",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandFailure {
    Spawn,
    StdinPrepare,
    StdoutUnavailable,
    StdoutConfigure,
    StderrUnavailable,
    StderrConfigure,
    // Retained so callers can keep decoding diagnostics emitted by older adapters.
    StdoutReaderSpawn,
    ProcessWait,
    Cleanup,
    Timeout(TimeoutStage),
    StdoutRead,
    StderrRead,
    OutputLimit,
}

impl CommandFailure {
    #[must_use]
    pub fn stage(self) -> &'static str {
        match self {
            Self::Spawn => "spawn",
            Self::StdinPrepare => "stdin_prepare",
            Self::StdoutUnavailable => "stdout_capture",
            Self::StdoutConfigure => "stdout_configure",
            Self::StderrUnavailable => "stderr_capture",
            Self::StderrConfigure => "stderr_configure",
            Self::StdoutReaderSpawn => "stdout_reader_spawn",
            Self::ProcessWait => "process_wait",
            Self::Cleanup => "cleanup",
            Self::Timeout(stage) => stage.token(),
            Self::StdoutRead => "stdout_read",
            Self::StderrRead => "stderr_read",
            Self::OutputLimit => "output_limit",
        }
    }
}

#[derive(Debug)]
pub struct CommandOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exceeded_limit: bool,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnixBoundCommandFailure {
    DirectoryAnchorUnavailable,
    DirectoryAnchorChanged,
    PreExecBarrierUnavailable,
    PreExecBarrierCancelled,
    Command(CommandFailure),
}

#[cfg(unix)]
impl UnixBoundCommandFailure {
    #[must_use]
    pub fn stage(self) -> &'static str {
        match self {
            Self::DirectoryAnchorUnavailable => "directory_anchor_unavailable",
            Self::DirectoryAnchorChanged => "directory_anchor_changed",
            Self::PreExecBarrierUnavailable => "pre_exec_barrier_unavailable",
            Self::PreExecBarrierCancelled => "pre_exec_barrier_cancelled",
            Self::Command(failure) => failure.stage(),
        }
    }
}

/// A borrowed, exact Unix directory capability used for a bounded child
/// launch. Construction snapshots the directory identity and pre-encodes the
/// canonical path so the child-side launch hook performs syscalls only.
#[cfg(unix)]
#[derive(Debug)]
pub struct UnixDirectoryAnchor<'a> {
    directory: BorrowedFd<'a>,
    canonical_path: CString,
    device: libc::dev_t,
    inode: libc::ino_t,
    owner: libc::uid_t,
    mode: libc::mode_t,
}

#[cfg(unix)]
impl<'a> UnixDirectoryAnchor<'a> {
    pub fn new(
        directory: BorrowedFd<'a>,
        canonical_path: &Path,
    ) -> Result<Self, UnixBoundCommandFailure> {
        if directory.as_raw_fd() <= libc::STDERR_FILENO {
            return Err(UnixBoundCommandFailure::DirectoryAnchorUnavailable);
        }
        let canonical_path = CString::new(canonical_path.as_os_str().as_bytes())
            .map_err(|_| UnixBoundCommandFailure::DirectoryAnchorUnavailable)?;
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(directory.as_raw_fd(), metadata.as_mut_ptr()) } == -1 {
            return Err(UnixBoundCommandFailure::DirectoryAnchorUnavailable);
        }
        let metadata = unsafe { metadata.assume_init() };
        if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Err(UnixBoundCommandFailure::DirectoryAnchorUnavailable);
        }
        Ok(Self {
            directory,
            canonical_path,
            device: metadata.st_dev,
            inode: metadata.st_ino,
            owner: metadata.st_uid,
            mode: metadata.st_mode,
        })
    }

    #[cfg(target_os = "linux")]
    #[must_use]
    pub fn descriptor_path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd()))
    }
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
const PRE_EXEC_READY_TOKEN: u8 = b'R';
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
const PRE_EXEC_RELEASE_TOKEN: u8 = b'G';
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
const PRE_EXEC_CANCEL_TOKEN: u8 = b'C';

/// Failure to create or drive a provider-conformance pre-exec barrier.
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnixPreExecBarrierControllerFailure {
    Create,
    ReadyRead,
    ReadyTimeout,
    ReadyProtocol,
    ReleaseWrite,
    InvalidState,
}

/// Exact identity published by the forked child immediately before provider
/// `exec`.
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UnixPreExecBarrierReady {
    process_id: u32,
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
impl UnixPreExecBarrierReady {
    #[must_use]
    pub fn process_id(self) -> u32 {
        self.process_id
    }
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
struct UnixPreExecBarrierParentEndpoints {
    ready_read: OwnedFd,
    release_read_guard: OwnedFd,
    release_write: Mutex<Option<OwnedFd>>,
}

/// Parent-side controller for the provider-conformance pre-exec barrier.
///
/// Dropping an unreleased controller writes a cancellation token. This wakes a
/// child already blocked in `pre_exec` and makes its spawn fail before provider
/// code runs.
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
pub struct UnixPreExecBarrierController {
    parent: Arc<UnixPreExecBarrierParentEndpoints>,
    barrier_file_descriptors: [libc::c_int; 5],
    ready_observed: bool,
    completed: bool,
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
impl UnixPreExecBarrierController {
    #[must_use]
    pub fn barrier_file_descriptors(&self) -> [libc::c_int; 5] {
        self.barrier_file_descriptors
    }

    /// Waits at most `timeout` for the child to reach the pre-exec boundary.
    ///
    /// The command runner blocks inside `Command::spawn` until this controller
    /// releases or cancels the child, so drive the two sides from distinct
    /// threads or processes. Dropping the controller after a timeout cancels a
    /// child that reaches the boundary later.
    pub fn wait_until_ready(
        &mut self,
        timeout: Duration,
    ) -> Result<UnixPreExecBarrierReady, UnixPreExecBarrierControllerFailure> {
        if self.ready_observed || self.completed {
            return Err(UnixPreExecBarrierControllerFailure::InvalidState);
        }
        wait_until_file_descriptor_readable(self.parent.ready_read.as_raw_fd(), timeout)?;
        let mut frame = [0_u8; 1 + std::mem::size_of::<libc::pid_t>()];
        read_exact_file_descriptor(self.parent.ready_read.as_raw_fd(), &mut frame)
            .map_err(|_| UnixPreExecBarrierControllerFailure::ReadyRead)?;
        if frame[0] != PRE_EXEC_READY_TOKEN {
            return Err(UnixPreExecBarrierControllerFailure::ReadyProtocol);
        }
        let mut encoded_pid = [0_u8; std::mem::size_of::<libc::pid_t>()];
        encoded_pid.copy_from_slice(&frame[1..]);
        let process_id = libc::pid_t::from_ne_bytes(encoded_pid);
        let process_id = u32::try_from(process_id)
            .ok()
            .filter(|process_id| *process_id > 1)
            .ok_or(UnixPreExecBarrierControllerFailure::ReadyProtocol)?;
        self.ready_observed = true;
        Ok(UnixPreExecBarrierReady { process_id })
    }

    pub fn release(mut self) -> Result<(), UnixPreExecBarrierControllerFailure> {
        self.write_completion(PRE_EXEC_RELEASE_TOKEN)
    }

    pub fn cancel(mut self) -> Result<(), UnixPreExecBarrierControllerFailure> {
        self.write_completion(PRE_EXEC_CANCEL_TOKEN)
    }

    /// Closes the release writer after readiness, exercising the child-side
    /// EOF cancellation path without sending a protocol byte.
    pub fn disconnect(mut self) -> Result<(), UnixPreExecBarrierControllerFailure> {
        if !self.ready_observed || self.completed {
            return Err(UnixPreExecBarrierControllerFailure::InvalidState);
        }
        self.parent
            .release_write
            .lock()
            .map_err(|_| UnixPreExecBarrierControllerFailure::InvalidState)?
            .take();
        self.completed = true;
        Ok(())
    }

    fn write_completion(&mut self, token: u8) -> Result<(), UnixPreExecBarrierControllerFailure> {
        if !self.ready_observed || self.completed {
            return Err(UnixPreExecBarrierControllerFailure::InvalidState);
        }
        let result = self
            .parent
            .release_write
            .lock()
            .map_err(|_| UnixPreExecBarrierControllerFailure::InvalidState)?
            .as_ref()
            .ok_or(UnixPreExecBarrierControllerFailure::InvalidState)
            .and_then(|descriptor| {
                write_all_file_descriptor(descriptor.as_raw_fd(), &[token])
                    .map_err(|_| UnixPreExecBarrierControllerFailure::ReleaseWrite)
            });
        if result.is_ok() {
            self.completed = true;
        }
        result
    }
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
impl Drop for UnixPreExecBarrierController {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        if let Ok(release_write) = self.parent.release_write.lock() {
            if let Some(descriptor) = release_write.as_ref() {
                let _ = write_all_file_descriptor(descriptor.as_raw_fd(), &[PRE_EXEC_CANCEL_TOKEN]);
            }
        }
        self.completed = true;
    }
}

/// Child-side capability consumed by
/// [`run_unix_bound_command_with_pre_exec_barrier`].
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
pub struct UnixPreExecBarrier {
    parent: Arc<UnixPreExecBarrierParentEndpoints>,
    ready_write: OwnedFd,
    release_read: OwnedFd,
}

/// Creates a one-shot, CLOEXEC Unix pipe barrier for real-provider
/// conformance tests.
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
pub fn unix_pre_exec_barrier()
-> Result<(UnixPreExecBarrierController, UnixPreExecBarrier), UnixPreExecBarrierControllerFailure> {
    let (ready_read, ready_write) = cloexec_pipe()?;
    let (release_read, release_write) = cloexec_pipe()?;
    let release_read_guard = duplicate_cloexec(release_read.as_raw_fd())?;
    let barrier_file_descriptors = [
        ready_read.as_raw_fd(),
        ready_write.as_raw_fd(),
        release_read.as_raw_fd(),
        release_read_guard.as_raw_fd(),
        release_write.as_raw_fd(),
    ];
    let parent = Arc::new(UnixPreExecBarrierParentEndpoints {
        ready_read,
        release_read_guard,
        release_write: Mutex::new(Some(release_write)),
    });
    Ok((
        UnixPreExecBarrierController {
            parent: Arc::clone(&parent),
            barrier_file_descriptors,
            ready_observed: false,
            completed: false,
        },
        UnixPreExecBarrier {
            parent,
            ready_write,
            release_read,
        },
    ))
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
fn cloexec_pipe() -> Result<(OwnedFd, OwnedFd), UnixPreExecBarrierControllerFailure> {
    let mut descriptors = [-1; 2];
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } == -1 {
        return Err(UnixPreExecBarrierControllerFailure::Create);
    }
    // SAFETY: a successful pipe call initializes both descriptors and
    // transfers ownership to this function.
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: see above; the two pipe descriptors are distinct.
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    Ok((
        duplicate_cloexec(read.as_raw_fd())?,
        duplicate_cloexec(write.as_raw_fd())?,
    ))
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
fn duplicate_cloexec(
    descriptor: libc::c_int,
) -> Result<OwnedFd, UnixPreExecBarrierControllerFailure> {
    let duplicate = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 3) };
    if duplicate == -1 {
        return Err(UnixPreExecBarrierControllerFailure::Create);
    }
    // SAFETY: F_DUPFD_CLOEXEC returned a new descriptor owned by this caller.
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
fn read_exact_file_descriptor(descriptor: libc::c_int, bytes: &mut [u8]) -> Result<(), ()> {
    let mut offset = 0;
    while offset < bytes.len() {
        let count = unsafe {
            libc::read(
                descriptor,
                bytes[offset..].as_mut_ptr().cast(),
                bytes.len() - offset,
            )
        };
        if count == 0 {
            return Err(());
        }
        if count == -1 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(());
        }
        offset += usize::try_from(count).map_err(|_| ())?;
    }
    Ok(())
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
fn wait_until_file_descriptor_readable(
    descriptor: libc::c_int,
    timeout: Duration,
) -> Result<(), UnixPreExecBarrierControllerFailure> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(UnixPreExecBarrierControllerFailure::InvalidState)?;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let timeout_millis = if remaining.is_zero() {
            0
        } else {
            i32::try_from(remaining.as_millis().max(1)).unwrap_or(i32::MAX)
        };
        let mut event = libc::pollfd {
            fd: descriptor,
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut event, 1, timeout_millis) };
        if result > 0 {
            if event.revents & (libc::POLLIN | libc::POLLHUP) != 0 {
                return Ok(());
            }
            return Err(UnixPreExecBarrierControllerFailure::ReadyRead);
        }
        if result == 0 {
            if Instant::now() >= deadline {
                return Err(UnixPreExecBarrierControllerFailure::ReadyTimeout);
            }
            continue;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(UnixPreExecBarrierControllerFailure::ReadyRead);
        }
    }
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
fn write_all_file_descriptor(descriptor: libc::c_int, bytes: &[u8]) -> Result<(), ()> {
    let mut offset = 0;
    while offset < bytes.len() {
        let count = unsafe {
            libc::write(
                descriptor,
                bytes[offset..].as_ptr().cast(),
                bytes.len() - offset,
            )
        };
        if count == -1 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(());
        }
        if count == 0 {
            return Err(());
        }
        offset += usize::try_from(count).map_err(|_| ())?;
    }
    Ok(())
}

/// Runs a command with a deadline measured after platform containment is ready.
///
/// Input preparation, process creation, process-group or Job Object ownership, and capture
/// setup are launch work rather than time attributed to the child command.
pub fn run(
    command: &CommandSpec,
    timeout: Duration,
    output_limit: usize,
) -> Result<CommandOutput, CommandFailure> {
    supervisor::supervise(
        platform::spawn(command)?,
        Instant::now() + timeout,
        output_limit,
        command.output_limit_action(),
    )
}

/// Runs with the caller's async timer and the same native execution owner as `run`.
/// Dropping the future drops that owner and terminates its process tree; no worker
/// thread or detached task continues the command after cancellation. Launch and
/// cleanup remain synchronous platform operations, outside the child deadline.
pub async fn run_async<S, F>(
    command: &CommandSpec,
    timeout: Duration,
    output_limit: usize,
    sleep: S,
) -> Result<CommandOutput, CommandFailure>
where
    S: FnMut(Duration) -> F,
    F: std::future::Future<Output = ()>,
{
    supervisor::supervise_async(
        platform::spawn(command)?,
        Instant::now() + timeout,
        output_limit,
        command.output_limit_action(),
        sleep,
    )
    .await
}

/// Runs a Unix command against exact directory capabilities.
///
/// Immediately before provider `exec`, the child reopens every canonical path
/// without following its final component and compares it to the retained
/// directory snapshot. A mismatch aborts before provider code runs. The
/// anchors remain inherited by the intended child only, preserving both their
/// directory capabilities and any open-file-description locks. When requested,
/// the child changes directory with `fchdir` rather than reopening a pathname.
#[cfg(unix)]
pub fn run_unix_bound_command(
    command: &CommandSpec,
    directory_anchors: &[UnixDirectoryAnchor<'_>],
    current_directory_anchor: Option<usize>,
    timeout: Duration,
    output_limit: usize,
) -> Result<CommandOutput, UnixBoundCommandFailure> {
    platform::run_unix_bound_command(
        command,
        directory_anchors,
        current_directory_anchor,
        timeout,
        output_limit,
    )
}

/// Runs an anchored Unix command with the caller's async timer. It shares
/// launch, descriptor inheritance, supervision and cancellation with the
/// synchronous bound runner; no detached execution task is introduced.
#[cfg(unix)]
pub async fn run_unix_bound_command_async<S, F>(
    command: &CommandSpec,
    directory_anchors: &[UnixDirectoryAnchor<'_>],
    current_directory_anchor: Option<usize>,
    timeout: Duration,
    output_limit: usize,
    sleep: S,
) -> Result<CommandOutput, UnixBoundCommandFailure>
where
    S: FnMut(Duration) -> F,
    F: std::future::Future<Output = ()>,
{
    supervisor::supervise_async(
        platform::spawn_bound(command, directory_anchors, current_directory_anchor)?,
        Instant::now() + timeout,
        output_limit,
        command.output_limit_action(),
        sleep,
    )
    .await
    .map_err(UnixBoundCommandFailure::Command)
}

/// Runs a Unix bound command with a one-shot provider-conformance barrier.
///
/// This API is intentionally unavailable in default builds. The child reports
/// readiness only after exact anchor validation, child-only CLOEXEC clearing,
/// and any requested `fchdir`, then waits immediately before provider `exec`.
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
pub fn run_unix_bound_command_with_pre_exec_barrier(
    command: &CommandSpec,
    directory_anchors: &[UnixDirectoryAnchor<'_>],
    current_directory_anchor: Option<usize>,
    barrier: UnixPreExecBarrier,
    timeout: Duration,
    output_limit: usize,
) -> Result<CommandOutput, UnixBoundCommandFailure> {
    platform::run_unix_bound_command_with_pre_exec_barrier(
        command,
        directory_anchors,
        current_directory_anchor,
        barrier,
        timeout,
        output_limit,
    )
}
