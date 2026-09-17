use hebbian_bounded_process::CommandFailure;

pub(super) fn external_cli_failure(failure: CommandFailure) -> String {
    let detail = match failure {
        CommandFailure::Timeout(_) => {
            return format!(
                "hmux_external_cli_timeout: version-matched CLI timed out; stage={}",
                failure.stage()
            );
        }
        CommandFailure::Spawn => "version-matched CLI did not start",
        CommandFailure::StdinPrepare => "CLI input preparation failed",
        CommandFailure::OutputLimit => "CLI output exceeded its limit",
        CommandFailure::StdoutUnavailable | CommandFailure::StderrUnavailable => {
            "CLI output is unavailable"
        }
        CommandFailure::StdoutConfigure
        | CommandFailure::StderrConfigure
        | CommandFailure::StdoutReaderSpawn => "CLI output reader failed",
        CommandFailure::ProcessWait => "version-matched CLI failed",
        CommandFailure::Cleanup => "version-matched CLI cleanup failed",
        CommandFailure::StdoutRead | CommandFailure::StderrRead => "CLI output is unreadable",
    };
    format!(
        "hmux_external_cli_failed: {detail}; stage={}",
        failure.stage()
    )
}

pub(super) fn bundled_runtime_failure(failure: CommandFailure) -> String {
    let detail = match failure {
        CommandFailure::Timeout(_) => {
            return format!(
                "hmux_bundled_runtime_timeout: build info probe timed out; stage={}",
                failure.stage()
            );
        }
        CommandFailure::Spawn => "build info probe did not start",
        CommandFailure::StdinPrepare => "build info input preparation failed",
        CommandFailure::OutputLimit => "build info output exceeded its limit",
        CommandFailure::StdoutUnavailable | CommandFailure::StderrUnavailable => {
            "build info output is unavailable"
        }
        CommandFailure::StdoutConfigure
        | CommandFailure::StderrConfigure
        | CommandFailure::StdoutReaderSpawn => "build info output reader failed",
        CommandFailure::ProcessWait => "build info probe failed",
        CommandFailure::Cleanup => "build info cleanup failed",
        CommandFailure::StdoutRead | CommandFailure::StderrRead => {
            "build info output is unreadable"
        }
    };
    format!(
        "hmux_bundled_runtime_invalid: {detail}; stage={}",
        failure.stage()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use hebbian_bounded_process::TimeoutStage;

    #[test]
    fn input_and_stderr_failures_keep_the_existing_error_families() {
        for failure in [
            CommandFailure::StdinPrepare,
            CommandFailure::StderrUnavailable,
            CommandFailure::StderrConfigure,
            CommandFailure::StderrRead,
            CommandFailure::OutputLimit,
        ] {
            assert!(external_cli_failure(failure).starts_with("hmux_external_cli_failed:"));
            assert!(bundled_runtime_failure(failure).starts_with("hmux_bundled_runtime_invalid:"));
            assert!(external_cli_failure(failure).ends_with(failure.stage()));
            assert!(bundled_runtime_failure(failure).ends_with(failure.stage()));
        }
        let timeout = CommandFailure::Timeout(TimeoutStage::StderrDrain);
        assert!(external_cli_failure(timeout).starts_with("hmux_external_cli_timeout:"));
        assert!(bundled_runtime_failure(timeout).starts_with("hmux_bundled_runtime_timeout:"));
    }
}
