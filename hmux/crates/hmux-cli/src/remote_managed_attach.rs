use crate::managed_attach::{ManagedAttachError, attach_remote_controller};
use hmux_client::SessionFence;
use hmux_ssh_transport::{
    HostKeyPolicy, SshAuthentication, SshEndpoint, SshExecConfig, attach_controller_over_ssh,
};
use std::error::Error;
#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) struct RemoteManagedAttach {
    pub session_id: String,
    pub workspace_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub connect_timeout_ms: u64,
    pub identity_file: Option<PathBuf>,
    pub ssh_agent: bool,
    pub known_hosts_file: PathBuf,
    pub expected_fence_json: String,
}

pub(crate) fn attach(request: RemoteManagedAttach) -> Result<(), Box<dyn Error>> {
    let fence = parse_fence(&request)?;
    validate_request(&request, &fence)?;
    let authentication = match request.identity_file.as_deref() {
        Some(path) => SshAuthentication::PrivateKey {
            openssh_pem: read_owner_only_utf8(path, 1024 * 1024)?,
            passphrase: None,
        },
        None => SshAuthentication::Agent,
    };
    let endpoint = SshEndpoint {
        host: request.host,
        port: request.port,
    };
    let trust = HostKeyPolicy::from_known_hosts_file(
        &endpoint.host,
        endpoint.port,
        &request.known_hosts_file,
    )
    .map_err(|error| ManagedAttachError::terminal(error.code(), error.to_string()))?;
    let mut ssh = SshExecConfig::new(endpoint, request.user, authentication, trust);
    ssh.connect_timeout = Duration::from_millis(request.connect_timeout_ms);
    let display_name = fence.session_id.clone();
    let controller = attach_controller_over_ssh(ssh, fence, None)
        .map_err(|error| ManagedAttachError::terminal(error.code(), error.to_string()))?;
    attach_remote_controller(controller, &display_name)
}

fn parse_fence(request: &RemoteManagedAttach) -> Result<SessionFence, ManagedAttachError> {
    let fence: SessionFence = serde_json::from_str(&request.expected_fence_json).map_err(|_| {
        ManagedAttachError::terminal(
            "hmux_remote_attach_request_invalid",
            "remote managed attach fence is malformed",
        )
    })?;
    if fence.session_id != request.session_id || fence.workspace_id != request.workspace_id {
        return Err(ManagedAttachError::terminal(
            "hmux_remote_attach_request_invalid",
            "remote managed attach fence does not match its exact target",
        ));
    }
    Ok(fence)
}

fn validate_request(
    request: &RemoteManagedAttach,
    fence: &SessionFence,
) -> Result<(), ManagedAttachError> {
    let valid_identifier = |value: &str| {
        !value.is_empty()
            && value.len() <= 256
            && !value
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    };
    if request.port == 0
        || !valid_identifier(&request.host)
        || !valid_identifier(&request.user)
        || !valid_identifier(&request.session_id)
        || !valid_identifier(&request.workspace_id)
        || !valid_identifier(&fence.session_id)
        || !valid_identifier(&fence.workspace_id)
        || !valid_identifier(&fence.runner_principal)
        || !valid_identifier(&fence.runner_instance)
        || !valid_identifier(&fence.host_instance_id)
        || !valid_identifier(&fence.terminal_epoch)
        || request
            .identity_file
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        || request.identity_file.is_some() == request.ssh_agent
        || !request.known_hosts_file.is_absolute()
    {
        return Err(ManagedAttachError::terminal(
            "hmux_remote_attach_request_invalid",
            "remote managed attach requires exact identity and absolute credential references",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn read_owner_only_utf8(path: &Path, maximum_bytes: u64) -> Result<String, ManagedAttachError> {
    let path_metadata = std::fs::symlink_metadata(path).map_err(|error| {
        ManagedAttachError::terminal(
            "hmux_remote_attach_reference_unavailable",
            error.to_string(),
        )
    })?;
    validate_owner_file(&path_metadata, maximum_bytes)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| {
            ManagedAttachError::terminal(
                "hmux_remote_attach_reference_unavailable",
                error.to_string(),
            )
        })?;
    let before = file.metadata().map_err(|error| {
        ManagedAttachError::terminal(
            "hmux_remote_attach_reference_unavailable",
            error.to_string(),
        )
    })?;
    validate_owner_file(&before, maximum_bytes)?;
    if !same_file(&path_metadata, &before) {
        return Err(ManagedAttachError::terminal(
            "hmux_remote_attach_reference_changed",
            "credential reference changed before it was opened",
        ));
    }
    let mut bytes = Vec::with_capacity(before.size() as usize);
    (&mut file)
        .take(maximum_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            ManagedAttachError::terminal(
                "hmux_remote_attach_reference_unavailable",
                error.to_string(),
            )
        })?;
    let after = file.metadata().map_err(|error| {
        ManagedAttachError::terminal(
            "hmux_remote_attach_reference_unavailable",
            error.to_string(),
        )
    })?;
    let final_path = std::fs::symlink_metadata(path).map_err(|error| {
        ManagedAttachError::terminal("hmux_remote_attach_reference_changed", error.to_string())
    })?;
    if bytes.is_empty()
        || bytes.len() as u64 > maximum_bytes
        || !same_file(&before, &after)
        || !same_file(&after, &final_path)
    {
        return Err(ManagedAttachError::terminal(
            "hmux_remote_attach_reference_changed",
            "credential reference changed while it was read",
        ));
    }
    String::from_utf8(bytes).map_err(|error| {
        ManagedAttachError::terminal("hmux_remote_attach_reference_invalid", error.to_string())
    })
}

#[cfg(unix)]
fn validate_owner_file(
    metadata: &std::fs::Metadata,
    maximum_bytes: u64,
) -> Result<(), ManagedAttachError> {
    // SAFETY: `geteuid` reads process identity and has no preconditions.
    let effective_user = unsafe { libc::geteuid() };
    if !metadata.is_file()
        || metadata.size() == 0
        || metadata.size() > maximum_bytes
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != effective_user
    {
        return Err(ManagedAttachError::terminal(
            "hmux_remote_attach_reference_unsafe",
            "credential references must be owner-only regular files",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn same_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

#[cfg(not(unix))]
fn read_owner_only_utf8(_path: &Path, _maximum_bytes: u64) -> Result<String, ManagedAttachError> {
    Err(ManagedAttachError::terminal(
        "hmux_remote_attach_platform_unsupported",
        "owner-verified credential references are not available on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::fs::{Permissions, write};
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn request() -> RemoteManagedAttach {
        RemoteManagedAttach {
            session_id: "session-1".into(),
            workspace_id: "workspace-1".into(),
            host: "server.example".into(),
            port: 2222,
            user: "developer".into(),
            connect_timeout_ms: 1_000,
            identity_file: Some(PathBuf::from("/private/key")),
            ssh_agent: false,
            known_hosts_file: PathBuf::from("/private/known_hosts"),
            expected_fence_json: serde_json::json!({
                "workspace_id": "workspace-1",
                "session_id": "session-1",
                "runner_principal": "runner",
                "runner_instance": "runner-1",
                "channel_epoch": "7",
                "host_instance_id": "host-1",
                "terminal_epoch": "terminal-1",
            })
            .to_string(),
        }
    }

    #[test]
    fn fence_must_match_the_exact_requested_identity() {
        let mut request = request();
        let fence = parse_fence(&request).unwrap();
        assert_eq!(fence.session_id, request.session_id);
        assert_eq!(fence.workspace_id, request.workspace_id);

        request.session_id = "replacement".into();
        let error = parse_fence(&request).unwrap_err();
        assert_eq!(error.code(), "hmux_remote_attach_request_invalid");
    }

    #[test]
    fn authentication_requires_exactly_one_supported_source() {
        let mut request = request();
        let fence = parse_fence(&request).unwrap();
        validate_request(&request, &fence).unwrap();

        request.identity_file = None;
        request.ssh_agent = true;
        validate_request(&request, &fence).unwrap();

        request.identity_file = Some(PathBuf::from("/private/key"));
        assert_eq!(
            validate_request(&request, &fence).unwrap_err().code(),
            "hmux_remote_attach_request_invalid"
        );
    }

    #[cfg(unix)]
    #[test]
    fn credential_material_must_be_an_owner_only_stable_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("identity");
        write(&path, "private material").unwrap();
        std::fs::set_permissions(&path, Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            read_owner_only_utf8(&path, 1024).unwrap(),
            "private material"
        );

        std::fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap();
        let error = read_owner_only_utf8(&path, 1024).unwrap_err();
        assert_eq!(error.code(), "hmux_remote_attach_reference_unsafe");
    }
}
