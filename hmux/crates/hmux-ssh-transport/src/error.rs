//! Why an SSH attach did not produce a usable transport.
//!
//! Every variant names a phase, because the failures a remote attach actually
//! produces are otherwise indistinguishable from each other: `ssh` rejecting a
//! key, the gateway not being installed, and a stalled network all end as a
//! closed channel. A phone that can only say "could not connect" sends its user
//! to the wrong fix.

use hmux_client::ClientError;
use std::fmt;
use std::io;
use std::time::Duration;

#[derive(Debug)]
pub enum SshTransportError {
    /// The owning I/O thread or its runtime could not be started.
    Runtime(io::Error),
    /// No SSH session could be established with the host.
    Connect { target: String, detail: String },
    /// The host presented a key that was not pinned. Reported with the
    /// fingerprint the host actually offered, because the legitimate reason to
    /// see this — a rebuilt box — is only actionable if you can see what to
    /// re-pin.
    HostKeyRejected { fingerprint: String },
    /// The supplied private key could not be decoded (or needs a passphrase).
    PrivateKey { detail: String },
    /// The selected SSH agent could not provide a usable signer.
    Agent { detail: String },
    /// The configured trust file did not contain a key for the exact endpoint.
    KnownHosts { detail: String },
    /// sshd refused the credentials.
    Authentication { user: String },
    /// The session opened but the exec request did not.
    Exec { command: String, detail: String },
    /// A phase did not finish inside its budget.
    Timeout {
        phase: &'static str,
        after: Duration,
    },
    /// A bounded diagnostic command exceeded its fixed stdout/stderr budget.
    OutputLimit {
        stream: &'static str,
        maximum_bytes: usize,
    },
}

impl fmt::Display for SshTransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Runtime(source) => {
                write!(
                    formatter,
                    "could not start the Hmux SSH transport: {source}"
                )
            }
            Self::Connect { target, detail } => {
                write!(formatter, "could not reach {target} over SSH: {detail}")
            }
            Self::HostKeyRejected { fingerprint } => write!(
                formatter,
                "the host offered an unpinned SSH host key ({fingerprint})"
            ),
            Self::PrivateKey { detail } => {
                write!(formatter, "the SSH private key could not be used: {detail}")
            }
            Self::Agent { detail } => {
                write!(formatter, "the SSH agent could not be used: {detail}")
            }
            Self::KnownHosts { detail } => {
                write!(
                    formatter,
                    "the SSH known-hosts trust could not be used: {detail}"
                )
            }
            Self::Authentication { user } => {
                write!(formatter, "SSH authentication for {user} was refused")
            }
            Self::Exec { command, detail } => {
                write!(formatter, "the host refused to run `{command}`: {detail}")
            }
            Self::Timeout { phase, after } => write!(
                formatter,
                "the SSH transport gave up during {phase} after {after:?}"
            ),
            Self::OutputLimit {
                stream,
                maximum_bytes,
            } => write!(
                formatter,
                "the remote command exceeded the {stream} limit of {maximum_bytes} bytes"
            ),
        }
    }
}

impl std::error::Error for SshTransportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Runtime(source) => Some(source),
            _ => None,
        }
    }
}

impl SshTransportError {
    /// A stable code for callers that branch on the failure rather than
    /// display it.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Runtime(_) => "hmux_ssh_runtime_unavailable",
            Self::Connect { .. } => "hmux_ssh_unreachable",
            Self::HostKeyRejected { .. } => "hmux_ssh_host_key_rejected",
            Self::PrivateKey { .. } => "hmux_ssh_key_unusable",
            Self::Agent { .. } => "hmux_ssh_agent_unavailable",
            Self::KnownHosts { .. } => "hmux_ssh_host_trust_unavailable",
            Self::Authentication { .. } => "hmux_ssh_authentication_refused",
            Self::Exec { .. } => "hmux_ssh_exec_refused",
            Self::Timeout { .. } => "hmux_ssh_timed_out",
            Self::OutputLimit { .. } => "hmux_ssh_output_too_large",
        }
    }
}

impl From<SshTransportError> for ClientError {
    fn from(error: SshTransportError) -> Self {
        ClientError::Transport {
            code: error.code(),
            message: error.to_string(),
        }
    }
}
