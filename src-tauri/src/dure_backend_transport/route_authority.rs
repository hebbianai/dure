use std::path::Path;

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt as _;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt as _;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};

use super::{
    selected_profile, BackendProfile, DureBackendTransportError, ExpectedBackend, FileIdentity,
    ProfileAuth, ProfileEndpoint, ProfileTransport, ProfileTrust, RuntimeConfig, SelectedProfile,
    SshReferences,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DureBackendIdentityV1 {
    id: String,
    generation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "snake_case", deny_unknown_fields)]
pub enum DureBackendPresentationTargetV1 {
    Local {
        #[serde(rename = "hostId")]
        host_id: String,
    },
    Ssh {
        #[serde(rename = "hostId")]
        host_id: String,
        remote: DureBackendSshCoordinatesV1,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DureBackendSshCoordinatesV1 {
    host: String,
    port: u16,
    user: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DureBackendRouteAuthorityV1 {
    schema_version: u16,
    profile_id: String,
    revision: String,
    backend: DureBackendIdentityV1,
    target: DureBackendPresentationTargetV1,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum DureBackendRouteV1 {
    #[serde(rename = "selected")]
    Selected {
        #[serde(default, rename = "profileId")]
        profile_id: Option<String>,
    },
    #[serde(rename = "exact")]
    Exact {
        authority: DureBackendRouteAuthorityV1,
    },
}

impl DureBackendRouteV1 {
    pub(super) fn profile_id(&self) -> Option<&str> {
        match self {
            Self::Selected { profile_id } => profile_id.as_deref(),
            Self::Exact { authority } => Some(&authority.profile_id),
        }
    }
}

fn endpoint_identity(endpoint: &ProfileEndpoint) -> Value {
    match endpoint {
        ProfileEndpoint::UnixSocket { path } => json!({
            "kind": "unix_socket",
            "pathIdentity": path_identity(path),
        }),
        ProfileEndpoint::WindowsNamedPipe { name } => json!({
            "kind": "windows_named_pipe",
            "name": name,
        }),
        ProfileEndpoint::Tcp { host, port } => json!({
            "kind": "tcp",
            "host": host,
            "port": port,
        }),
    }
}

fn append_hex_byte(output: &mut String, byte: u8) {
    use std::fmt::Write as _;
    let _ = write!(output, "{byte:02x}");
}

fn digest_identity(digest: &[u8; 32]) -> String {
    let mut output = String::with_capacity(64);
    for byte in digest {
        append_hex_byte(&mut output, *byte);
    }
    output
}

#[cfg(unix)]
fn path_identity(path: &Path) -> String {
    let mut output = String::from("unix-bytes:");
    for byte in path.as_os_str().as_bytes() {
        append_hex_byte(&mut output, *byte);
    }
    output
}

#[cfg(any(windows, test))]
fn windows_utf16le_identity(code_units: impl IntoIterator<Item = u16>) -> String {
    let mut output = String::from("windows-utf16le:");
    for code_unit in code_units {
        for byte in code_unit.to_le_bytes() {
            append_hex_byte(&mut output, byte);
        }
    }
    output
}

#[cfg(windows)]
fn path_identity(path: &Path) -> String {
    windows_utf16le_identity(path.as_os_str().encode_wide())
}

fn transport_identity(profile: &BackendProfile) -> Value {
    match &profile.transport {
        ProfileTransport::Local { endpoint } => json!({
            "kind": "local",
            "endpoint": endpoint_identity(endpoint),
        }),
        ProfileTransport::Ssh {
            host,
            port,
            user,
            endpoint,
            batch_mode,
            strict_host_key_checking,
            ..
        } => json!({
            "kind": "ssh",
            "host": host,
            "port": port,
            "user": user,
            "endpoint": endpoint_identity(endpoint),
            "batchMode": batch_mode,
            "strictHostKeyChecking": strict_host_key_checking,
        }),
    }
}

fn auth_identity(auth: &ProfileAuth) -> Value {
    match auth {
        ProfileAuth::Peer => json!({ "kind": "peer" }),
        ProfileAuth::SshAgent => json!({ "kind": "ssh_agent" }),
        ProfileAuth::IdentityFile { reference } => json!({
            "kind": "identity_file",
            "reference": reference,
        }),
    }
}

fn trust_identity(trust: &ProfileTrust) -> Value {
    match trust {
        ProfileTrust::LocalPeer => json!({ "kind": "local_peer" }),
        ProfileTrust::KnownHosts { reference } => json!({
            "kind": "known_hosts",
            "reference": reference,
        }),
    }
}

fn expected_identity(expected: &ExpectedBackend) -> Value {
    let mut capabilities = expected.capabilities.clone();
    capabilities.sort();
    json!({
        "backendId": expected.backend_id,
        "generation": expected.generation,
        "protocol": expected.protocol,
        "capabilities": capabilities,
    })
}

fn file_identity(identity: &FileIdentity) -> Value {
    json!({
        "pathIdentity": path_identity(&identity.path),
        "contentSha256": digest_identity(&identity.digest),
        "device": identity.device,
        "inode": identity.inode,
        "size": identity.size,
        "modifiedSeconds": identity.modified_seconds,
        "modifiedNanoseconds": identity.modified_nanoseconds,
        "changedSeconds": identity.changed_seconds,
        "changedNanoseconds": identity.changed_nanoseconds,
    })
}

fn ssh_reference_identity(references: Option<&SshReferences>) -> Value {
    match references {
        None => Value::Null,
        Some(references) => json!({
            "knownHostsFile": file_identity(&references.known_hosts_file),
            "identityFile": references.identity_file.as_ref().map(file_identity),
        }),
    }
}

fn target_for(selected: &SelectedProfile) -> DureBackendPresentationTargetV1 {
    match &selected.profile.transport {
        ProfileTransport::Local { .. } => DureBackendPresentationTargetV1::Local {
            host_id: "local".into(),
        },
        ProfileTransport::Ssh {
            host, port, user, ..
        } => DureBackendPresentationTargetV1::Ssh {
            host_id: selected.profile.id.clone(),
            remote: DureBackendSshCoordinatesV1 {
                host: host.clone(),
                port: *port,
                user: user.clone(),
            },
        },
    }
}

pub(super) fn authority_for(selected: &SelectedProfile) -> DureBackendRouteAuthorityV1 {
    let semantic_identity = json!({
        "schemaVersion": 1,
        "profileId": selected.profile.id,
        "transport": transport_identity(&selected.profile),
        "auth": auth_identity(&selected.profile.auth),
        "trust": trust_identity(&selected.profile.trust),
        "expected": expected_identity(&selected.profile.expected),
        "sshReferences": ssh_reference_identity(selected.ssh_references.as_ref()),
    });
    let revision = format!("sha256:{:x}", Sha256::digest(semantic_identity.to_string()));
    DureBackendRouteAuthorityV1 {
        schema_version: 1,
        profile_id: selected.profile.id.clone(),
        revision,
        backend: DureBackendIdentityV1 {
            id: selected.profile.expected.backend_id.clone(),
            generation: selected.profile.expected.generation.clone(),
        },
        target: target_for(selected),
    }
}

pub(super) fn select(
    root: &Path,
    config: &RuntimeConfig,
    route: &DureBackendRouteV1,
) -> Result<SelectedProfile, DureBackendTransportError> {
    let selected = selected_profile(root, config, route.profile_id())?;
    if let DureBackendRouteV1::Exact { authority } = route {
        let observed = authority_for(&selected);
        if authority != &observed {
            return Err(DureBackendTransportError::with_details(
                "backend_transport_authority_changed",
                "the selected backend route no longer matches the requested authority",
                Some(json!({
                    "profileId": observed.profile_id,
                    "expectedRevision": authority.revision,
                    "observedRevision": observed.revision,
                })),
            ));
        }
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::path_identity;
    use super::windows_utf16le_identity;
    #[cfg(unix)]
    use std::path::Path;

    #[test]
    fn windows_path_identity_has_an_explicit_utf16le_encoding() {
        assert_eq!(
            windows_utf16le_identity(r"C:\dure\backend.sock".encode_utf16()),
            "windows-utf16le:43003a005c0064007500720065005c006200610063006b0065006e0064002e0073006f0063006b00"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_path_identity_preserves_exact_os_bytes() {
        assert_eq!(
            path_identity(Path::new(r"C:\dure\backend.sock")),
            "unix-bytes:433a5c647572655c6261636b656e642e736f636b"
        );
    }
}
