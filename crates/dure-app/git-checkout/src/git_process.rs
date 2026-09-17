use super::{GitCheckoutInstanceError, MAX_GIT_OUTPUT_BYTES};
use hebbian_bounded_process::{CommandFailure, CommandSpec, OutputLimitAction, run};
use std::ffi::{OsStr, OsString};
use std::path::Path;
#[cfg(test)]
use std::process::Command;
use std::process::Output;
use std::time::Duration;

pub(super) const GIT_TIMEOUT: Duration = Duration::from_secs(20);

fn git_arguments(repository: &Path) -> [&OsStr; 5] {
    [
        OsStr::new("--no-replace-objects"),
        OsStr::new("-C"),
        repository.as_os_str(),
        OsStr::new("-c"),
        OsStr::new(if cfg!(windows) {
            "core.hooksPath=NUL"
        } else {
            "core.hooksPath=/dev/null"
        }),
    ]
}

fn git_environment() -> impl Iterator<Item = (OsString, OsString)> {
    std::env::vars_os().filter(|(key, _)| !key.to_string_lossy().starts_with("GIT_"))
}

#[cfg(test)]
pub(super) fn scrub_git_environment(command: &mut Command) {
    command.env_clear().envs(git_environment());
}

fn git_command(repository: &Path) -> CommandSpec {
    let mut command = CommandSpec::new("git");
    command
        .args(git_arguments(repository))
        .clear_env()
        .on_output_limit(OutputLimitAction::TerminateProcessTree);
    for (key, value) in git_environment() {
        command.env(key, value);
    }
    command
}

fn command_failure(args: &[&str], cause: CommandFailure) -> GitCheckoutInstanceError {
    GitCheckoutInstanceError::new(
        match cause {
            CommandFailure::Spawn | CommandFailure::StdinPrepare => "worktree_git_unavailable",
            CommandFailure::OutputLimit => "worktree_git_output_too_large",
            _ => "worktree_git_failed",
        },
        format!("git {} failed at {}", args.join(" "), cause.stage()),
    )
}

pub(super) fn capture_git_output(
    repository: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    timeout: Duration,
) -> Result<Output, GitCheckoutInstanceError> {
    capture_git_output_using(repository, args, input, |command| {
        run(command, timeout, MAX_GIT_OUTPUT_BYTES).map_err(|cause| command_failure(args, cause))
    })
}

#[cfg(unix)]
pub(super) fn capture_bound_git_output(
    repository: &Path,
    args: &[&str],
    anchors: &[hebbian_bounded_process::UnixDirectoryAnchor<'_>],
) -> Result<Output, GitCheckoutInstanceError> {
    capture_git_output_using(repository, args, None, |command| {
        hebbian_bounded_process::run_unix_bound_command(
            command,
            anchors,
            None,
            GIT_TIMEOUT,
            MAX_GIT_OUTPUT_BYTES,
        )
        .map_err(|cause| match cause {
            hebbian_bounded_process::UnixBoundCommandFailure::Command(cause) => {
                command_failure(args, cause)
            }
            _ => GitCheckoutInstanceError::new(
                "worktree_git_unavailable",
                format!("Git execution anchor: {cause:?}"),
            ),
        })
    })
}

fn capture_git_output_using(
    repository: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    execute: impl FnOnce(
        &CommandSpec,
    )
        -> Result<hebbian_bounded_process::CommandOutput, GitCheckoutInstanceError>,
) -> Result<Output, GitCheckoutInstanceError> {
    let mut command = git_command(repository);
    command.args(args).capture_stderr(true);
    if let Some(input) = input {
        command.input(input);
    }
    let output = execute(&command)?;
    Ok(Output {
        status: output.status,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

pub(super) fn git_output(
    repository: &Path,
    args: &[&str],
) -> Result<Vec<u8>, GitCheckoutInstanceError> {
    git_output_with_timeout(repository, args, GIT_TIMEOUT)
}

pub(super) fn git_output_with_timeout(
    repository: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<Vec<u8>, GitCheckoutInstanceError> {
    let output = capture_git_output(repository, args, None, timeout)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim_end_matches(['\r', '\n']);
        return Err(GitCheckoutInstanceError::new(
            "worktree_git_failed",
            if detail.is_empty() {
                format!("git {} failed", args.join(" "))
            } else {
                format!("git {} failed: {detail}", args.join(" "))
            },
        ));
    }
    Ok(output.stdout)
}

pub(super) fn checkout_is_clean_for_plain_remove(
    path: &Path,
) -> Result<bool, GitCheckoutInstanceError> {
    checkout_is_clean_with_timeout(path, GIT_TIMEOUT)
}

pub(super) fn checkout_is_clean_with_timeout(
    path: &Path,
    timeout: Duration,
) -> Result<bool, GitCheckoutInstanceError> {
    let args = ["status", "--porcelain=v1", "--untracked-files=all", "-z"];
    let mut command = git_command(path);
    command.args(args);
    // No status payload is needed: the first byte proves the checkout is dirty.
    // The shared runner retains at most limit + 1 bytes and owns all child cleanup.
    match run(&command, timeout, 0) {
        Err(CommandFailure::OutputLimit) => Ok(false),
        Err(cause) => Err(command_failure(&args, cause)),
        Ok(output) if output.status.success() => Ok(true),
        Ok(_) => Err(GitCheckoutInstanceError::new(
            "worktree_git_failed",
            "git status failed during clean-checkout preflight",
        )),
    }
}
