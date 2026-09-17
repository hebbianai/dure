use dure_app::{PluginNativeCommandHostFailureV2, PluginNativeCommandOutcomeV2};
use hebbian_bounded_process::{CommandFailure, CommandOutput};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginNativeCliExecution {
    outcome: PluginNativeCommandOutcomeV2,
    stdout: Vec<u8>,
}

impl PluginNativeCliExecution {
    #[cfg(test)]
    pub(crate) fn captured(outcome: PluginNativeCommandOutcomeV2, stdout: Vec<u8>) -> Self {
        Self { outcome, stdout }
    }

    pub fn outcome(&self) -> &PluginNativeCommandOutcomeV2 {
        &self.outcome
    }
    pub fn stdout(&self) -> &[u8] {
        &self.stdout
    }
}

pub(super) fn classify_execution(
    result: Result<CommandOutput, CommandFailure>,
) -> PluginNativeCliExecution {
    match result {
        Err(CommandFailure::Timeout(_)) => execution(PluginNativeCommandOutcomeV2::TimedOut),
        Err(failure) => execution(PluginNativeCommandOutcomeV2::HostFailed {
            stage: match failure {
                CommandFailure::Spawn | CommandFailure::StdinPrepare => {
                    PluginNativeCommandHostFailureV2::Spawn
                }
                CommandFailure::StdoutUnavailable
                | CommandFailure::StdoutConfigure
                | CommandFailure::StdoutReaderSpawn
                | CommandFailure::StdoutRead
                | CommandFailure::StderrUnavailable
                | CommandFailure::StderrConfigure
                | CommandFailure::StderrRead
                | CommandFailure::OutputLimit => PluginNativeCommandHostFailureV2::OutputCapture,
                CommandFailure::ProcessWait => PluginNativeCommandHostFailureV2::ProcessWait,
                CommandFailure::Cleanup => PluginNativeCommandHostFailureV2::Cleanup,
                CommandFailure::Timeout(_) => unreachable!("timeout was classified above"),
            },
        }),
        Ok(output) if output.exceeded_limit => {
            execution(PluginNativeCommandOutcomeV2::HostFailed {
                stage: PluginNativeCommandHostFailureV2::OutputCapture,
            })
        }
        Ok(output) if !output.status.success() => {
            execution(PluginNativeCommandOutcomeV2::ExitedNonzero {
                exit_code: output.status.code(),
            })
        }
        Ok(output) => PluginNativeCliExecution {
            outcome: PluginNativeCommandOutcomeV2::Succeeded,
            stdout: output.stdout,
        },
    }
}

fn execution(outcome: PluginNativeCommandOutcomeV2) -> PluginNativeCliExecution {
    PluginNativeCliExecution {
        outcome,
        stdout: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn additional_io_stages_preserve_existing_plugin_outcomes() {
        for (cause, stage) in [
            (
                CommandFailure::StdinPrepare,
                PluginNativeCommandHostFailureV2::Spawn,
            ),
            (
                CommandFailure::StderrUnavailable,
                PluginNativeCommandHostFailureV2::OutputCapture,
            ),
            (
                CommandFailure::StderrConfigure,
                PluginNativeCommandHostFailureV2::OutputCapture,
            ),
            (
                CommandFailure::StderrRead,
                PluginNativeCommandHostFailureV2::OutputCapture,
            ),
            (
                CommandFailure::OutputLimit,
                PluginNativeCommandHostFailureV2::OutputCapture,
            ),
        ] {
            assert_eq!(
                classify_execution(Err(cause)).outcome(),
                &PluginNativeCommandOutcomeV2::HostFailed { stage }
            );
        }
    }
}
