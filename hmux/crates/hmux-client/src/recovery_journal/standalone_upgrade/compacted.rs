use super::{
    CompletedStandaloneUpgrade, StandaloneUpgradeOperation, StandaloneUpgradeProgress,
    StandaloneUpgradeSuccessor,
    cancellation::{self, CancelledUpgrade},
    completed_launch,
};
use crate::recovery_journal::{self as journal, RecoveryRecord, private_json_shard};
use crate::{
    ExitedSessionRetirementGeneration, LocalSessionCatalog, ProcessDescriptor,
    StandaloneCreateRequest, StandaloneReplacementSource,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

const DIRECTORY: &str = ".standalone-upgrade-completions-v1";
const CONTEXT: &str = "hmux_standalone_upgrade_index";
const MAX_RECORDS: usize = 8_192;
const MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Completion {
    recovery_id: String,
    request_fingerprint: String,
    action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation_root: Option<PathBuf>,
    source: StandaloneReplacementSource,
    source_build_id: String,
    successor: StandaloneUpgradeSuccessor,
    launch: Option<StandaloneCreateRequest>,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Entry {
    Completion(Box<Completion>),
    Cancelled(Box<CancelledUpgrade>),
    Source { operation: String },
    Target { operation: String },
    Imports { roots: BTreeSet<PathBuf> },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Shard {
    schema_version: u16,
    records: BTreeMap<String, Entry>,
}

impl Default for Shard {
    fn default() -> Self {
        Self {
            schema_version: 1,
            records: BTreeMap::new(),
        }
    }
}

fn directory(recovery: &Path) -> Result<PathBuf, String> {
    recovery
        .parent()
        .map(|root| root.join(DIRECTORY))
        .ok_or_else(|| format!("{CONTEXT}_invalid: discovery root is missing"))
}

fn operation_key(id: &str) -> String {
    journal::request_fingerprint(&["standalone-upgrade-completion-v1", id])
}

fn imports_key(id: &str) -> String {
    journal::request_fingerprint(&["standalone-upgrade-imports-v1", id])
}

fn imported_operation_key(root: &Path, id: &str) -> Result<String, String> {
    let root = serde_json::to_string(root).map_err(|error| error.to_string())?;
    Ok(journal::request_fingerprint(&[
        "standalone-upgrade-import-v1",
        &root,
        id,
    ]))
}

impl Completion {
    fn matches_key(&self, key: &str) -> Result<bool, String> {
        match &self.operation_root {
            Some(root) => Ok(imported_operation_key(root, &self.recovery_id)? == key),
            None => Ok(operation_key(&self.recovery_id) == key),
        }
    }
}

fn generation_key(
    kind: &str,
    generation: &ExitedSessionRetirementGeneration,
    provider: &ProcessDescriptor,
) -> Result<String, String> {
    let encoded =
        serde_json::to_string(&(generation, provider)).map_err(|error| error.to_string())?;
    Ok(journal::request_fingerprint(&[kind, &encoded]))
}

fn shard_path(directory: &Path, key: &str) -> Result<PathBuf, String> {
    if key.len() != 64
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{CONTEXT}_invalid: record key is malformed"));
    }
    Ok(directory.join(format!("shard_{}.json", &key[..2])))
}

fn read_shard(path: &Path) -> Result<Shard, String> {
    let shard: Shard = private_json_shard::read_or_default(path, MAX_BYTES, CONTEXT)?;
    if shard.schema_version != 1 || shard.records.len() > MAX_RECORDS {
        return Err(format!(
            "{CONTEXT}_invalid: shard schema or capacity changed"
        ));
    }
    for (key, entry) in &shard.records {
        if shard_path(path.parent().unwrap(), key)? != path {
            return Err(format!(
                "{CONTEXT}_invalid: record belongs to another shard"
            ));
        }
        let relative_root = match entry {
            Entry::Completion(completed) => completed
                .operation_root
                .as_ref()
                .is_some_and(|root| !root.is_absolute()),
            Entry::Imports { roots } => roots.iter().any(|root| !root.is_absolute()),
            _ => false,
        };
        if relative_root {
            return Err(format!(
                "{CONTEXT}_invalid: original operation namespace is relative"
            ));
        }
    }
    Ok(shard)
}

fn read(recovery: &Path, key: &str) -> Result<Option<Entry>, String> {
    let directory = directory(recovery)?;
    if !journal::private_directory_exists(&directory)? {
        return Ok(None);
    }
    Ok(read_shard(&shard_path(&directory, key)?)?
        .records
        .remove(key))
}

fn completion(recovery: &Path, operation: &str) -> Result<Completion, String> {
    let Some(Entry::Completion(completion)) = read(recovery, operation)? else {
        return Err(format!(
            "{CONTEXT}_invalid: locator has no completed target"
        ));
    };
    if !completion.matches_key(operation)? {
        return Err(format!("{CONTEXT}_invalid: operation identity changed"));
    }
    Ok(*completion)
}

/// Imported IDs locate originals only when this namespace has no own operation.
/// This immutable index can name several distinct roots without restricting
/// valid publication; an ID-only caller must then resolve its ambiguity.
pub(super) fn imported_operation_roots(
    recovery: &Path,
    recovery_id: &str,
) -> Result<BTreeSet<PathBuf>, String> {
    match read(recovery, &imports_key(recovery_id))? {
        Some(Entry::Imports { roots }) => Ok(roots),
        None => Ok(BTreeSet::new()),
        _ => Err(format!("{CONTEXT}_invalid: operation imports changed")),
    }
}

pub(super) fn source_operation_root(
    recovery: &Path,
    source: &ExitedSessionRetirementGeneration,
    provider: &ProcessDescriptor,
) -> Result<Option<PathBuf>, String> {
    let key = generation_key("standalone-upgrade-source-v1", source, provider)?;
    let Some(Entry::Source { operation }) = read(recovery, &key)? else {
        return Ok(None);
    };
    let Some(Entry::Completion(completed)) = read(recovery, &operation)? else {
        // Partial publication can leave a locator while the original journal
        // is still Reserved. Its admitted reader decides that lifecycle.
        return Ok(None);
    };
    if !completed.matches_key(&operation)?
        || completed.source.generation() != source
        || completed.source.provider_process() != provider
    {
        return Err(format!("{CONTEXT}_invalid: source generation changed"));
    }
    Ok(completed.operation_root)
}

pub(super) fn read_completed(
    recovery: &Path,
    recovery_id: &str,
    action: &str,
) -> Result<Option<StandaloneUpgradeOperation>, String> {
    let Some(entry) = read(recovery, &operation_key(recovery_id))? else {
        return Ok(None);
    };
    if let Entry::Cancelled(cancelled) = &entry {
        if cancelled.recovery_id != recovery_id || cancelled.action != action {
            return Err("hmux_recovery_idempotency_conflict: upgrade identity differs".into());
        }
        return Ok(Some(StandaloneUpgradeOperation::Cancelled));
    }
    let Entry::Completion(completed) = entry else {
        return Err(format!(
            "{CONTEXT}_invalid: operation has no completed target"
        ));
    };
    if completed.recovery_id != recovery_id || completed.action != action {
        return Err("hmux_recovery_idempotency_conflict: upgrade identity differs".into());
    }
    Ok(Some(StandaloneUpgradeOperation::Rehosted(Box::new(
        CompletedStandaloneUpgrade {
            source: completed.source,
            source_build_id: completed.source_build_id,
            successor: completed.successor,
        },
    ))))
}

pub(super) fn cancelled(
    recovery: &Path,
    recovery_id: &str,
) -> Result<Option<CancelledUpgrade>, String> {
    match read(recovery, &operation_key(recovery_id))? {
        Some(Entry::Cancelled(fact)) if fact.recovery_id == recovery_id => Ok(Some(*fact)),
        Some(Entry::Cancelled(_)) => Err(format!("{CONTEXT}_invalid: operation identity changed")),
        _ => Ok(None),
    }
}

pub(in crate::recovery_journal) fn refuse_new_operation(
    recovery: &Path,
    recovery_id: &str,
) -> Result<(), String> {
    if read(recovery, &operation_key(recovery_id))?.is_some() {
        return Err(
            "hmux_recovery_idempotency_conflict: upgrade operation is already completed".into(),
        );
    }
    Ok(())
}

fn merge(existing: &Entry, proposed: &Entry) -> Result<Entry, String> {
    if let (Entry::Imports { roots: existing }, Entry::Imports { roots: proposed }) =
        (existing, proposed)
    {
        return Ok(Entry::Imports {
            roots: existing.union(proposed).cloned().collect(),
        });
    }
    if let (Entry::Completion(existing), Entry::Completion(proposed)) = (existing, proposed) {
        let mut proposed = proposed.clone();
        // Exact retirement permanently drops launch inputs. Re-publishing a
        // still-retained journal must never restore those obsolete inputs.
        if existing.launch.is_none() {
            proposed.launch = None;
        }
        if existing == &proposed {
            return Ok(Entry::Completion(proposed));
        }
    } else if existing == proposed {
        return Ok(existing.clone());
    }
    Err(format!("{CONTEXT}_conflict: completed lineage changed"))
}

/// The journal admission lock is held by the caller. Publish all compact facts
/// before exposing Completed, so even an older collector cannot erase them.
/// The locators contain no independent lifecycle or launch authority.
pub(super) fn publish(recovery: &Path, record: &RecoveryRecord) -> Result<(), String> {
    if let Some(cancelled) = cancellation::completed(record)? {
        let source_key = generation_key(
            "standalone-upgrade-source-v1",
            cancelled.source.generation(),
            cancelled.source.provider_process(),
        )?;
        let operation = operation_key(&record.recovery_id);
        return publish_entries(
            recovery,
            [
                (operation.clone(), Entry::Cancelled(Box::new(cancelled))),
                (source_key, Entry::Source { operation }),
            ],
        );
    }
    let catalog = LocalSessionCatalog::new(
        recovery
            .parent()
            .ok_or_else(|| format!("{CONTEXT}_invalid: recovery root is missing"))?,
    );
    let Some((prepared, target)) = completed_launch(&catalog, record)? else {
        return Ok(());
    };
    let request = prepared.replacement.unwrap().create;
    let successor = StandaloneUpgradeSuccessor::from_launch(&request, target)?;
    let target_root = successor.target.receipt().discovery_root().to_path_buf();
    let source_key = generation_key(
        "standalone-upgrade-source-v1",
        prepared.source.generation(),
        prepared.source.provider_process(),
    )?;
    let target_key = generation_key(
        "standalone-upgrade-target-v1",
        successor.target.generation(),
        successor.target.provider_process(),
    )?;
    let fact = Completion {
        recovery_id: record.recovery_id.clone(),
        request_fingerprint: record.request_fingerprint.clone(),
        action: record.action.clone(),
        operation_root: None,
        source: prepared.source,
        source_build_id: prepared.source_build_id,
        successor,
        launch: Some(request),
    };
    let entries = |operation: String, fact: Completion| {
        [
            (operation.clone(), Entry::Completion(Box::new(fact))),
            (
                source_key.clone(),
                Entry::Source {
                    operation: operation.clone(),
                },
            ),
            (target_key.clone(), Entry::Target { operation }),
        ]
    };
    if target_root != catalog.discovery_root() {
        // A later upgrader discovers this immutable launch through the target's
        // own namespace. The original source journal remains the only mutable
        // operation; this is the same compact history, not another reservation.
        let target_recovery = target_root.join(".recovery");
        journal::ensure_private_directory(&target_recovery)?;
        // Completion already owns the source journal. Opposite-direction
        // upgrades must not wait on each other's journal while holding it.
        let _target_admission = journal::RecoveryLock::try_acquire_for_maintenance(
            journal::open_private_lock(&target_recovery.join(journal::ADMISSION_LOCK_NAME))?,
        )?
        .ok_or_else(|| {
            "hmux_recovery_busy: target launch history is currently admitted".to_string()
        })?;
        let mut imported = fact.clone();
        imported.operation_root = Some(catalog.discovery_root().to_path_buf());
        publish_entries(
            &target_recovery,
            entries(
                imported_operation_key(catalog.discovery_root(), &record.recovery_id)?,
                imported,
            )
            .into_iter()
            .chain(std::iter::once((
                imports_key(&record.recovery_id),
                Entry::Imports {
                    roots: BTreeSet::from([catalog.discovery_root().to_path_buf()]),
                },
            ))),
        )?;
    }
    publish_entries(recovery, entries(operation_key(&record.recovery_id), fact))
}

fn publish_entries(
    recovery: &Path,
    entries: impl IntoIterator<Item = (String, Entry)>,
) -> Result<(), String> {
    let directory = directory(recovery)?;
    journal::ensure_private_directory(&directory)?;
    let mut shards = BTreeMap::<PathBuf, Shard>::new();
    for (key, entry) in entries {
        let path = shard_path(&directory, &key)?;
        if !shards.contains_key(&path) {
            shards.insert(path.clone(), read_shard(&path)?);
        }
        let shard = shards.get_mut(&path).unwrap();
        let entry = match shard.records.get(&key) {
            Some(existing) => merge(existing, &entry)?,
            None => entry,
        };
        shard.records.insert(key, entry);
    }
    // Preflight every affected shard before the first publish. A crash can
    // leave a partial index only while the original journal remains Reserved.
    for shard in shards.values() {
        if shard.records.len() > MAX_RECORDS
            || serde_json::to_vec(shard)
                .map_err(|error| error.to_string())?
                .len() as u64
                > MAX_BYTES
        {
            return Err(format!("{CONTEXT}_capacity: shard is full"));
        }
    }
    for (path, shard) in shards {
        private_json_shard::write(&directory, &path, &shard, MAX_BYTES, CONTEXT)?;
    }
    Ok(())
}

pub(super) fn successor(
    recovery: &Path,
    source: &ExitedSessionRetirementGeneration,
    provider: &ProcessDescriptor,
) -> Result<Option<StandaloneUpgradeProgress>, String> {
    let key = generation_key("standalone-upgrade-source-v1", source, provider)?;
    let Some(entry) = read(recovery, &key)? else {
        return Ok(None);
    };
    let Entry::Source { operation } = entry else {
        return Err(format!("{CONTEXT}_invalid: source locator changed"));
    };
    if let Some(Entry::Cancelled(cancelled)) = read(recovery, &operation)? {
        if operation_key(&cancelled.recovery_id) != operation
            || cancelled.source.generation() != source
            || cancelled.source.provider_process() != provider
        {
            return Err(format!(
                "{CONTEXT}_invalid: cancelled source generation changed"
            ));
        }
        return Ok(Some(StandaloneUpgradeProgress::Cancelled));
    }
    let completed = completion(recovery, &operation)?;
    if completed.source.generation() != source || completed.source.provider_process() != provider {
        return Err(format!("{CONTEXT}_invalid: source generation changed"));
    }
    Ok(Some(StandaloneUpgradeProgress::Completed(Box::new(
        completed.successor,
    ))))
}

fn target(
    recovery: &Path,
    generation: &ExitedSessionRetirementGeneration,
    provider: &ProcessDescriptor,
) -> Result<Option<(String, Completion)>, String> {
    let key = generation_key("standalone-upgrade-target-v1", generation, provider)?;
    let Some(entry) = read(recovery, &key)? else {
        return Ok(None);
    };
    let Entry::Target { operation } = entry else {
        return Err(format!("{CONTEXT}_invalid: target locator changed"));
    };
    let completed = completion(recovery, &operation)?;
    if completed.successor.target.generation() != generation
        || completed.successor.target.provider_process() != provider
    {
        return Err(format!("{CONTEXT}_invalid: target generation changed"));
    }
    Ok(Some((operation, completed)))
}

pub(super) fn launch(
    recovery: &Path,
    generation: &ExitedSessionRetirementGeneration,
    provider: &ProcessDescriptor,
) -> Result<Option<StandaloneCreateRequest>, String> {
    let Some((_, completed)) = target(recovery, generation, provider)? else {
        return Ok(None);
    };
    if let Some(request) = &completed.launch {
        request.validate().map_err(|error| error.to_string())?;
        let observed =
            StandaloneUpgradeSuccessor::from_launch(request, completed.successor.target.clone())?;
        if observed != completed.successor {
            return Err(format!(
                "{CONTEXT}_invalid: retained launch changed identity"
            ));
        }
    }
    Ok(completed.launch)
}

/// Called only after the existing exact retirement authority has proved this
/// target retired. Keep the compact edge for delayed owners, drop full inputs.
pub(super) fn retire_launch(
    recovery: &Path,
    generation: &ExitedSessionRetirementGeneration,
    provider: &ProcessDescriptor,
) -> Result<Option<PathBuf>, String> {
    let Some((operation, mut completed)) = target(recovery, generation, provider)? else {
        return Ok(None);
    };
    let operation_root = completed.operation_root.clone().unwrap_or(
        recovery
            .parent()
            .ok_or_else(|| format!("{CONTEXT}_invalid: discovery root is missing"))?
            .to_path_buf(),
    );
    if completed.launch.take().is_none() {
        return Ok(Some(operation_root));
    }
    let directory = directory(recovery)?;
    let path = shard_path(&directory, &operation)?;
    let mut shard = read_shard(&path)?;
    shard
        .records
        .insert(operation, Entry::Completion(Box::new(completed)));
    private_json_shard::write(&directory, &path, &shard, MAX_BYTES, CONTEXT)?;
    Ok(Some(operation_root))
}
