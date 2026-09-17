//! Provider child-process launch identity, ownership proof, and termination.

use crate::process_session::{OwnedProcessSession, SessionTermination};
use crate::{Result, runtime_log, unix_time_ms};
use hmux_client::exact_local_process_generation;
use hmux_host::local_protocol::ProcessProof;
use hmux_host::provider_epoch::{ProviderExitKind, ProviderExitStatus};
use portable_pty::{ExitStatus, MasterPty};
use std::env;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

const DIRECT_CHILD_KILL_RETRY_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) struct ProviderCompletion {
    pub(crate) status: ExitStatus,
    pub(crate) terminated: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderTermination {
    DiscoveryRootRetired,
    IdleRetirement,
    ManagedClientRequest,
    StandaloneClientRequest,
}

pub(crate) struct ProviderProcessControl<'a> {
    termination_transition: &'a Mutex<()>,
    provider_exit_observed: &'a AtomicBool,
    pty_master: &'a Mutex<Box<dyn MasterPty + Send>>,
}

impl<'a> ProviderProcessControl<'a> {
    pub(crate) fn new(
        termination_transition: &'a Mutex<()>,
        provider_exit_observed: &'a AtomicBool,
        pty_master: &'a Mutex<Box<dyn MasterPty + Send>>,
    ) -> Self {
        Self {
            termination_transition,
            provider_exit_observed,
            pty_master,
        }
    }
}

pub(crate) fn wait_for_provider(
    child: &mut Box<dyn portable_pty::Child + Send + Sync>,
    termination: &mpsc::Receiver<ProviderTermination>,
    owned_process_session: OwnedProcessSession,
    control: ProviderProcessControl<'_>,
) -> Result<ProviderCompletion> {
    let process_id = owned_process_session.process_id();
    let mut termination_request = None;
    let mut direct_child_exit_observed = false;
    let mut cleanup_complete = false;
    let mut next_cleanup_attempt = None;
    loop {
        {
            let _transition = control
                .termination_transition
                .lock()
                .map_err(|_| "hmux runtime lock was poisoned")?;
            if termination_request.is_none() && !direct_child_exit_observed {
                termination_request = termination.try_recv().ok();
            }
            if !direct_child_exit_observed {
                direct_child_exit_observed = observe_direct_child_exit(process_id)?;
            }

            let cleanup_required = termination_request.is_some() || direct_child_exit_observed;
            let cleanup_due = cleanup_required
                && !cleanup_complete
                && next_cleanup_attempt.is_none_or(|deadline| Instant::now() >= deadline);
            if cleanup_due {
                match drain_owned_provider_session(&owned_process_session, &control) {
                    Ok(cleanup) if cleanup.complete && cleanup.failed_stages.is_empty() => {
                        cleanup_complete = true;
                    }
                    Ok(cleanup) => {
                        let stages = cleanup
                            .failed_stages
                            .iter()
                            .map(|stage| stage.stable_name())
                            .collect::<Vec<_>>()
                            .join(",");
                        runtime_log(&format!(
                            "provider process-session cleanup incomplete; retaining direct-child generation: {stages}"
                        ));
                        next_cleanup_attempt =
                            Some(Instant::now() + DIRECT_CHILD_KILL_RETRY_INTERVAL);
                    }
                    Err(error) => {
                        runtime_log(&format!(
                            "provider process-session cleanup unproven; retaining direct-child generation: {error}"
                        ));
                        next_cleanup_attempt =
                            Some(Instant::now() + DIRECT_CHILD_KILL_RETRY_INTERVAL);
                    }
                }
            }

            if cleanup_complete && direct_child_exit_observed {
                // This is the only provider-child reap. The WNOWAIT witness
                // above pins both the numeric PID and its POSIX session until
                // every descendant has been proven absent.
                let status = child.wait()?;
                control
                    .provider_exit_observed
                    .store(true, Ordering::Release);
                return Ok(ProviderCompletion {
                    status,
                    terminated: termination_request.is_some(),
                });
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// Observe one direct-child exit without reaping it. The unreaped generation
/// is the authority that lets descendant cleanup stay bound to the original
/// provider session instead of a reusable numeric PID.
fn observe_direct_child_exit(process_id: u32) -> io::Result<bool> {
    let process_id = libc::id_t::try_from(process_id)
        .map_err(|_| io::Error::other("provider process id is out of range"))?;
    loop {
        // SAFETY: waitid writes one siginfo_t for this Host-owned direct child.
        // WNOWAIT deliberately retains the waitable generation for the
        // process-session cleanup that runs before portable-pty reaps it.
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                process_id,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            // SAFETY: a successful waitid initialized siginfo_t. A zero PID is
            // the specified WNOHANG result when the child has not exited.
            return Ok(unsafe { info.si_pid() } != 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn drain_owned_provider_session(
    session: &OwnedProcessSession,
    control: &ProviderProcessControl<'_>,
) -> io::Result<SessionTermination> {
    let master = control
        .pty_master
        .lock()
        .map_err(|_| io::Error::other("provider PTY lock was poisoned"))?;
    pause_provider_cleanup_while_holding_pty_master_for_test()?;
    let foreground_process_group = master.process_group_leader();
    drop(master);
    session.terminate(foreground_process_group)
}

#[cfg(debug_assertions)]
fn pause_provider_cleanup_while_holding_pty_master_for_test() -> io::Result<()> {
    let Some(marker) = env::var_os("HMUX_RUNTIME_TEST_MANAGED_STOP_CLEANUP_MARKER") else {
        return Ok(());
    };
    let marker = PathBuf::from(marker);
    let release = marker.with_extension("release");
    std::fs::write(&marker, b"pty_master_locked")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while !release.exists() {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "managed-stop cleanup pause timed out",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn pause_provider_cleanup_while_holding_pty_master_for_test() -> io::Result<()> {
    Ok(())
}

pub(crate) fn resolve_command(command: &[String]) -> (PathBuf, Vec<String>) {
    if let Some((program, arguments)) = command.split_first() {
        return (PathBuf::from(program), arguments.to_vec());
    }
    (
        env::var_os("SHELL")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/bin/sh")),
        Vec::new(),
    )
}

/// Resolve the executable that owns the long-lived provider PID after a
/// transparent `/usr/bin/env NAME=VALUE ...` launcher has exec'd it.
///
/// Unknown `env` options deliberately keep `env` as the baseline and therefore
/// preserve on an observed mismatch. Guessing through `-S` or an option with an
/// operand could otherwise classify an arbitrary exec'd program as an idle
/// shell.
pub(crate) fn expected_provider_identity_program(program: &Path, arguments: &[String]) -> PathBuf {
    if program.file_name() != Some(OsStr::new("env")) {
        return program.to_path_buf();
    }
    let mut options_ended = false;
    for argument in arguments {
        if !options_ended && argument == "--" {
            options_ended = true;
            continue;
        }
        if !options_ended && environment_assignment(argument) {
            continue;
        }
        if !options_ended && argument.starts_with('-') {
            return program.to_path_buf();
        }
        return PathBuf::from(argument);
    }
    program.to_path_buf()
}

fn environment_assignment(argument: &str) -> bool {
    let Some((name, _)) = argument.split_once('=') else {
        return false;
    };
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

pub(crate) fn process_proof(process_id: u32) -> Result<ProcessProof> {
    let generation = exact_local_process_generation(process_id)?;
    Ok(ProcessProof {
        process_id: generation.process_id,
        start_marker: generation.start_marker,
    })
}

pub(crate) fn cleanup_unproven_provider_child(
    child: &mut dyn portable_pty::Child,
    process_id: Option<u32>,
) {
    if let Some(process_id) = process_id {
        // The direct-child handle has not been waited yet, so its PID cannot
        // be recycled while the owned POSIX session is frozen and terminated.
        // Do this before any portable-pty kill: its implementation may reap
        // the child while killing it, after which neither a numeric PID nor
        // its session is a safe ownership witness.
        match OwnedProcessSession::new(process_id).and_then(|session| session.terminate(None)) {
            Ok(termination) if !termination.complete => {
                runtime_log(
                    "unproven provider process-session cleanup could not prove containment",
                );
            }
            Err(error) => {
                runtime_log(&format!(
                    "unproven provider process-session cleanup degraded: {error}"
                ));
            }
            Ok(_) => {}
        }
        if let Ok(process_id) = libc::pid_t::try_from(process_id) {
            // SAFETY: no operation above reaps the direct child. Its Child
            // handle therefore still pins this positive PID generation.
            unsafe {
                libc::kill(process_id, libc::SIGKILL);
            }
        }
    } else {
        // Native Unix PTYs expose the direct-child PID. This handle-only
        // fallback remains for implementations that cannot provide one.
        let _ = child.kill();
    }
    let _ = child.wait();
}

pub(crate) fn provider_exit_status(
    status: &portable_pty::ExitStatus,
    terminated: bool,
    output_drained: bool,
) -> ProviderExitStatus {
    let exit_code = i32::try_from(status.exit_code()).ok();
    let mut reason = if terminated {
        "provider terminated by Hmux Host".to_string()
    } else if status.success() {
        "provider exited normally".to_string()
    } else {
        format!("provider exited with status {}", status.exit_code())
    };
    if !output_drained {
        reason.push_str("; terminal output drain timed out");
    }
    ProviderExitStatus {
        exit_code,
        platform_status: None,
        kind: if terminated {
            ProviderExitKind::Signaled
        } else if status.success() && output_drained {
            ProviderExitKind::Normal
        } else {
            ProviderExitKind::ProviderError
        },
        reason,
        created_unix_ms: unix_time_ms(),
        failure: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use std::fs;
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;

    #[derive(Debug)]
    struct ReapingKillChild {
        child: std::process::Child,
        kill_calls: Arc<AtomicUsize>,
        try_wait_calls: Arc<AtomicUsize>,
        wait_calls: Arc<AtomicUsize>,
    }

    impl portable_pty::Child for ReapingKillChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            self.try_wait_calls.fetch_add(1, Ordering::Relaxed);
            self.child.try_wait().map(|status| status.map(Into::into))
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            self.wait_calls.fetch_add(1, Ordering::Relaxed);
            self.child.wait().map(Into::into)
        }

        fn process_id(&self) -> Option<u32> {
            Some(self.child.id())
        }
    }

    impl portable_pty::ChildKiller for ReapingKillChild {
        fn kill(&mut self) -> io::Result<()> {
            self.kill_calls.fetch_add(1, Ordering::Relaxed);
            let _ = self.child.kill();
            let _ = self.child.wait();
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(CountingSignalKiller {
                process_id: self.child.id(),
                kill_calls: Arc::clone(&self.kill_calls),
            })
        }
    }

    #[derive(Debug)]
    struct CountingSignalKiller {
        process_id: u32,
        kill_calls: Arc<AtomicUsize>,
    }

    impl portable_pty::ChildKiller for CountingSignalKiller {
        fn kill(&mut self) -> io::Result<()> {
            self.kill_calls.fetch_add(1, Ordering::Relaxed);
            let process_id = libc::pid_t::try_from(self.process_id)
                .map_err(|_| io::Error::other("test process id is out of range"))?;
            // SAFETY: this test killer is bound to the direct child generation
            // that remains owned and unreaped by the fixture.
            if unsafe { libc::kill(process_id, libc::SIGKILL) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(Self {
                process_id: self.process_id,
                kill_calls: Arc::clone(&self.kill_calls),
            })
        }
    }

    #[test]
    fn provider_exit_status_distinguishes_termination_and_output_drain() {
        let success = ExitStatus::with_exit_code(0);

        let normal = provider_exit_status(&success, false, true);
        assert_eq!(normal.kind, ProviderExitKind::Normal);
        assert_eq!(normal.reason, "provider exited normally");

        let incomplete = provider_exit_status(&success, false, false);
        assert_eq!(incomplete.kind, ProviderExitKind::ProviderError);
        assert!(
            incomplete
                .reason
                .contains("terminal output drain timed out")
        );

        let terminated = provider_exit_status(&success, true, true);
        assert_eq!(terminated.kind, ProviderExitKind::Signaled);
        assert_eq!(terminated.reason, "provider terminated by Hmux Host");
    }

    #[test]
    fn explicit_stop_keeps_one_reaper_until_process_session_cleanup_completes() {
        let mut command = std::process::Command::new("/bin/sleep");
        command.arg("30");
        // SAFETY: setsid is async-signal-safe and runs before the disposable
        // test child executes `/bin/sleep`.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let child = command.spawn().unwrap();
        let process_id = child.id();
        let session = OwnedProcessSession::new(process_id).unwrap();
        let kill_calls = Arc::new(AtomicUsize::new(0));
        let try_wait_calls = Arc::new(AtomicUsize::new(0));
        let wait_calls = Arc::new(AtomicUsize::new(0));
        let mut child: Box<dyn portable_pty::Child + Send + Sync> = Box::new(ReapingKillChild {
            child,
            kill_calls: Arc::clone(&kill_calls),
            try_wait_calls: Arc::clone(&try_wait_calls),
            wait_calls: Arc::clone(&wait_calls),
        });
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        drop(pair.slave);
        let (termination_tx, termination_rx) = mpsc::channel();
        termination_tx
            .send(ProviderTermination::ManagedClientRequest)
            .unwrap();
        let provider_exit_observed = AtomicBool::new(false);
        let completion = wait_for_provider(
            &mut child,
            &termination_rx,
            session,
            ProviderProcessControl::new(
                &Mutex::new(()),
                &provider_exit_observed,
                &Mutex::new(pair.master),
            ),
        )
        .expect("explicit stop must publish one completion after exact cleanup");

        assert!(completion.terminated);
        assert_eq!(kill_calls.load(Ordering::Relaxed), 0);
        assert_eq!(try_wait_calls.load(Ordering::Relaxed), 0);
        assert_eq!(wait_calls.load(Ordering::Relaxed), 1);
        assert!(provider_exit_observed.load(Ordering::Acquire));
    }

    #[test]
    fn every_explicit_stop_retries_a_refused_leader_kill_before_completion() {
        for termination in [
            ProviderTermination::DiscoveryRootRetired,
            ProviderTermination::IdleRetirement,
            ProviderTermination::ManagedClientRequest,
            ProviderTermination::StandaloneClientRequest,
        ] {
            assert_refused_leader_kill_retries(termination);
        }
    }

    fn assert_refused_leader_kill_retries(termination: ProviderTermination) {
        let mut command = std::process::Command::new("/bin/sleep");
        command.arg("30");
        // SAFETY: setsid is async-signal-safe and runs before the disposable
        // test child executes `/bin/sleep`.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let direct_child = command.spawn().unwrap();
        let process_id = direct_child.id();
        let process_generation = exact_local_process_generation(process_id)
            .expect("leader-only provider generation must be observable");
        let mut session = OwnedProcessSession::new(process_id).unwrap();
        let refuse_sigkill = Arc::new(AtomicBool::new(true));
        let sigkill_attempts = Arc::new(AtomicUsize::new(0));
        session.refuse_sigkill_while(Arc::clone(&refuse_sigkill), Arc::clone(&sigkill_attempts));

        let kill_calls = Arc::new(AtomicUsize::new(0));
        let try_wait_calls = Arc::new(AtomicUsize::new(0));
        let wait_calls = Arc::new(AtomicUsize::new(0));
        let mut child: Box<dyn portable_pty::Child + Send + Sync> = Box::new(ReapingKillChild {
            child: direct_child,
            kill_calls: Arc::clone(&kill_calls),
            try_wait_calls: Arc::clone(&try_wait_calls),
            wait_calls: Arc::clone(&wait_calls),
        });
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        drop(pair.slave);
        let (termination_tx, termination_rx) = mpsc::channel();
        termination_tx.send(termination).unwrap();
        let provider_exit_observed = Arc::new(AtomicBool::new(false));
        let worker_exit_observed = Arc::clone(&provider_exit_observed);
        let (completion_tx, completion_rx) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let termination_transition = Mutex::new(());
            let pty_master = Mutex::new(pair.master);
            let result = wait_for_provider(
                &mut child,
                &termination_rx,
                session,
                ProviderProcessControl::new(
                    &termination_transition,
                    &worker_exit_observed,
                    &pty_master,
                ),
            );
            completion_tx.send(result).unwrap();
        });

        let fault_deadline = Instant::now() + Duration::from_secs(3);
        while sigkill_attempts.load(Ordering::Acquire) == 0 && Instant::now() < fault_deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let fault_was_exercised = sigkill_attempts.load(Ordering::Acquire) > 0;
        let premature_completion = completion_rx.recv_timeout(Duration::from_millis(1_200));
        let stayed_unpublished =
            matches!(&premature_completion, Err(mpsc::RecvTimeoutError::Timeout));
        let exact_leader_still_live = exact_local_process_generation(process_id)
            .is_ok_and(|current| current == process_generation);
        let exit_observed_while_refused = provider_exit_observed.load(Ordering::Acquire);
        let child_reaped_while_refused = wait_calls.load(Ordering::Acquire) > 0
            || try_wait_calls.load(Ordering::Acquire) > 0
            || kill_calls.load(Ordering::Acquire) > 0;
        let attempts_before_release = sigkill_attempts.load(Ordering::Acquire);

        // Always release the injected fault before assertions. The old bug
        // needs one exact fallback signal below so its disposable provider
        // cannot remain frozen when this behavioral RED fails.
        refuse_sigkill.store(false, Ordering::Release);
        let mut completion = match premature_completion {
            Err(mpsc::RecvTimeoutError::Timeout) => {
                completion_rx.recv_timeout(Duration::from_secs(5))
            }
            Ok(completion) => Ok(completion),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(mpsc::RecvTimeoutError::Disconnected),
        };
        let recovered_without_fallback = completion.is_ok();
        if !recovered_without_fallback {
            let process_id = libc::pid_t::try_from(process_id).unwrap();
            // SAFETY: the unreaped exact generation checked above is still
            // owned by this fixture. This signal is test cleanup only.
            assert_eq!(unsafe { libc::kill(process_id, libc::SIGKILL) }, 0);
            completion = completion_rx.recv_timeout(Duration::from_secs(5));
        }
        let completion = completion
            .expect("leader cleanup must eventually publish one completion")
            .expect("provider wait must complete after leader cleanup");
        worker.join().unwrap();

        assert!(fault_was_exercised, "{termination:?}");
        assert!(
            stayed_unpublished,
            "{termination:?} published an early Exit"
        );
        assert!(exact_leader_still_live, "{termination:?}");
        assert!(!exit_observed_while_refused, "{termination:?}");
        assert!(!child_reaped_while_refused, "{termination:?}");
        assert!(
            recovered_without_fallback,
            "{termination:?} latched cleanup complete while its leader SIGKILL was refused"
        );
        assert!(
            sigkill_attempts.load(Ordering::Acquire) > attempts_before_release,
            "{termination:?} did not retry cleanup after the refusal was released"
        );
        assert!(completion.terminated, "{termination:?}");
        assert_eq!(kill_calls.load(Ordering::Acquire), 0, "{termination:?}");
        assert_eq!(try_wait_calls.load(Ordering::Acquire), 0, "{termination:?}");
        assert_eq!(wait_calls.load(Ordering::Acquire), 1, "{termination:?}");
        assert!(
            provider_exit_observed.load(Ordering::Acquire),
            "{termination:?}"
        );
    }

    #[test]
    fn cleanup_failure_pins_child_until_descendant_absence_then_completes_once() {
        let mut command = std::process::Command::new("/bin/sh");
        command
            .args([
                "-c",
                "set -m; (trap '' HUP TERM; while :; do sleep 30; done) & \
                 child=$!; echo \"$child\"; trap '' HUP TERM; wait",
            ])
            .stdout(Stdio::piped());
        // SAFETY: setsid is async-signal-safe and runs before the disposable
        // test child executes `/bin/sh`.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut direct_child = command.spawn().unwrap();
        let mut descendant_line = String::new();
        BufReader::new(
            direct_child
                .stdout
                .take()
                .expect("provider fixture must expose its descendant"),
        )
        .read_line(&mut descendant_line)
        .unwrap();
        let descendant_pid = descendant_line.trim().parse::<u32>().unwrap();
        let descendant_generation = exact_local_process_generation(descendant_pid)
            .expect("descendant generation must be observable");
        let provider_pid = direct_child.id();
        let mut session = OwnedProcessSession::new(provider_pid).unwrap();
        let refuse_sigkill = Arc::new(AtomicBool::new(true));
        let sigkill_attempts = Arc::new(AtomicUsize::new(0));
        session.refuse_sigkill_while(Arc::clone(&refuse_sigkill), Arc::clone(&sigkill_attempts));

        let kill_calls = Arc::new(AtomicUsize::new(0));
        let try_wait_calls = Arc::new(AtomicUsize::new(0));
        let wait_calls = Arc::new(AtomicUsize::new(0));
        let mut child: Box<dyn portable_pty::Child + Send + Sync> = Box::new(ReapingKillChild {
            child: direct_child,
            kill_calls: Arc::clone(&kill_calls),
            try_wait_calls: Arc::clone(&try_wait_calls),
            wait_calls: Arc::clone(&wait_calls),
        });
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        drop(pair.slave);
        let (termination_tx, termination_rx) = mpsc::channel();
        termination_tx
            .send(ProviderTermination::ManagedClientRequest)
            .unwrap();
        let provider_exit_observed = Arc::new(AtomicBool::new(false));
        let worker_exit_observed = Arc::clone(&provider_exit_observed);
        let (completion_tx, completion_rx) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let termination_transition = Mutex::new(());
            let pty_master = Mutex::new(pair.master);
            let result = wait_for_provider(
                &mut child,
                &termination_rx,
                session,
                ProviderProcessControl::new(
                    &termination_transition,
                    &worker_exit_observed,
                    &pty_master,
                ),
            );
            completion_tx.send(result).unwrap();
        });

        let fault_deadline = Instant::now() + Duration::from_secs(3);
        while sigkill_attempts.load(Ordering::Acquire) == 0 && Instant::now() < fault_deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let fault_was_exercised = sigkill_attempts.load(Ordering::Acquire) > 0;
        let premature_completion = completion_rx.recv_timeout(Duration::from_millis(1_200));
        let stayed_unpublished =
            matches!(&premature_completion, Err(mpsc::RecvTimeoutError::Timeout));
        let exit_observed_while_incomplete = provider_exit_observed.load(Ordering::Acquire);
        let child_reaped_while_incomplete = wait_calls.load(Ordering::Acquire) > 0
            || try_wait_calls.load(Ordering::Acquire) > 0
            || kill_calls.load(Ordering::Acquire) > 0;
        let descendant_survived = exact_local_process_generation(descendant_pid)
            .is_ok_and(|current| current == descendant_generation);

        // Always release the injected failure before asserting so a failed
        // observation cannot strand the disposable provider session.
        refuse_sigkill.store(false, Ordering::Release);
        let completion = match premature_completion {
            Err(mpsc::RecvTimeoutError::Timeout) => completion_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("cleanup recovery must publish one completion"),
            Ok(completion) => completion,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("provider wait worker disconnected before cleanup recovery")
            }
        }
        .expect("cleanup recovery must finish provider wait");
        worker.join().unwrap();

        assert!(fault_was_exercised);
        assert!(stayed_unpublished, "incomplete cleanup published an Exit");
        assert!(!exit_observed_while_incomplete);
        assert!(!child_reaped_while_incomplete);
        assert!(descendant_survived);
        assert!(completion.terminated);
        assert_eq!(kill_calls.load(Ordering::Acquire), 0);
        assert_eq!(try_wait_calls.load(Ordering::Acquire), 0);
        assert_eq!(wait_calls.load(Ordering::Acquire), 1);
        assert!(provider_exit_observed.load(Ordering::Acquire));
        let descendant_retired = match exact_local_process_generation(descendant_pid) {
            Ok(current) => current != descendant_generation,
            Err(_) => true,
        };
        assert!(
            descendant_retired,
            "completion published before the exact descendant generation retired"
        );
    }

    #[test]
    fn unproven_provider_cleanup_contains_separate_process_groups_before_reap() {
        let state = tempfile::tempdir().unwrap();
        let descendant_path = state.path().join("descendant.pid");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "set -m; (trap '' HUP TERM; sleep 30) & echo $! > \"$1\"; \
             trap '' HUP TERM; wait",
            "hmux-unproven-provider-cleanup",
            descendant_path.to_str().unwrap(),
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let provider_pid = child.process_id().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let descendant_pid = loop {
            if let Ok(value) = fs::read_to_string(&descendant_path) {
                if let Ok(process_id) = value.trim().parse::<u32>() {
                    break process_id;
                }
            }
            assert!(
                Instant::now() < deadline,
                "provider did not publish its descendant process id"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let provider = libc::pid_t::try_from(provider_pid).unwrap();
        let descendant = libc::pid_t::try_from(descendant_pid).unwrap();
        // SAFETY: these calls only inspect exact child generations that this
        // test owns and has not reaped.
        assert_eq!(unsafe { libc::getsid(provider) }, provider);
        // SAFETY: same exact test-owned generation as above.
        assert_eq!(unsafe { libc::getsid(descendant) }, provider);
        assert_ne!(
            // SAFETY: getpgid only inspects the exact descendant generation.
            unsafe { libc::getpgid(descendant) },
            provider,
            "fixture must create a separate descendant process group"
        );

        cleanup_unproven_provider_child(&mut *child, Some(provider_pid));

        for (process, role) in [(provider, "provider"), (descendant, "descendant")] {
            let deadline = Instant::now() + Duration::from_secs(3);
            // SAFETY: getsid only checks whether this exact, previously
            // test-owned process identifier still exists.
            while unsafe { libc::getsid(process) } >= 0 {
                assert!(
                    Instant::now() < deadline,
                    "{role} survived unproven-provider cleanup"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    #[test]
    fn natural_provider_exit_drains_surviving_descendant_before_completion() {
        let state = tempfile::tempdir().unwrap();
        let descendant_path = state.path().join("descendant.pid");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "set -m; (trap '' HUP TERM; while :; do sleep 30; done) & \
             echo $! > \"$1\"; exit 0",
            "hmux-natural-provider-exit",
            descendant_path.to_str().unwrap(),
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let provider_pid = child.process_id().unwrap();
        let provider_session =
            OwnedProcessSession::new(provider_pid).expect("test provider must own its session");
        let provider_runtime_session =
            OwnedProcessSession::new(provider_pid).expect("test provider must own its session");
        let deadline = Instant::now() + Duration::from_secs(3);
        let descendant_pid = loop {
            if let Ok(value) = fs::read_to_string(&descendant_path) {
                if let Ok(process_id) = value.trim().parse::<u32>() {
                    break process_id;
                }
            }
            assert!(
                Instant::now() < deadline,
                "provider did not publish its surviving descendant"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let descendant_generation = exact_local_process_generation(descendant_pid)
            .expect("surviving descendant generation must be observable");

        let (_termination_tx, termination_rx) = mpsc::channel();
        let provider_exit_observed = AtomicBool::new(false);
        let pty_master = Mutex::new(pair.master);
        let completion = wait_for_provider(
            &mut child,
            &termination_rx,
            provider_runtime_session,
            ProviderProcessControl::new(&Mutex::new(()), &provider_exit_observed, &pty_master),
        )
        .expect("natural provider completion must be observed");

        let descendant_state = std::process::Command::new("/bin/ps")
            .args(["-o", "state=", "-p", &descendant_pid.to_string()])
            .output()
            .expect("descendant state must be observable");
        let writer_survived = descendant_state.status.success()
            && descendant_state
                .stdout
                .into_iter()
                .find(|byte| !byte.is_ascii_whitespace())
                .is_some_and(|state| state != b'Z');
        if exact_local_process_generation(descendant_pid)
            .is_ok_and(|current| current == descendant_generation)
        {
            let _ = provider_session.terminate(None);
        }
        let cleanup_deadline = Instant::now() + Duration::from_secs(3);
        while exact_local_process_generation(descendant_pid)
            .is_ok_and(|current| current == descendant_generation)
        {
            assert!(
                Instant::now() < cleanup_deadline,
                "test-owned surviving descendant did not retire during cleanup"
            );
            thread::sleep(Duration::from_millis(10));
        }

        assert!(
            !writer_survived,
            "provider completion must not publish while a descendant can retain the conversation writer"
        );
        assert!(!completion.terminated);
        assert!(provider_exit_observed.load(Ordering::Acquire));
    }

    #[test]
    fn provider_identity_follows_a_transparent_env_exec_without_guessing_options() {
        assert_eq!(
            expected_provider_identity_program(
                Path::new("/usr/bin/env"),
                &[
                    "HMUX_COMMAND_BRIDGE_ORIGINAL_ZDOTDIR=/tmp/home".to_string(),
                    "ZDOTDIR=/tmp/bridge".to_string(),
                    "/bin/zsh".to_string(),
                    "-l".to_string(),
                ],
            ),
            Path::new("/bin/zsh")
        );
        assert_eq!(
            expected_provider_identity_program(
                Path::new("/usr/bin/env"),
                &["--".to_string(), "/usr/bin/fish".to_string()],
            ),
            Path::new("/usr/bin/fish")
        );
        assert_eq!(
            expected_provider_identity_program(
                Path::new("/usr/bin/env"),
                &["-S".to_string(), "/bin/zsh -l".to_string()],
            ),
            Path::new("/usr/bin/env")
        );
        assert_eq!(
            expected_provider_identity_program(Path::new("/bin/bash"), &["-l".to_string()]),
            Path::new("/bin/bash")
        );
    }
}
