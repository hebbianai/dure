use std::process::{Command, ExitStatus};
use std::time::Duration;

#[derive(Debug)]
pub(crate) enum CommandFailure {
    Timeout,
    Failed(String),
}

pub(crate) struct CommandOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

pub(crate) fn run_command(
    command: &mut Command,
    timeout: Duration,
    output_limit: usize,
) -> Result<CommandOutput, CommandFailure> {
    let mut specification = hebbian_bounded_process::CommandSpec::new(command.get_program());
    specification.args(command.get_args());
    if let Some(directory) = command.get_current_dir() {
        specification.current_dir(directory);
    }
    specification.clear_env();
    for (key, value) in std::env::vars_os() {
        if !key.to_string_lossy().starts_with("GIT_") {
            specification.env(key, value);
        }
    }
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            specification.env(key, value);
        }
    }
    match hebbian_bounded_process::run(&specification, timeout, output_limit) {
        Ok(output) => Ok(CommandOutput {
            status: output.status,
            stdout: output.stdout,
            stderr: Vec::new(),
        }),
        Err(hebbian_bounded_process::CommandFailure::Timeout(_)) => Err(CommandFailure::Timeout),
        Err(error) => Err(CommandFailure::Failed(format!(
            "bounded command failed at {}",
            error.stage()
        ))),
    }
}
