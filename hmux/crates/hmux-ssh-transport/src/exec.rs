//! Bounded no-PTY SSH commands for read-only remote inspection.

use crate::error::SshTransportError;
use crate::session::{SshExecConfig, execute_bounded};
use std::time::Duration;

const MAX_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: u32,
}

/// Executes one command without a PTY under fixed time and output bounds.
///
/// The caller chooses the command through [`SshExecConfig::command`]. Host-key
/// pinning and authentication are identical to an Hmux gateway attach. This
/// function grants no process or session authority; it only returns bytes and
/// the remote exit status.
pub fn execute_bounded_over_ssh(
    config: SshExecConfig,
    timeout: Duration,
) -> Result<SshExecOutput, SshTransportError> {
    if timeout.is_zero() || timeout > MAX_COMMAND_TIMEOUT {
        return Err(SshTransportError::Exec {
            command: config.command.clone(),
            detail: "the bounded command timeout is outside 1ns..=60s".to_string(),
        });
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(SshTransportError::Runtime)?;
    let outcome = runtime.block_on(async {
        tokio::time::timeout(timeout, execute_bounded(&config, MAX_OUTPUT_BYTES)).await
    });
    match outcome {
        Err(_) => Err(SshTransportError::Timeout {
            phase: "the bounded remote command",
            after: timeout,
        }),
        Ok(Err(error)) => Err(error),
        Ok(Ok((stdout, stderr, exit_status))) => Ok(SshExecOutput {
            stdout,
            stderr,
            exit_status,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unbounded_timeout_before_network_io() {
        let config = SshExecConfig::new(
            crate::SshEndpoint {
                host: "127.0.0.1".to_string(),
                port: 1,
            },
            "nobody",
            crate::SshAuthentication::Password("unused".to_string()),
            crate::HostKeyPolicy::pinned(["SHA256:unused".to_string()]),
        );
        let error = execute_bounded_over_ssh(config, Duration::from_secs(61)).unwrap_err();
        assert_eq!(error.code(), "hmux_ssh_exec_refused");
    }

    #[test]
    fn output_bound_is_fixed() {
        assert_eq!(MAX_OUTPUT_BYTES, 256 * 1024);
    }
}
