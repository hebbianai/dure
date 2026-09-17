//! Hmux owns this process and its OpenCode server. A private Unix socket hands
//! the exact server address to a replacing control plane without restarting it.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::opencode_session_client::{OpenCodeSessionClient, PendingKind, SessionId};
use crate::private_driver_socket::{bind_endpoint, cleanup_socket, validate_socket_target};
use dure_app::ProviderPermissionModeV1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpenCodeEndpoint {
    pub(crate) version: u16,
    pub(crate) port: u16,
    pub(crate) password: String,
}

#[derive(Debug)]
pub struct OpenCodeConnectionDriverError(&'static str);

impl std::fmt::Display for OpenCodeConnectionDriverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "dure_opencode_connection_driver_{}", self.0)
    }
}

impl std::error::Error for OpenCodeConnectionDriverError {}

pub async fn run_from_arguments(
    arguments: impl Iterator<Item = OsString>,
) -> Result<(), OpenCodeConnectionDriverError> {
    let arguments = arguments.collect::<Vec<_>>();
    if arguments.len() != 8
        || arguments[0] != "--endpoint"
        || arguments[2] != "--session"
        || arguments[4] != "--permission-mode"
        || arguments[6] != "--"
    {
        return Err(OpenCodeConnectionDriverError("arguments_invalid"));
    }
    let endpoint = PathBuf::from(&arguments[1]);
    let session = SessionId::parse(
        arguments[3]
            .to_str()
            .ok_or(OpenCodeConnectionDriverError("arguments_invalid"))?,
    )
    .map_err(|_| OpenCodeConnectionDriverError("arguments_invalid"))?;
    let permission: ProviderPermissionModeV1 = serde_json::from_value(serde_json::json!(
        arguments[5]
            .to_str()
            .ok_or(OpenCodeConnectionDriverError("arguments_invalid"))?
    ))
    .map_err(|_| OpenCodeConnectionDriverError("arguments_invalid"))?;
    let executable = PathBuf::from(&arguments[7]);
    if !executable.is_absolute() {
        return Err(OpenCodeConnectionDriverError("arguments_invalid"));
    }
    validate_socket_target(&endpoint).map_err(OpenCodeConnectionDriverError)?;
    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret)
        .map_err(|_| OpenCodeConnectionDriverError("entropy_unavailable"))?;
    use base64::Engine as _;
    let password = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret);
    let mut child = Command::new(executable)
        .args(["serve", "--port", "0", "--hostname", "127.0.0.1"])
        .env("OPENCODE_SERVER_USERNAME", "opencode")
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| OpenCodeConnectionDriverError("upstream_launch_failed"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(OpenCodeConnectionDriverError("upstream_pipe_unavailable"))?;
    let mut output = BufReader::new(stdout);
    let port = tokio::time::timeout(Duration::from_secs(15), async {
        let mut remaining = 16 * 1024_u64;
        loop {
            let mut line = String::new();
            let size = (&mut output)
                .take(remaining)
                .read_line(&mut line)
                .await
                .map_err(|_| OpenCodeConnectionDriverError("upstream_read_failed"))?;
            if size == 0 {
                return Err(OpenCodeConnectionDriverError("upstream_readiness_failed"));
            }
            remaining = remaining.saturating_sub(size as u64);
            if let Some(port) = ready_port(line.trim()) {
                return Ok(port);
            }
            if remaining == 0 {
                return Err(OpenCodeConnectionDriverError("upstream_readiness_failed"));
            }
        }
    })
    .await
    .map_err(|_| OpenCodeConnectionDriverError("upstream_readiness_failed"))??;
    let listener = bind_endpoint(&endpoint).map_err(OpenCodeConnectionDriverError)?;
    let receipt = serde_json::to_vec(&OpenCodeEndpoint {
        version: 1,
        port,
        password: password.clone(),
    })
    .map_err(|_| OpenCodeConnectionDriverError("endpoint_encode_failed"))?;
    let client = OpenCodeSessionClient::new(
        port,
        password,
        &std::env::current_dir()
            .map_err(|_| OpenCodeConnectionDriverError("directory_unavailable"))?,
    )
    .map_err(|_| OpenCodeConnectionDriverError("policy_unavailable"))?;
    let mut policy = tokio::spawn(maintain_permission_policy(client, session, permission));
    // Server stdout after readiness is not a conversation protocol. Drain it
    // with a bounded buffer so an unread pipe cannot stop a provider turn.
    let drain =
        tokio::spawn(async move { tokio::io::copy(&mut output, &mut tokio::io::sink()).await });
    let result = loop {
        tokio::select! {
            _ = child.wait() => break Err(OpenCodeConnectionDriverError("upstream_exited")),
            _ = &mut policy => break Err(OpenCodeConnectionDriverError("policy_disconnected")),
            accepted = listener.accept() => {
                let (mut stream, _) = match accepted {
                    Ok(accepted) => accepted,
                    Err(_) => break Err(OpenCodeConnectionDriverError("endpoint_accept_failed")),
                };
                // A disconnected reader does not own the provider lifetime.
                let _ = tokio::time::timeout(Duration::from_secs(1), stream.write_all(&receipt)).await;
            }
        }
    };
    drain.abort();
    policy.abort();
    cleanup_socket(&endpoint);
    result
}

/// Automatic answers belong to the Hmux-owned process, so closing the app
/// cannot pause a turn that the selected policy already authorized. The
/// provider still owns explicit denials; only pending asks can be answered.
async fn maintain_permission_policy(
    client: OpenCodeSessionClient,
    session: SessionId,
    permission: ProviderPermissionModeV1,
) -> Result<(), OpenCodeConnectionDriverError> {
    if permission == ProviderPermissionModeV1::Default {
        std::future::pending::<()>().await;
    }
    let mut events = client
        .events()
        .await
        .map_err(|_| OpenCodeConnectionDriverError("policy_unavailable"))?;
    loop {
        for (kind, request) in client
            .pending(&session)
            .await
            .map_err(|_| OpenCodeConnectionDriverError("policy_unavailable"))?
        {
            let automatic = automatically_answers(&permission, kind, &request);
            if automatic {
                let id = request
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(OpenCodeConnectionDriverError("policy_request_invalid"))?;
                client
                    .reply(kind, id, serde_json::json!({"reply":"once"}))
                    .await
                    .map_err(|_| OpenCodeConnectionDriverError("policy_answer_failed"))?;
            }
        }
        loop {
            let event = events
                .next()
                .await
                .map_err(|_| OpenCodeConnectionDriverError("policy_disconnected"))?;
            if event.get("type").and_then(serde_json::Value::as_str) == Some("permission.asked")
                && event
                    .pointer("/properties/sessionID")
                    .and_then(serde_json::Value::as_str)
                    == Some(session.as_str())
            {
                break;
            }
        }
    }
}

pub(crate) fn automatically_answers(
    permission: &ProviderPermissionModeV1,
    kind: PendingKind,
    request: &serde_json::Value,
) -> bool {
    kind == PendingKind::Permission
        && match permission {
            ProviderPermissionModeV1::Default => false,
            ProviderPermissionModeV1::SkipPermissions => true,
            ProviderPermissionModeV1::AutoEdit => {
                request
                    .get("permission")
                    .and_then(serde_json::Value::as_str)
                    == Some("edit")
            }
        }
}

fn ready_port(line: &str) -> Option<u16> {
    line.strip_prefix("opencode server listening on http://127.0.0.1:")?
        .parse()
        .ok()
        .filter(|port| *port != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_policy_preserves_human_questions_and_non_edit_permissions() {
        for (permission, kind, name, expected) in [
            (
                ProviderPermissionModeV1::Default,
                PendingKind::Permission,
                "edit",
                false,
            ),
            (
                ProviderPermissionModeV1::AutoEdit,
                PendingKind::Permission,
                "edit",
                true,
            ),
            (
                ProviderPermissionModeV1::AutoEdit,
                PendingKind::Permission,
                "bash",
                false,
            ),
            (
                ProviderPermissionModeV1::SkipPermissions,
                PendingKind::Permission,
                "bash",
                true,
            ),
            (
                ProviderPermissionModeV1::SkipPermissions,
                PendingKind::Question,
                "edit",
                false,
            ),
        ] {
            assert_eq!(
                automatically_answers(&permission, kind, &serde_json::json!({"permission":name})),
                expected
            );
        }
    }

    #[test]
    fn readiness_accepts_only_the_bound_loopback_server_receipt() {
        assert_eq!(
            ready_port("opencode server listening on http://127.0.0.1:4242"),
            Some(4242)
        );
        for line in [
            "http://127.0.0.1:4242",
            "opencode server listening on http://example.test:4242",
            "opencode server listening on http://127.0.0.1:0",
            "opencode server listening on http://127.0.0.1:4242/path",
        ] {
            assert_eq!(ready_port(line), None);
        }
    }
}
