#[cfg(feature = "provider-conformance-test-support")]
use crate::UnixPreExecBarrier;
use crate::supervisor::{OutputStream, ReadState, SupervisedProcess, supervise};
use crate::{
    CommandFailure, CommandOutput, CommandSpec, UnixBoundCommandFailure, UnixDirectoryAnchor,
};
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

#[cfg(feature = "provider-conformance-test-support")]
type OptionalUnixPreExecBarrier = Option<UnixPreExecBarrier>;
#[cfg(not(feature = "provider-conformance-test-support"))]
type OptionalUnixPreExecBarrier = Option<()>;

pub(crate) fn spawn(
    specification: &CommandSpec,
) -> Result<impl SupervisedProcess + Send, CommandFailure> {
    match spawn_unix_bound_command(specification, &[], None, None) {
        Ok(output) => Ok(output),
        Err(UnixBoundCommandFailure::Command(failure)) => Err(failure),
        Err(
            UnixBoundCommandFailure::DirectoryAnchorUnavailable
            | UnixBoundCommandFailure::DirectoryAnchorChanged,
        ) => Err(CommandFailure::Spawn),
        Err(
            UnixBoundCommandFailure::PreExecBarrierUnavailable
            | UnixBoundCommandFailure::PreExecBarrierCancelled,
        ) => Err(CommandFailure::Spawn),
    }
}

pub(crate) fn spawn_bound(
    specification: &CommandSpec,
    directory_anchors: &[UnixDirectoryAnchor<'_>],
    current_directory_anchor: Option<usize>,
) -> Result<impl SupervisedProcess + Send, UnixBoundCommandFailure> {
    spawn_unix_bound_command(
        specification,
        directory_anchors,
        current_directory_anchor,
        None,
    )
}

pub(crate) fn run_unix_bound_command(
    specification: &CommandSpec,
    directory_anchors: &[UnixDirectoryAnchor<'_>],
    current_directory_anchor: Option<usize>,
    timeout: Duration,
    output_limit: usize,
) -> Result<CommandOutput, UnixBoundCommandFailure> {
    run_unix_bound_command_inner(
        specification,
        directory_anchors,
        current_directory_anchor,
        None,
        timeout,
        output_limit,
    )
}

#[cfg(feature = "provider-conformance-test-support")]
pub(crate) fn run_unix_bound_command_with_pre_exec_barrier(
    specification: &CommandSpec,
    directory_anchors: &[UnixDirectoryAnchor<'_>],
    current_directory_anchor: Option<usize>,
    barrier: UnixPreExecBarrier,
    timeout: Duration,
    output_limit: usize,
) -> Result<CommandOutput, UnixBoundCommandFailure> {
    run_unix_bound_command_inner(
        specification,
        directory_anchors,
        current_directory_anchor,
        Some(barrier),
        timeout,
        output_limit,
    )
}

fn run_unix_bound_command_inner(
    specification: &CommandSpec,
    directory_anchors: &[UnixDirectoryAnchor<'_>],
    current_directory_anchor: Option<usize>,
    barrier: OptionalUnixPreExecBarrier,
    timeout: Duration,
    output_limit: usize,
) -> Result<CommandOutput, UnixBoundCommandFailure> {
    let process = spawn_unix_bound_command(
        specification,
        directory_anchors,
        current_directory_anchor,
        barrier,
    )?;
    supervise(
        process,
        Instant::now() + timeout,
        output_limit,
        specification.output_limit_action(),
    )
    .map_err(UnixBoundCommandFailure::Command)
}

fn spawn_unix_bound_command(
    specification: &CommandSpec,
    directory_anchors: &[UnixDirectoryAnchor<'_>],
    current_directory_anchor: Option<usize>,
    #[cfg_attr(
        not(feature = "provider-conformance-test-support"),
        allow(unused_variables)
    )]
    barrier: OptionalUnixPreExecBarrier,
) -> Result<OwnedUnixProcess, UnixBoundCommandFailure> {
    if current_directory_anchor.is_some() && specification.current_directory().is_some() {
        return Err(UnixBoundCommandFailure::DirectoryAnchorUnavailable);
    }
    if current_directory_anchor.is_some_and(|index| index >= directory_anchors.len()) {
        return Err(UnixBoundCommandFailure::DirectoryAnchorUnavailable);
    }
    let mut command = Command::new(specification.program());
    let input = crate::input::prepare(specification).map_err(UnixBoundCommandFailure::Command)?;
    command
        .args(specification.arguments())
        .stdin(input.map_or_else(Stdio::null, Stdio::from))
        .stdout(Stdio::piped())
        .stderr(if specification.captures_stderr() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .process_group(0);
    if specification.clears_environment() {
        command.env_clear();
    }
    command.envs(specification.environment().iter().cloned());
    if let Some(directory) = specification.current_directory() {
        command.current_dir(directory);
    }
    let directory_anchors = directory_anchors
        .iter()
        .map(PreparedUnixDirectoryAnchor::from)
        .collect::<Vec<_>>();
    #[cfg(feature = "provider-conformance-test-support")]
    let prepared_barrier = barrier
        .as_ref()
        .map(PreparedUnixPreExecBarrier::prepare)
        .transpose()?;
    #[cfg(not(feature = "provider-conformance-test-support"))]
    let prepared_barrier: Option<()> = None;
    let has_pre_exec_barrier = prepared_barrier.is_some();
    if !directory_anchors.is_empty() || prepared_barrier.is_some() {
        // SAFETY: the hook calls only async-signal-safe fcntl, open, fstat,
        // close, fchdir, read, write, and getpid operations. All strings are
        // pre-encoded, and the borrowed anchor plus optional barrier
        // descriptors outlive this synchronous spawn and run.
        unsafe {
            command.pre_exec(move || {
                for anchor in &directory_anchors {
                    if !anchor_matches_retained_directory(anchor) {
                        return Err(io::Error::from_raw_os_error(libc::ESTALE));
                    }
                    let flags = libc::fcntl(anchor.descriptor, libc::F_GETFD);
                    if flags == -1
                        || libc::fcntl(anchor.descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC)
                            == -1
                    {
                        return Err(io::Error::last_os_error());
                    }
                }
                if let Some(index) = current_directory_anchor {
                    if libc::fchdir(directory_anchors[index].descriptor) == -1 {
                        return Err(io::Error::last_os_error());
                    }
                }
                #[cfg(feature = "provider-conformance-test-support")]
                if let Some(barrier) = prepared_barrier {
                    wait_at_pre_exec_barrier(barrier)?;
                }
                Ok(())
            });
        }
    }
    let child = command.spawn().map_err(|error| {
        if error.raw_os_error() == Some(libc::ESTALE) {
            UnixBoundCommandFailure::DirectoryAnchorChanged
        } else if has_pre_exec_barrier
            && cfg!(feature = "provider-conformance-test-support")
            && error.raw_os_error() == Some(libc::ECANCELED)
        {
            #[cfg(feature = "provider-conformance-test-support")]
            return UnixBoundCommandFailure::PreExecBarrierCancelled;
            #[cfg(not(feature = "provider-conformance-test-support"))]
            unreachable!();
        } else if has_pre_exec_barrier
            && cfg!(feature = "provider-conformance-test-support")
            && error.raw_os_error() == Some(libc::EPROTO)
        {
            #[cfg(feature = "provider-conformance-test-support")]
            return UnixBoundCommandFailure::PreExecBarrierUnavailable;
            #[cfg(not(feature = "provider-conformance-test-support"))]
            unreachable!();
        } else {
            UnixBoundCommandFailure::Command(CommandFailure::Spawn)
        }
    })?;
    let mut process = OwnedUnixProcess::new(child);
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or(UnixBoundCommandFailure::Command(
            CommandFailure::StdoutUnavailable,
        ))?;
    process.stdout =
        Some(output_file(stdout, OutputStream::Stdout).map_err(UnixBoundCommandFailure::Command)?);
    if specification.captures_stderr() {
        let stderr = process
            .child
            .stderr
            .take()
            .ok_or(UnixBoundCommandFailure::Command(
                OutputStream::Stderr.unavailable(),
            ))?;
        process.stderr = Some(
            output_file(stderr, OutputStream::Stderr).map_err(UnixBoundCommandFailure::Command)?,
        );
    }
    Ok(process)
}

struct PreparedUnixDirectoryAnchor {
    descriptor: i32,
    canonical_path: CString,
    device: libc::dev_t,
    inode: libc::ino_t,
    owner: libc::uid_t,
    mode: libc::mode_t,
}

#[cfg(feature = "provider-conformance-test-support")]
#[derive(Clone, Copy)]
struct PreparedUnixPreExecBarrier {
    parent_ready_read: libc::c_int,
    parent_release_read_guard: libc::c_int,
    parent_release_write: libc::c_int,
    child_ready_write: libc::c_int,
    child_release_read: libc::c_int,
}

#[cfg(feature = "provider-conformance-test-support")]
impl PreparedUnixPreExecBarrier {
    fn prepare(barrier: &UnixPreExecBarrier) -> Result<Self, UnixBoundCommandFailure> {
        let release_write = barrier
            .parent
            .release_write
            .lock()
            .map_err(|_| UnixBoundCommandFailure::PreExecBarrierUnavailable)?;
        let parent_release_write = release_write
            .as_ref()
            .ok_or(UnixBoundCommandFailure::PreExecBarrierUnavailable)?
            .as_raw_fd();
        Ok(Self {
            parent_ready_read: barrier.parent.ready_read.as_raw_fd(),
            parent_release_read_guard: barrier.parent.release_read_guard.as_raw_fd(),
            parent_release_write,
            child_ready_write: barrier.ready_write.as_raw_fd(),
            child_release_read: barrier.release_read.as_raw_fd(),
        })
    }
}

#[cfg(feature = "provider-conformance-test-support")]
fn wait_at_pre_exec_barrier(barrier: PreparedUnixPreExecBarrier) -> io::Result<()> {
    let _ = unsafe { libc::close(barrier.parent_ready_read) };
    let _ = unsafe { libc::close(barrier.parent_release_read_guard) };
    let _ = unsafe { libc::close(barrier.parent_release_write) };

    let process_id = unsafe { libc::getpid() };
    let mut ready = [0_u8; 1 + std::mem::size_of::<libc::pid_t>()];
    ready[0] = crate::PRE_EXEC_READY_TOKEN;
    ready[1..].copy_from_slice(&process_id.to_ne_bytes());
    if !pre_exec_write_all(barrier.child_ready_write, &ready) {
        let _ = unsafe { libc::close(barrier.child_ready_write) };
        let _ = unsafe { libc::close(barrier.child_release_read) };
        return Err(io::Error::from_raw_os_error(libc::EPROTO));
    }
    let _ = unsafe { libc::close(barrier.child_ready_write) };

    let mut release = [0_u8; 1];
    let released = pre_exec_read_exact(barrier.child_release_read, &mut release);
    let _ = unsafe { libc::close(barrier.child_release_read) };
    if released && release[0] == crate::PRE_EXEC_RELEASE_TOKEN {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(libc::ECANCELED))
    }
}

#[cfg(feature = "provider-conformance-test-support")]
fn pre_exec_write_all(descriptor: libc::c_int, bytes: &[u8]) -> bool {
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
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return false;
        }
        if count == 0 {
            return false;
        }
        let Ok(count) = usize::try_from(count) else {
            return false;
        };
        offset += count;
    }
    true
}

#[cfg(feature = "provider-conformance-test-support")]
fn pre_exec_read_exact(descriptor: libc::c_int, bytes: &mut [u8]) -> bool {
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
            return false;
        }
        if count == -1 {
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return false;
        }
        let Ok(count) = usize::try_from(count) else {
            return false;
        };
        offset += count;
    }
    true
}

impl From<&UnixDirectoryAnchor<'_>> for PreparedUnixDirectoryAnchor {
    fn from(anchor: &UnixDirectoryAnchor<'_>) -> Self {
        Self {
            descriptor: anchor.directory.as_raw_fd(),
            canonical_path: anchor.canonical_path.clone(),
            device: anchor.device,
            inode: anchor.inode,
            owner: anchor.owner,
            mode: anchor.mode,
        }
    }
}

fn anchor_matches_retained_directory(anchor: &PreparedUnixDirectoryAnchor) -> bool {
    let reopened = unsafe {
        libc::open(
            anchor.canonical_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if reopened == -1 {
        return false;
    }
    let mut retained = std::mem::MaybeUninit::<libc::stat>::uninit();
    let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
    let observed = unsafe {
        libc::fstat(anchor.descriptor, retained.as_mut_ptr()) == 0
            && libc::fstat(reopened, current.as_mut_ptr()) == 0
    };
    let _ = unsafe { libc::close(reopened) };
    if !observed {
        return false;
    }
    let retained = unsafe { retained.assume_init() };
    let current = unsafe { current.assume_init() };
    retained.st_dev == anchor.device
        && retained.st_ino == anchor.inode
        && retained.st_uid == anchor.owner
        && retained.st_mode == anchor.mode
        && current.st_dev == anchor.device
        && current.st_ino == anchor.inode
        && current.st_uid == anchor.owner
        && current.st_mode == anchor.mode
}

fn output_file(pipe: impl Into<OwnedFd>, stream: OutputStream) -> Result<File, CommandFailure> {
    let file = File::from(pipe.into());
    let file_descriptor = file.as_raw_fd();
    let flags = unsafe { libc::fcntl(file_descriptor, libc::F_GETFL) };
    if flags == -1
        || unsafe { libc::fcntl(file_descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
    {
        return Err(stream.configure());
    }
    Ok(file)
}

struct OwnedUnixProcess {
    child: Child,
    stdout: Option<File>,
    stderr: Option<File>,
    process_group: u32,
    reaped: bool,
}

impl OwnedUnixProcess {
    fn new(child: Child) -> Self {
        Self {
            process_group: child.id(),
            child,
            stdout: None,
            stderr: None,
            reaped: false,
        }
    }

    fn terminate(&mut self) -> Result<(), CommandFailure> {
        if self.reaped {
            return Ok(());
        }
        let cleanup = signal_owned_group(self.process_group).map_err(|_| CommandFailure::Cleanup);
        let _ = self.child.kill();
        let reaped = self.child.wait().map_err(|_| CommandFailure::ProcessWait);
        if reaped.is_ok() {
            self.reaped = true;
        }
        cleanup?;
        reaped.map(|_| ())
    }
}

impl SupervisedProcess for OwnedUnixProcess {
    fn terminate(&mut self) -> Result<(), CommandFailure> {
        OwnedUnixProcess::terminate(self)
    }

    fn wait_for_output(&mut self, duration: Duration) -> Result<(), CommandFailure> {
        // Small pipe buffers can make a fixed sleep per refill dominate an SDK
        // command's deadline (notably adb PNG captures on macOS). Wake as soon
        // as either pipe can be drained, but still poll the leader's exit when
        // it is silent. Closed streams use poll's ignored negative descriptor.
        let mut pipes = [&self.stdout, &self.stderr].map(|pipe| libc::pollfd {
            fd: pipe.as_ref().map_or(-1, AsRawFd::as_raw_fd),
            events: libc::POLLIN,
            revents: 0,
        });
        let timeout = duration.as_millis().min(i32::MAX as u128) as i32;
        // SAFETY: the owned files outlive this call and `pipes` has exactly the
        // number of initialized pollfd entries passed to poll.
        let result =
            unsafe { libc::poll(pipes.as_mut_ptr(), pipes.len() as libc::nfds_t, timeout) };
        if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(CommandFailure::ProcessWait);
        }
        // On interruption, recheck output and the deadline before waiting again.
        Ok(())
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
        let retained_limit = output_limit.saturating_add(1);
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => return Ok(ReadState::Complete),
                Ok(length) => {
                    let retained = retained_limit.saturating_sub(captured.len()).min(length);
                    captured.extend_from_slice(&buffer[..retained]);
                    if captured.len() > output_limit {
                        return Ok(ReadState::Exceeded);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    return Ok(ReadState::Pending);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
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
        loop {
            let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.process_group as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 {
                return Ok(unsafe { info.si_pid() } != 0);
            }
            if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(CommandFailure::ProcessWait);
            }
        }
    }

    fn finish(&mut self) -> Result<ExitStatus, CommandFailure> {
        signal_owned_group(self.process_group).map_err(|_| CommandFailure::Cleanup)?;
        let status = self.child.wait().map_err(|_| CommandFailure::ProcessWait)?;
        self.reaped = true;
        Ok(status)
    }
}

impl Drop for OwnedUnixProcess {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

fn signal_owned_group(process_group: u32) -> io::Result<()> {
    if let Ok(process_group) = i32::try_from(process_group) {
        // The unreaped leader keeps this owned process-group identity from being reused.
        let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        // Darwin reports EPERM when this owned group contains only its unreaped zombie leader.
        let no_signalable_members = error.raw_os_error() == Some(libc::ESRCH)
            || (cfg!(target_os = "macos") && error.raw_os_error() == Some(libc::EPERM));
        if !no_signalable_members {
            return Err(error);
        }
    }
    Ok(())
}
