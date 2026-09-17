use super::WorkspaceFailure;
use hebbian_bounded_process::{
    CommandFailure, CommandOutput, CommandSpec, OutputLimitAction, UnixBoundCommandFailure,
    UnixDirectoryAnchor, run_unix_bound_command_async,
};
use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_GIT_OUTPUT_BYTES: usize = 1024 * 1024;

pub(super) async fn git_output<I, S>(
    project_root: &Path,
    arguments: I,
    stdin: Option<&[u8]>,
) -> Result<CommandOutput, WorkspaceFailure>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    git_output_bound(project_root, arguments, stdin, &[]).await
}

pub(super) async fn git_output_bound<I, S>(
    project_root: &Path,
    arguments: I,
    stdin: Option<&[u8]>,
    anchors: &[UnixDirectoryAnchor<'_>],
) -> Result<CommandOutput, WorkspaceFailure>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = CommandSpec::new("git");
    command
        .arg("-C")
        .arg(project_root)
        .args(arguments)
        .clear_env()
        .capture_stderr(true)
        .on_output_limit(OutputLimitAction::TerminateProcessTree);
    for (key, value) in std::env::vars_os() {
        if !key.to_string_lossy().starts_with("GIT_") {
            command.env(key, value);
        }
    }
    command.env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    if let Some(payload) = stdin {
        command.input(payload);
    }
    run_unix_bound_command_async(
        &command,
        anchors,
        None,
        GIT_TIMEOUT,
        MAX_GIT_OUTPUT_BYTES,
        tokio::time::sleep,
    )
    .await
    .map_err(|cause| {
        WorkspaceFailure::new(match cause {
            UnixBoundCommandFailure::Command(CommandFailure::Timeout(_)) => "workspace_git_timeout",
            UnixBoundCommandFailure::Command(CommandFailure::OutputLimit) => {
                "workspace_git_output_limit"
            }
            _ => "workspace_git_unavailable",
        })
    })
}
