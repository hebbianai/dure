use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use hmux_client::PresentationCheckpointPredecessor;
use serde::{Deserialize, Serialize};

use super::managed_connection_driver::{RuntimeFiles, exact_owner_directory};
use super::{conflict, safe_token, unavailable};
use crate::structured_provider_runtime::StructuredProviderRuntimeErrorV1 as Error;

const SCHEMA_VERSION: u16 = 1;
const PRESENTATION_PREDECESSOR_FILE: &str = "presentation-predecessor.json";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCreateIdentityCheckpointV1 {
    schema_version: u16,
    source_session_id: String,
    source_idempotency_key: String,
    workspace_id: String,
    request_digest: String,
    status: ManagedCreateIdentityCheckpointStatusV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum ManagedCreateIdentityCheckpointStatusV1 {
    Prepared {
        source_session_id: String,
        source_idempotency_key: String,
    },
    Effective {
        current_session_id: String,
        current_idempotency_key: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ManagedCreateCheckpointResolution {
    Missing,
    Prepared {
        session_id: String,
        idempotency_key: String,
    },
    Effective {
        session_id: String,
        idempotency_key: String,
    },
}

impl ManagedCreateIdentityCheckpointV1 {
    fn prepared(
        files: &RuntimeFiles,
        workspace_id: &str,
        source_session_id: &str,
        source_idempotency_key: &str,
        request_digest: &str,
    ) -> Result<Self, Error> {
        let checkpoint = Self {
            schema_version: SCHEMA_VERSION,
            source_session_id: files.session_id.clone(),
            source_idempotency_key: files.idempotency_key.clone(),
            workspace_id: workspace_id.into(),
            request_digest: request_digest.into(),
            status: ManagedCreateIdentityCheckpointStatusV1::Prepared {
                source_session_id: source_session_id.into(),
                source_idempotency_key: source_idempotency_key.into(),
            },
        };
        checkpoint.validate(files, workspace_id)?;
        Ok(checkpoint)
    }

    fn with_effective_identity(
        &self,
        files: &RuntimeFiles,
        workspace_id: &str,
        effective_session_id: &str,
        effective_idempotency_key: &str,
    ) -> Result<Self, Error> {
        let checkpoint = Self {
            status: ManagedCreateIdentityCheckpointStatusV1::Effective {
                current_session_id: effective_session_id.into(),
                current_idempotency_key: effective_idempotency_key.into(),
            },
            ..self.clone()
        };
        checkpoint.validate(files, workspace_id)?;
        Ok(checkpoint)
    }

    fn validate(&self, files: &RuntimeFiles, workspace_id: &str) -> Result<(), Error> {
        let effective_identity_is_valid = match &self.status {
            ManagedCreateIdentityCheckpointStatusV1::Prepared {
                source_session_id,
                source_idempotency_key,
            } => {
                safe_token(source_session_id)
                    && safe_token(source_idempotency_key)
                    && ((source_session_id == &self.source_session_id
                        && source_idempotency_key == &self.source_idempotency_key)
                        || (source_session_id != &self.source_session_id
                            && source_idempotency_key != &self.source_idempotency_key))
            }
            ManagedCreateIdentityCheckpointStatusV1::Effective {
                current_session_id,
                current_idempotency_key,
            } => {
                let source_is_effective = self.source_session_id == *current_session_id
                    && self.source_idempotency_key == *current_idempotency_key;
                let source_is_replaced = self.source_session_id != *current_session_id
                    && self.source_idempotency_key != *current_idempotency_key;
                safe_token(current_session_id)
                    && safe_token(current_idempotency_key)
                    && (source_is_effective || source_is_replaced)
            }
        };
        if self.schema_version != SCHEMA_VERSION
            || self.source_session_id != files.session_id
            || self.source_idempotency_key != files.idempotency_key
            || self.workspace_id != workspace_id
            || !safe_token(&self.source_session_id)
            || !safe_token(&self.source_idempotency_key)
            || !safe_token(&self.workspace_id)
            || self.request_digest.len() != 64
            || !self
                .request_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || !effective_identity_is_valid
        {
            return Err(conflict());
        }
        Ok(())
    }
}

pub(super) fn resolve_managed_create_checkpoint(
    files: &RuntimeFiles,
    workspace_id: &str,
) -> Result<ManagedCreateCheckpointResolution, Error> {
    Ok(match read_checkpoint(files, workspace_id)? {
        None => ManagedCreateCheckpointResolution::Missing,
        Some(ManagedCreateIdentityCheckpointV1 {
            status:
                ManagedCreateIdentityCheckpointStatusV1::Prepared {
                    source_session_id,
                    source_idempotency_key,
                },
            ..
        }) => ManagedCreateCheckpointResolution::Prepared {
            session_id: source_session_id,
            idempotency_key: source_idempotency_key,
        },
        Some(ManagedCreateIdentityCheckpointV1 {
            status:
                ManagedCreateIdentityCheckpointStatusV1::Effective {
                    current_session_id,
                    current_idempotency_key,
                },
            ..
        }) => ManagedCreateCheckpointResolution::Effective {
            session_id: current_session_id,
            idempotency_key: current_idempotency_key,
        },
    })
}

pub(super) fn prepare_managed_create_checkpoint(
    files: &RuntimeFiles,
    workspace_id: &str,
    source_session_id: &str,
    source_idempotency_key: &str,
    request_digest: &str,
) -> Result<(), Error> {
    match read_checkpoint(files, workspace_id)? {
        Some(existing)
            if matches!(
                &existing.status,
                ManagedCreateIdentityCheckpointStatusV1::Prepared {
                    source_session_id: existing_session_id,
                    source_idempotency_key: existing_idempotency_key,
                } if existing_session_id == source_session_id
                    && existing_idempotency_key == source_idempotency_key
                    && existing.request_digest == request_digest
            ) =>
        {
            Ok(())
        }
        Some(existing)
            if matches!(
                &existing.status,
                ManagedCreateIdentityCheckpointStatusV1::Effective {
                    current_session_id,
                    current_idempotency_key,
                } if current_session_id == source_session_id
                    && current_idempotency_key == source_idempotency_key
            ) =>
        {
            write_checkpoint(
                files,
                &ManagedCreateIdentityCheckpointV1::prepared(
                    files,
                    workspace_id,
                    source_session_id,
                    source_idempotency_key,
                    request_digest,
                )?,
            )
        }
        Some(_) => Err(conflict()),
        None => write_checkpoint(
            files,
            &ManagedCreateIdentityCheckpointV1::prepared(
                files,
                workspace_id,
                source_session_id,
                source_idempotency_key,
                request_digest,
            )?,
        ),
    }
}

pub(super) fn persist_effective_managed_create_identity(
    files: &RuntimeFiles,
    workspace_id: &str,
    request_digest: &str,
    effective_session_id: &str,
    effective_idempotency_key: &str,
) -> Result<(), Error> {
    let prepared = read_checkpoint(files, workspace_id)?
        .filter(|checkpoint| {
            checkpoint.request_digest == request_digest
                && matches!(
                    &checkpoint.status,
                    ManagedCreateIdentityCheckpointStatusV1::Prepared { .. }
                )
        })
        .ok_or_else(conflict)?;
    let effective = prepared.with_effective_identity(
        files,
        workspace_id,
        effective_session_id,
        effective_idempotency_key,
    )?;
    write_checkpoint(files, &effective)
}

pub(super) fn cleanup_managed_create_checkpoint(files: &RuntimeFiles) {
    cleanup_owner_file(&files.managed_create_identity);
}

pub(super) fn resolve_presentation_predecessor(
    files: &RuntimeFiles,
) -> Result<Option<PresentationCheckpointPredecessor>, Error> {
    let path = files.directory.join(PRESENTATION_PREDECESSOR_FILE);
    let Some(source) = read_owner_file(&path)? else {
        return Ok(None);
    };
    let predecessor: PresentationCheckpointPredecessor =
        serde_json::from_slice(&source).map_err(|_| conflict())?;
    predecessor.validate().map_err(|_| conflict())?;
    Ok(Some(predecessor))
}

pub(super) fn persist_presentation_predecessor(
    files: &RuntimeFiles,
    predecessor: &PresentationCheckpointPredecessor,
) -> Result<(), Error> {
    predecessor.validate().map_err(|_| conflict())?;
    match resolve_presentation_predecessor(files)? {
        Some(existing) if existing == *predecessor => return Ok(()),
        Some(_) => return Err(conflict()),
        None => {}
    }
    let path = files.directory.join(PRESENTATION_PREDECESSOR_FILE);
    write_owner_json(files, &path, ".presentation-predecessor", predecessor)
}

pub(super) fn cleanup_presentation_predecessor(files: &RuntimeFiles) {
    cleanup_owner_file(&files.directory.join(PRESENTATION_PREDECESSOR_FILE));
}

fn read_checkpoint(
    files: &RuntimeFiles,
    workspace_id: &str,
) -> Result<Option<ManagedCreateIdentityCheckpointV1>, Error> {
    let Some(source) = read_owner_file(&files.managed_create_identity)? else {
        return Ok(None);
    };
    let checkpoint: ManagedCreateIdentityCheckpointV1 =
        serde_json::from_slice(&source).map_err(|_| conflict())?;
    checkpoint.validate(files, workspace_id)?;
    Ok(Some(checkpoint))
}

fn read_owner_file(path: &Path) -> Result<Option<Vec<u8>>, Error> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unavailable()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() > 16 * 1024
    {
        return Err(conflict());
    }
    fs::read(path).map(Some).map_err(|_| unavailable())
}

fn write_checkpoint(
    files: &RuntimeFiles,
    checkpoint: &ManagedCreateIdentityCheckpointV1,
) -> Result<(), Error> {
    write_owner_json(
        files,
        &files.managed_create_identity,
        ".managed-create-identity",
        checkpoint,
    )
}

fn write_owner_json<T: Serialize>(
    files: &RuntimeFiles,
    path: &Path,
    temporary_prefix: &str,
    value: &T,
) -> Result<(), Error> {
    exact_owner_directory(&files.directory)?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = files.directory.join(format!(
        "{temporary_prefix}.{}.{}.tmp",
        std::process::id(),
        sequence,
    ));
    let source = serde_json::to_vec(value).map_err(|_| unavailable())?;
    let written = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&source)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(&files.directory)?.sync_all()
    })();
    if written.is_err() {
        cleanup_owner_file(&temporary);
        return Err(unavailable());
    }
    Ok(())
}

fn cleanup_owner_file(path: &std::path::Path) {
    if fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == unsafe { libc::geteuid() }
    }) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn runtime_files_fixture(root: &std::path::Path) -> RuntimeFiles {
        RuntimeFiles {
            directory: root.join("runtime-files"),
            endpoint: root.join("runtime-files/app.sock"),
            upstream: root.join("runtime-files/provider.sock"),
            managed_create_identity: root.join("runtime-files/managed-create-identity.json"),
            session_id: "codex-chat-source".into(),
            idempotency_key: "codex-create-source".into(),
        }
    }

    #[test]
    fn owner_only_checkpoint_promotes_prepared_to_effective_and_survives_reopen() {
        let root = tempfile::tempdir().unwrap();
        let files = runtime_files_fixture(root.path());
        fs::create_dir(&files.directory).unwrap();
        fs::set_permissions(&files.directory, fs::Permissions::from_mode(0o700)).unwrap();
        let request_digest = super::super::digest("canonical-request");

        assert_eq!(
            resolve_managed_create_checkpoint(&files, "workspace-test").unwrap(),
            ManagedCreateCheckpointResolution::Missing,
        );
        prepare_managed_create_checkpoint(
            &files,
            "workspace-test",
            &files.session_id,
            &files.idempotency_key,
            &request_digest,
        )
        .unwrap();
        assert_eq!(
            resolve_managed_create_checkpoint(&files, "workspace-test").unwrap(),
            ManagedCreateCheckpointResolution::Prepared {
                session_id: files.session_id.clone(),
                idempotency_key: files.idempotency_key.clone(),
            },
        );
        persist_effective_managed_create_identity(
            &files,
            "workspace-test",
            &request_digest,
            "codex-chat-successor",
            "codex-create-successor",
        )
        .unwrap();

        assert_eq!(
            fs::symlink_metadata(&files.managed_create_identity)
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0,
        );
        assert_eq!(
            resolve_managed_create_checkpoint(
                &runtime_files_fixture(root.path()),
                "workspace-test",
            )
            .unwrap(),
            ManagedCreateCheckpointResolution::Effective {
                session_id: "codex-chat-successor".into(),
                idempotency_key: "codex-create-successor".into(),
            },
        );

        let next_digest = super::super::digest("changed-canonical-request");
        prepare_managed_create_checkpoint(
            &files,
            "workspace-test",
            "codex-chat-successor",
            "codex-create-successor",
            &next_digest,
        )
        .unwrap();
        assert_eq!(
            resolve_managed_create_checkpoint(&files, "workspace-test").unwrap(),
            ManagedCreateCheckpointResolution::Prepared {
                session_id: "codex-chat-successor".into(),
                idempotency_key: "codex-create-successor".into(),
            },
        );
        persist_effective_managed_create_identity(
            &files,
            "workspace-test",
            &next_digest,
            "codex-chat-successor-2",
            "codex-create-successor-2",
        )
        .unwrap();
        assert_eq!(
            resolve_managed_create_checkpoint(&files, "workspace-test").unwrap(),
            ManagedCreateCheckpointResolution::Effective {
                session_id: "codex-chat-successor-2".into(),
                idempotency_key: "codex-create-successor-2".into(),
            },
        );
    }

    #[test]
    fn malformed_checkpoint_and_context_mismatch_never_fall_back_to_source() {
        let root = tempfile::tempdir().unwrap();
        let files = runtime_files_fixture(root.path());
        fs::create_dir(&files.directory).unwrap();
        fs::set_permissions(&files.directory, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(&files.managed_create_identity).unwrap();

        assert!(
            prepare_managed_create_checkpoint(
                &files,
                "workspace-test",
                &files.session_id,
                &files.idempotency_key,
                &super::super::digest("canonical-request"),
            )
            .is_err()
        );
        assert!(resolve_managed_create_checkpoint(&files, "workspace-test").is_err());
    }

    #[test]
    fn presentation_predecessor_survives_the_stopped_source_runtime() {
        let root = tempfile::tempdir().unwrap();
        let files = runtime_files_fixture(root.path());
        fs::create_dir(&files.directory).unwrap();
        fs::set_permissions(&files.directory, fs::Permissions::from_mode(0o700)).unwrap();
        let predecessor = PresentationCheckpointPredecessor::new(
            "source-session",
            "source-runner",
            "source-instance",
            3,
            "source-host",
            "source-terminal",
        )
        .unwrap();

        persist_presentation_predecessor(&files, &predecessor).unwrap();
        persist_presentation_predecessor(&files, &predecessor).unwrap();

        assert_eq!(
            resolve_presentation_predecessor(&runtime_files_fixture(root.path())).unwrap(),
            Some(predecessor),
        );
    }

    #[test]
    fn effective_persist_failure_retains_the_exact_prepared_replay_authority() {
        let root = tempfile::tempdir().unwrap();
        let files = runtime_files_fixture(root.path());
        fs::create_dir(&files.directory).unwrap();
        fs::set_permissions(&files.directory, fs::Permissions::from_mode(0o700)).unwrap();
        let request_digest = super::super::digest("authorized-request");
        prepare_managed_create_checkpoint(
            &files,
            "workspace-test",
            &files.session_id,
            &files.idempotency_key,
            &request_digest,
        )
        .unwrap();

        fs::set_permissions(&files.directory, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(
            persist_effective_managed_create_identity(
                &files,
                "workspace-test",
                &request_digest,
                "codex-chat-successor",
                "codex-create-successor",
            )
            .is_err()
        );
        fs::set_permissions(&files.directory, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            resolve_managed_create_checkpoint(&files, "workspace-test").unwrap(),
            ManagedCreateCheckpointResolution::Prepared {
                session_id: files.session_id.clone(),
                idempotency_key: files.idempotency_key.clone(),
            },
        );

        persist_effective_managed_create_identity(
            &files,
            "workspace-test",
            &request_digest,
            "codex-chat-successor",
            "codex-create-successor",
        )
        .unwrap();
        assert_eq!(
            resolve_managed_create_checkpoint(&files, "workspace-test").unwrap(),
            ManagedCreateCheckpointResolution::Effective {
                session_id: "codex-chat-successor".into(),
                idempotency_key: "codex-create-successor".into(),
            },
        );
    }
}
