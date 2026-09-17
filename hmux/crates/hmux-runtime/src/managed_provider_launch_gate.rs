use fs2::FileExt;
use hmux_client::{
    LocalProcessGenerationStatus, ProcessDescriptor, probe_local_process_generation,
};
use portable_pty::{Child, CommandBuilder};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub(crate) const SUBCOMMAND: &str = "internal-managed-provider-launch-gate";

const POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(debug_assertions)]
const RELEASE_OBSERVED_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_PROVIDER_GATE_RELEASE_OBSERVED_MARKER";
#[cfg(debug_assertions)]
const RELEASE_CONTINUE_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_PROVIDER_GATE_RELEASE_CONTINUE_MARKER";

/// A one-shot effect barrier owned by one managed Host launch. The wrapper is
/// already the provider's POSIX session leader, but it cannot exec the caller's
/// program until `release_after_checkpoint` creates its private marker.
pub(crate) struct ManagedProviderLaunchGate {
    status_path: PathBuf,
    release_path: PathBuf,
    status: Option<File>,
}

impl ManagedProviderLaunchGate {
    pub(crate) fn prepare(runtime_directory: &Path) -> Self {
        let nonce = Uuid::new_v4().simple().to_string();
        let status_path = runtime_directory.join(format!("provider-gate-{nonce}.status"));
        let release_path = runtime_directory.join(format!("provider-gate-{nonce}.release"));
        Self {
            status_path,
            release_path,
            status: None,
        }
    }

    pub(crate) fn command(
        &self,
        host_process: &ProcessDescriptor,
        provider_program: &Path,
        provider_args: &[String],
    ) -> io::Result<CommandBuilder> {
        let mut command = CommandBuilder::new(std::env::current_exe()?);
        command.arg(SUBCOMMAND);
        command.arg(host_process.process_id.to_string());
        command.arg(&host_process.start_marker);
        command.arg(&self.status_path);
        command.arg(&self.release_path);
        command.arg(provider_program);
        command.args(provider_args);
        Ok(command)
    }

    pub(crate) fn wait_until_armed(
        &mut self,
        child: &mut (dyn Child + Send + Sync),
        timeout: Duration,
    ) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.status.is_none() {
                match OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&self.status_path)
                {
                    Ok(status) => self.status = Some(status),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
            if let Some(status) = self.status.as_ref() {
                match status.try_lock_exclusive() {
                    Ok(()) => {
                        FileExt::unlock(status)?;
                    }
                    Err(error) if lock_is_contended(&error) => return Ok(()),
                    Err(error) => return Err(error),
                }
            }
            if let Some(status) = child.try_wait()? {
                return Err(io::Error::other(format!(
                    "managed provider launch gate exited before arming: {status:?}"
                )));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "managed provider launch gate did not arm before the deadline",
                ));
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    pub(crate) fn release_after_checkpoint(
        &mut self,
        timeout: Duration,
    ) -> io::Result<()> {
        let mut release = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&self.release_path)?;
        release.write_all(b"release")?;
        release.sync_all()?;

        let status = self.status.as_mut().ok_or_else(|| {
            io::Error::other("managed provider launch gate was released before arming")
        })?;
        let deadline = Instant::now() + timeout;
        loop {
            match status.try_lock_exclusive() {
                Ok(()) => break,
                Err(error) if lock_is_contended(&error) => {}
                Err(error) => return Err(error),
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "managed provider did not cross its exec boundary before the deadline",
                ));
            }
            thread::sleep(POLL_INTERVAL);
        }
        status.seek(SeekFrom::Start(0))?;
        let mut failure = String::new();
        status.read_to_string(&mut failure)?;
        if !failure.is_empty() {
            return Err(io::Error::other(failure));
        }
        // The wrapper owns this lock until its exec attempt. An empty payload
        // after the lock transfers proves exec succeeded. From this boundary
        // onward, even an immediate exit is ordinary provider lifecycle state
        // for the Host to publish as Ready -> Exited, not a launch-gate error.
        Ok(())
    }
}

impl Drop for ManagedProviderLaunchGate {
    fn drop(&mut self) {
        if let Some(status) = self.status.as_ref() {
            let _ = FileExt::unlock(status);
        }
        for path in [&self.release_path, &self.status_path] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => {}
            }
        }
    }
}

pub(crate) fn run(arguments: &[String]) -> io::Result<()> {
    let [host_process_id, host_start_marker, status_path, release_path, provider_program, provider_args @ ..] =
        arguments
    else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed provider launch gate arguments are incomplete",
        ));
    };
    let host_process = ProcessDescriptor {
        process_id: host_process_id.parse().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "managed provider launch gate Host PID is invalid",
            )
        })?,
        start_marker: host_start_marker.clone(),
    };
    let status_path = Path::new(status_path);
    let release_path = Path::new(release_path);
    if !status_path.is_absolute()
        || !release_path.is_absolute()
        || Path::new(provider_program).as_os_str().is_empty()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed provider launch gate paths are invalid",
        ));
    }
    let artifacts = ProviderGateArtifacts {
        status_path,
        release_path,
    };
    // The gate is the PTY session leader. Keep the terminal's ordinary SIGHUP
    // containment active across the complete release-to-exec boundary: an
    // exact Host-generation poll cannot close the race after the durable
    // release marker exists, while the PTY master closing kills either this
    // wrapper or the provider image reached by exec.
    default_sighup()?;
    let mut status = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(artifacts.status_path)?;
    status.lock_exclusive()?;

    loop {
        match fs::symlink_metadata(artifacts.release_path) {
            Ok(metadata) if metadata.file_type().is_file() => break,
            Ok(_) => {
                return Err(io::Error::other(
                    "managed provider release marker is not a regular file",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        match probe_local_process_generation(&host_process) {
            Ok(LocalProcessGenerationStatus::Live) => {}
            Ok(LocalProcessGenerationStatus::Absent) => return Ok(()),
            Err(error) => {
                return Err(io::Error::other(format!(
                    "managed provider launch gate cannot observe its Host: {error}"
                )));
            }
        }
        thread::sleep(POLL_INTERVAL);
    }

    pause_after_release_observed_for_test()?;
    artifacts.remove();
    let error = Command::new(provider_program).args(provider_args).exec();
    status.set_len(0)?;
    status.seek(SeekFrom::Start(0))?;
    write!(status, "managed provider exec failed: {error}")?;
    status.sync_all()?;
    Err(error)
}

fn default_sighup() -> io::Result<()> {
    // SAFETY: `signal` receives a valid signal number and the predefined
    // default disposition before this single-threaded wrapper starts provider
    // code. The default remains active across exec as the PTY lifetime fence.
    if unsafe { libc::signal(libc::SIGHUP, libc::SIG_DFL) } == libc::SIG_ERR {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(debug_assertions)]
fn pause_after_release_observed_for_test() -> io::Result<()> {
    let (Some(observed), Some(continue_marker)) = (
        std::env::var_os(RELEASE_OBSERVED_MARKER_ENV),
        std::env::var_os(RELEASE_CONTINUE_MARKER_ENV),
    ) else {
        return Ok(());
    };
    let mut marker = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(observed)?;
    marker.write_all(b"release-observed")?;
    marker.sync_all()?;
    while !Path::new(&continue_marker).try_exists()? {
        thread::sleep(POLL_INTERVAL);
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn pause_after_release_observed_for_test() -> io::Result<()> {
    Ok(())
}

struct ProviderGateArtifacts<'a> {
    status_path: &'a Path,
    release_path: &'a Path,
}

impl ProviderGateArtifacts<'_> {
    fn remove(&self) {
        for path in [self.release_path, self.status_path] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => {}
            }
        }
    }
}

impl Drop for ProviderGateArtifacts<'_> {
    fn drop(&mut self) {
        self.remove();
    }
}

fn lock_is_contended(error: &io::Error) -> bool {
    let expected = fs2::lock_contended_error();
    match (error.raw_os_error(), expected.raw_os_error()) {
        (Some(actual), Some(expected)) => actual == expected,
        _ => error.kind() == expected.kind(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_exec_status_completes_without_a_provider_liveness_guard() {
        let runtime = tempfile::tempdir().unwrap();
        let mut gate = ManagedProviderLaunchGate::prepare(runtime.path());
        let status = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&gate.status_path)
            .unwrap();
        gate.status = Some(status);

        gate.release_after_checkpoint(Duration::from_millis(50))
            .expect("an empty status proves exec succeeded without a second liveness authority");
    }
}
