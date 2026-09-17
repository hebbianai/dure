use super::{
    digest, ensure_private_directory, private_path_exists, request_fingerprint,
    validate_existing_private_directory,
};
use hmux_runtime_contract::{ManagedRehostLaunchIdentity, ManagedRehostResolution, PermissionMode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const INDEX_DIRECTORY: &str = ".managed-rehost-successors-v1";
const INDEX_SCHEMA_VERSION: u16 = 1;
const LAUNCH_IDENTITY_INDEX_SCHEMA_VERSION: u16 = 1;
const INDEX_SHARDS: usize = 256;
const MAX_SHARD_RECORDS: usize = 8_192;
const MAX_SHARD_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SuccessorIndexShard {
    schema_version: u16,
    records: BTreeMap<String, ManagedRehostResolution>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchIdentityIndexShard {
    schema_version: u16,
    records: BTreeMap<String, LaunchIdentityRecord>,
}

impl Default for LaunchIdentityIndexShard {
    fn default() -> Self {
        Self {
            schema_version: LAUNCH_IDENTITY_INDEX_SCHEMA_VERSION,
            records: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchIdentityRecord {
    schema_version: u16,
    source_workspace_id: String,
    source_session_id: String,
    lineage_fingerprint: String,
    launch_identity: ManagedRehostLaunchIdentity,
}

impl LaunchIdentityRecord {
    fn from_resolution(resolution: &ManagedRehostResolution) -> Result<Option<Self>, String> {
        validate_direct_resolution(resolution)?;
        let Some(launch_identity) = resolution.launch_identity() else {
            return Ok(None);
        };
        Ok(Some(Self {
            schema_version: LAUNCH_IDENTITY_INDEX_SCHEMA_VERSION,
            source_workspace_id: resolution.source_generation().workspace_id().to_string(),
            source_session_id: resolution.source_generation().session_id().to_string(),
            lineage_fingerprint: lineage_fingerprint(resolution)?,
            launch_identity: launch_identity.clone(),
        }))
    }

    fn validate(&self) -> Result<(), String> {
        validate_lookup_identity(&self.source_workspace_id, &self.source_session_id)?;
        self.launch_identity
            .validate()
            .map_err(|error| format!("hmux_managed_rehost_successor_index_invalid: {error}"))?;
        if self.schema_version != LAUNCH_IDENTITY_INDEX_SCHEMA_VERSION
            || self.lineage_fingerprint.len() != 64
            || !self
                .lineage_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(
                "hmux_managed_rehost_successor_index_invalid: launch identity record is malformed"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn merge_into(&self, resolution: &mut ManagedRehostResolution) -> Result<(), String> {
        self.validate()?;
        validate_direct_resolution(resolution)?;
        if resolution.source_generation().workspace_id() != self.source_workspace_id
            || resolution.source_generation().session_id() != self.source_session_id
            || lineage_fingerprint(resolution)? != self.lineage_fingerprint
        {
            return Err(
                "hmux_managed_rehost_resolution_conflict: launch identity changed durable lineage"
                    .to_string(),
            );
        }
        resolution
            .merge_launch_identity(&self.launch_identity)
            .map(|_| ())
            .map_err(|_| {
                "hmux_managed_rehost_resolution_conflict: launch identity changed".to_string()
            })
    }
}

fn lineage_fingerprint(resolution: &ManagedRehostResolution) -> Result<String, String> {
    validate_direct_resolution(resolution)?;
    let source = resolution.source_generation();
    let current = resolution.current_generation();
    let permission_mode = match resolution.permission_mode() {
        PermissionMode::Default => "default",
        PermissionMode::BypassApprovals => "bypass_approvals",
    };
    Ok(request_fingerprint(&[
        "managed-rehost-launch-lineage-v1",
        &resolution.operation_ids()[0],
        source.session_id(),
        source.workspace_id(),
        source.runner_principal(),
        source.runner_instance(),
        source.channel_epoch(),
        source.host_instance_id(),
        source.terminal_epoch(),
        current.session_id(),
        current.workspace_id(),
        current.runner_principal(),
        current.runner_instance(),
        current.channel_epoch(),
        current.host_instance_id(),
        current.terminal_epoch(),
        resolution.provider_id(),
        permission_mode,
    ]))
}

impl Default for SuccessorIndexShard {
    fn default() -> Self {
        Self {
            schema_version: INDEX_SCHEMA_VERSION,
            records: BTreeMap::new(),
        }
    }
}

/// Publishes one immutable direct successor edge. The exact lineage and launch
/// identity use separate shard prefixes: older v1 lineage writers can rewrite
/// their shared shard without erasing a launch identity they do not understand.
///
/// The recovery-journal admission lock is held by every caller. The completed
/// journal record is always durable before this function runs, and GC refuses
/// to retire that record until this publication succeeds. Therefore a crash
/// before rename leaves the journal authoritative; a crash after rename leaves
/// both authorities agreeing.
pub(super) fn publish(
    recovery_directory: &Path,
    resolution: &ManagedRehostResolution,
) -> Result<(), String> {
    publish_launch_identity(recovery_directory, resolution)?;
    publish_lineage(recovery_directory, resolution)
}

/// Publishes the launch coordinate before a completed journal record becomes
/// visible. An old collector may later compact the v1 lineage, but it cannot
/// consume the only copy of a new launch identity across that crash cut.
pub(super) fn publish_launch_identity(
    recovery_directory: &Path,
    resolution: &ManagedRehostResolution,
) -> Result<(), String> {
    preflight_lineage(recovery_directory, resolution)?;
    let Some(record) = LaunchIdentityRecord::from_resolution(resolution)? else {
        return Ok(());
    };
    let directory = index_directory(recovery_directory)?;
    ensure_private_directory(&directory)?;
    let key = resolution_key(
        resolution.source_generation().workspace_id(),
        resolution.source_generation().session_id(),
    );
    let index = shard_index(&key)?;
    let path = launch_shard_path(&directory, index);
    let mut shard: LaunchIdentityIndexShard = read_shard_or_default(&path)?;
    validate_launch_identity_shard(&shard, index)?;
    if let Some(existing) = shard.records.get(&key) {
        return if existing == &record {
            Ok(())
        } else {
            Err(
                "hmux_managed_rehost_successor_index_conflict: source has another exact launch identity"
                    .to_string(),
            )
        };
    }
    if shard.records.len() >= MAX_SHARD_RECORDS {
        return Err(format!(
            "hmux_managed_rehost_successor_index_capacity: launch shard reached {MAX_SHARD_RECORDS} sources"
        ));
    }
    shard.records.insert(key, record);
    write_launch_identity_shard(&directory, &path, &shard)
}

fn preflight_lineage(
    recovery_directory: &Path,
    resolution: &ManagedRehostResolution,
) -> Result<(), String> {
    validate_direct_resolution(resolution)?;
    let expected = resolution.lineage_projection();
    let directory = index_directory(recovery_directory)?;
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(
                "hmux_managed_rehost_successor_index_invalid: directory is unreadable".to_string(),
            );
        }
        Ok(_) => validate_existing_private_directory(&directory)?,
    }
    let key = resolution_key(
        resolution.source_generation().workspace_id(),
        resolution.source_generation().session_id(),
    );
    let index = shard_index(&key)?;
    let path = shard_path(&directory, index);
    if !private_path_exists(&path)? {
        return Ok(());
    }
    let shard: SuccessorIndexShard = read_shard_or_default(&path)?;
    validate_successor_shard(&shard, index)?;
    if shard
        .records
        .get(&key)
        .is_some_and(|existing| existing != &expected)
    {
        return Err(
            "hmux_managed_rehost_successor_index_conflict: source has another exact successor"
                .to_string(),
        );
    }
    Ok(())
}

fn publish_lineage(
    recovery_directory: &Path,
    resolution: &ManagedRehostResolution,
) -> Result<(), String> {
    validate_direct_resolution(resolution)?;
    let resolution = resolution.lineage_projection();
    let directory = index_directory(recovery_directory)?;
    ensure_private_directory(&directory)?;
    let key = resolution_key(
        resolution.source_generation().workspace_id(),
        resolution.source_generation().session_id(),
    );
    let index = shard_index(&key)?;
    let path = shard_path(&directory, index);
    let mut shard: SuccessorIndexShard = read_shard_or_default(&path)?;
    validate_successor_shard(&shard, index)?;
    if let Some(existing) = shard.records.get(&key) {
        return if existing == &resolution {
            Ok(())
        } else {
            Err(
                "hmux_managed_rehost_successor_index_conflict: source has another exact successor"
                    .to_string(),
            )
        };
    }
    if shard.records.len() >= MAX_SHARD_RECORDS {
        return Err(format!(
            "hmux_managed_rehost_successor_index_capacity: shard reached {MAX_SHARD_RECORDS} sources"
        ));
    }
    shard.records.insert(key, resolution);
    write_successor_shard(&directory, &path, &shard)
}

/// Reads one exact direct edge without creating index state.
pub(super) fn lookup(
    recovery_directory: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<Option<ManagedRehostResolution>, String> {
    let Some(mut lineage) = lookup_lineage(recovery_directory, workspace_id, session_id)? else {
        return if lookup_launch_identity(recovery_directory, workspace_id, session_id)?.is_some() {
            Err(
                "hmux_managed_rehost_resolution_conflict: launch identity has no durable lineage"
                    .to_string(),
            )
        } else {
            Ok(None)
        };
    };
    merge_launch_identity(recovery_directory, &mut lineage)?;
    Ok(Some(lineage))
}

pub(super) fn merge_launch_identity(
    recovery_directory: &Path,
    resolution: &mut ManagedRehostResolution,
) -> Result<(), String> {
    validate_direct_resolution(resolution)?;
    let Some(record) = lookup_launch_identity(
        recovery_directory,
        resolution.source_generation().workspace_id(),
        resolution.source_generation().session_id(),
    )?
    else {
        return Ok(());
    };
    record.merge_into(resolution)
}

pub(super) fn lookup_lineage(
    recovery_directory: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<Option<ManagedRehostResolution>, String> {
    validate_lookup_identity(workspace_id, session_id)?;
    let directory = index_directory(recovery_directory)?;
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(
                "hmux_managed_rehost_successor_index_invalid: directory is unreadable".to_string(),
            );
        }
        Ok(_) => validate_existing_private_directory(&directory)?,
    }
    let key = resolution_key(workspace_id, session_id);
    let index = shard_index(&key)?;
    let path = shard_path(&directory, index);
    if !private_path_exists(&path)? {
        return Ok(None);
    }
    let shard: SuccessorIndexShard = read_shard_or_default(&path)?;
    validate_successor_shard(&shard, index)?;
    Ok(shard.records.get(&key).cloned())
}

/// Cold resource ancestry lookup over the existing immutable forward index.
/// No reverse cache or second publication authority is introduced. The caller
/// holds the recovery admission lock and rechecks the selected direct edge.
pub(super) fn predecessor(
    recovery_directory: &Path,
    target: &super::ManagedCreateReceipt,
) -> Result<Option<ManagedRehostResolution>, String> {
    let directory = index_directory(recovery_directory)?;
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(
                "hmux_managed_rehost_successor_index_invalid: directory is unreadable".into(),
            );
        }
        Ok(_) => validate_existing_private_directory(&directory)?,
    }
    let mut found = None;
    for index in 0..INDEX_SHARDS {
        let shard: SuccessorIndexShard = read_shard_or_default(&shard_path(&directory, index))?;
        validate_successor_shard(&shard, index)?;
        for edge in shard.records.into_values() {
            if super::managed_rehost_observation::matches_rehost_target(&edge, target) {
                if found.is_some() {
                    return Err(
                        "hmux_managed_rehost_resolution_conflict: target has multiple predecessors"
                            .into(),
                    );
                }
                found = Some(edge);
            }
        }
    }
    Ok(found)
}

fn lookup_launch_identity(
    recovery_directory: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<Option<LaunchIdentityRecord>, String> {
    validate_lookup_identity(workspace_id, session_id)?;
    let directory = index_directory(recovery_directory)?;
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(
                "hmux_managed_rehost_successor_index_invalid: directory is unreadable".to_string(),
            );
        }
        Ok(_) => validate_existing_private_directory(&directory)?,
    }
    let key = resolution_key(workspace_id, session_id);
    let index = shard_index(&key)?;
    let launch_path = launch_shard_path(&directory, index);
    if !private_path_exists(&launch_path)? {
        return Ok(None);
    }
    let launch_shard: LaunchIdentityIndexShard = read_shard_or_default(&launch_path)?;
    validate_launch_identity_shard(&launch_shard, index)?;
    Ok(launch_shard.records.get(&key).cloned())
}

fn index_directory(recovery_directory: &Path) -> Result<PathBuf, String> {
    if recovery_directory
        .file_name()
        .and_then(|name| name.to_str())
        != Some(".recovery")
    {
        return Err(
            "hmux_managed_rehost_successor_index_invalid: recovery root changed".to_string(),
        );
    }
    recovery_directory
        .parent()
        .map(|root| root.join(INDEX_DIRECTORY))
        .ok_or_else(|| {
            "hmux_managed_rehost_successor_index_invalid: discovery root is missing".to_string()
        })
}

fn resolution_key(workspace_id: &str, session_id: &str) -> String {
    digest(&format!(
        "managed-rehost-successor-v1\0{workspace_id}\0{session_id}"
    ))
}

fn shard_index(key: &str) -> Result<usize, String> {
    let prefix = key.get(..2).ok_or_else(|| {
        "hmux_managed_rehost_successor_index_invalid: record key is malformed".to_string()
    })?;
    let index = usize::from_str_radix(prefix, 16).map_err(|_| {
        "hmux_managed_rehost_successor_index_invalid: record key is malformed".to_string()
    })?;
    if index >= INDEX_SHARDS {
        return Err(
            "hmux_managed_rehost_successor_index_invalid: shard is out of range".to_string(),
        );
    }
    Ok(index)
}

fn shard_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("shard_{index:02x}.json"))
}

fn launch_shard_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("launch_shard_{index:02x}.json"))
}

fn validate_lookup_identity(workspace_id: &str, session_id: &str) -> Result<(), String> {
    let valid = |value: &str| {
        !value.is_empty() && value.len() <= 4_096 && !value.chars().any(char::is_control)
    };
    if !valid(workspace_id) || !valid(session_id) {
        return Err(
            "hmux_managed_rehost_successor_index_invalid: source identity is malformed".to_string(),
        );
    }
    Ok(())
}

fn validate_direct_resolution(resolution: &ManagedRehostResolution) -> Result<(), String> {
    resolution
        .validate()
        .map_err(|error| format!("hmux_managed_rehost_successor_index_invalid: {error}"))?;
    validate_lookup_identity(
        resolution.source_generation().workspace_id(),
        resolution.source_generation().session_id(),
    )?;
    if resolution.operation_ids().len() != 1 {
        return Err(
            "hmux_managed_rehost_successor_index_invalid: record is not one direct edge"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_successor_shard(
    shard: &SuccessorIndexShard,
    expected_index: usize,
) -> Result<(), String> {
    if shard.schema_version != INDEX_SCHEMA_VERSION || shard.records.len() > MAX_SHARD_RECORDS {
        return Err(
            "hmux_managed_rehost_successor_index_invalid: shard schema or capacity changed"
                .to_string(),
        );
    }
    for (key, resolution) in &shard.records {
        validate_direct_resolution(resolution)?;
        if resolution.launch_identity().is_some() {
            return Err(
                "hmux_managed_rehost_successor_index_invalid: v1 lineage contains launch identity"
                    .to_string(),
            );
        }
        if resolution_key(
            resolution.source_generation().workspace_id(),
            resolution.source_generation().session_id(),
        ) != *key
            || shard_index(key)? != expected_index
        {
            return Err(
                "hmux_managed_rehost_successor_index_invalid: shard record identity changed"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn validate_launch_identity_shard(
    shard: &LaunchIdentityIndexShard,
    expected_index: usize,
) -> Result<(), String> {
    if shard.schema_version != LAUNCH_IDENTITY_INDEX_SCHEMA_VERSION
        || shard.records.len() > MAX_SHARD_RECORDS
    {
        return Err(
            "hmux_managed_rehost_successor_index_invalid: launch shard schema or capacity changed"
                .to_string(),
        );
    }
    for (key, record) in &shard.records {
        record.validate()?;
        if resolution_key(&record.source_workspace_id, &record.source_session_id) != *key
            || shard_index(key)? != expected_index
        {
            return Err(
                "hmux_managed_rehost_successor_index_invalid: launch shard record identity changed"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn read_shard_or_default<T: Default + DeserializeOwned>(path: &Path) -> Result<T, String> {
    super::private_json_shard::read_or_default(
        path,
        MAX_SHARD_BYTES,
        "hmux_managed_rehost_successor_index",
    )
}

fn write_successor_shard(
    directory: &Path,
    path: &Path,
    shard: &SuccessorIndexShard,
) -> Result<(), String> {
    validate_successor_shard(shard, shard_index_from_path(path, "shard_")?)?;
    write_shard(directory, path, shard)
}

fn write_launch_identity_shard(
    directory: &Path,
    path: &Path,
    shard: &LaunchIdentityIndexShard,
) -> Result<(), String> {
    validate_launch_identity_shard(shard, shard_index_from_path(path, "launch_shard_")?)?;
    write_shard(directory, path, shard)
}

fn write_shard<T: Serialize>(directory: &Path, path: &Path, shard: &T) -> Result<(), String> {
    super::private_json_shard::write(
        directory,
        path,
        shard,
        MAX_SHARD_BYTES,
        "hmux_managed_rehost_successor_index",
    )
}

fn shard_index_from_path(path: &Path, prefix: &str) -> Result<usize, String> {
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            "hmux_managed_rehost_successor_index_invalid: shard path is malformed".to_string()
        })?;
    let prefix = name.strip_prefix(prefix).ok_or_else(|| {
        "hmux_managed_rehost_successor_index_invalid: shard path is malformed".to_string()
    })?;
    usize::from_str_radix(prefix, 16).map_err(|_| {
        "hmux_managed_rehost_successor_index_invalid: shard path is malformed".to_string()
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::recovery_journal::open_private_new;
    use hmux_runtime_contract::{
        ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt,
        ManagedStopOutcome, ManagedStopReceipt, ManagedStopRequest, PermissionMode,
    };
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    fn resolution(root: &Path) -> ManagedRehostResolution {
        named_resolution(root, "source-1", "replacement-1", "operation-1", None)
    }

    fn named_resolution(
        root: &Path,
        source_session_id: &str,
        replacement_session_id: &str,
        operation_id: &str,
        launch_identity: Option<ManagedRehostLaunchIdentity>,
    ) -> ManagedRehostResolution {
        let source = ManagedStopReceipt::from_request(
            &ManagedStopRequest::new(
                format!("stop-{source_session_id}"),
                source_session_id,
                "workspace-1",
            )
            .unwrap()
            .with_expected_fence(
                "principal-source",
                "runner-source",
                u64::MAX,
                "host-source",
                "terminal-source",
            )
            .unwrap(),
            ManagedStopOutcome::Stopped,
            "managed source stopped",
        )
        .unwrap();
        let replacement = ManagedCreateReceipt::new(
            format!("create-{replacement_session_id}"),
            replacement_session_id,
            "workspace-1",
            "codex",
            PermissionMode::Default,
            root,
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new(
                "principal-replacement",
                "runner-replacement",
                u64::MAX,
                "host-replacement",
                "terminal-replacement",
            )
            .unwrap(),
        )
        .unwrap();
        ManagedRehostResolution::from_receipts_with_launch_identity(
            operation_id,
            &source,
            &replacement,
            launch_identity,
        )
        .unwrap()
    }

    #[test]
    fn torn_temporary_recovers_but_a_malformed_published_shard_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let recovery = temp.path().join(".recovery");
        ensure_private_directory(&recovery).unwrap();
        let edge = resolution(temp.path());
        let directory = index_directory(&recovery).unwrap();
        ensure_private_directory(&directory).unwrap();
        let key = resolution_key("workspace-1", "source-1");
        let path = shard_path(&directory, shard_index(&key).unwrap());
        let temporary = directory.join(format!(
            ".{}.tmp",
            path.file_stem().unwrap().to_string_lossy()
        ));
        let mut partial = open_private_new(&temporary).unwrap();
        partial.write_all(b"partial shard").unwrap();
        partial.sync_all().unwrap();
        drop(partial);

        publish(&recovery, &edge).unwrap();
        assert!(!temporary.exists());
        assert_eq!(
            lookup(&recovery, "workspace-1", "source-1").unwrap(),
            Some(edge)
        );

        fs::write(&path, b"{").unwrap();
        let error = lookup(&recovery, "workspace-1", "source-1").unwrap_err();
        assert!(error.contains("shard is malformed"), "{error}");
    }

    #[test]
    fn launch_overlay_survives_overlay_first_cut_and_legacy_lineage_rewrite() {
        let temp = tempfile::tempdir().unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let recovery = temp.path().join(".recovery");
        ensure_private_directory(&recovery).unwrap();
        let identity = ManagedRehostLaunchIdentity::new(
            Some("credential+profile".into()),
            Some("conversation-current".into()),
        )
        .unwrap();
        let edge = named_resolution(
            temp.path(),
            "source-overlay",
            "replacement-overlay",
            "operation-overlay",
            Some(identity.clone()),
        );

        publish_launch_identity(&recovery, &edge).unwrap();
        let error = lookup(&recovery, "workspace-1", "source-overlay").unwrap_err();
        assert!(error.contains("no durable lineage"), "{error}");
        publish_lineage(&recovery, &edge).unwrap();
        assert_eq!(
            lookup(&recovery, "workspace-1", "source-overlay")
                .unwrap()
                .and_then(|resolution| resolution.launch_identity().cloned()),
            Some(identity.clone())
        );

        let directory = index_directory(&recovery).unwrap();
        let key = resolution_key("workspace-1", "source-overlay");
        let index = shard_index(&key).unwrap();
        let lineage_payload = fs::read_to_string(shard_path(&directory, index)).unwrap();
        assert!(
            !lineage_payload.contains("launchIdentity"),
            "the old-writer v1 shard must retain its original wire shape"
        );

        let same_shard_source = (0..10_000)
            .map(|candidate| format!("legacy-source-{candidate}"))
            .find(|candidate| {
                shard_index(&resolution_key("workspace-1", candidate)).unwrap() == index
            })
            .unwrap();
        let legacy = named_resolution(
            temp.path(),
            &same_shard_source,
            "legacy-replacement",
            "legacy-operation",
            None,
        );
        publish(&recovery, &legacy).unwrap();

        assert_eq!(
            lookup(&recovery, "workspace-1", "source-overlay")
                .unwrap()
                .and_then(|resolution| resolution.launch_identity().cloned()),
            Some(identity),
            "a v1 whole-shard rewrite must not erase the separate launch authority"
        );
    }
}
