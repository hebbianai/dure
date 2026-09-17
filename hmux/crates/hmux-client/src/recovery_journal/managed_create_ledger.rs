use super::{
    MAX_RECORD_BYTES, RecoveryLock, digest, ensure_private_directory, ensure_same_open_file,
    open_private_existing, open_private_lock, open_private_new, private_path_exists,
    replace_private_file, request_fingerprint, sync_private_directory, unix_time_ms,
};
use crate::ProcessDescriptor;
use hmux_host::local_discovery::{
    DiscoveryManifest, DiscoveryRoot, LocalEndpoint, SessionClass, SessionLookupKey,
};
use hmux_runtime_contract::{
    MANAGED_CONVERSATION_WRITER_CONFLICT_CODE, MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES,
    ManagedCreateGenerationFence, ManagedCreateReceipt, ManagedCreateReconcileRequest,
    ManagedRehostSourceRecipe, ManagedStopReceipt, ManagedStopReconcileRequest,
    ProviderConversationIdentitySeed, TerminalDefaultColors,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
#[cfg(all(test, unix))]
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[cfg(any(feature = "local-runtime", test))]
mod cleanup;
mod conversation_writer_exit;
mod predecessor_locator;
mod request_admission;
mod reservation;
use reservation::reserve_with_lineage_admission;
#[cfg(test)]
use reservation::{
    reserve_with_lineage_admission_with_hooks, reserve_with_lineage_admission_with_interleave,
};
mod retirement;

#[cfg(any(feature = "local-runtime", test))]
use cleanup::close_successor_slot;
#[cfg(any(feature = "local-runtime", test))]
pub use cleanup::{
    close_abandoned_create, close_exact_create, close_retired_create, closed_retired_chain,
    closed_retired_chain_receipt, resolve_create_origin,
};
use conversation_writer_exit::completed_conversation_writer_has_exited;
use request_admission::decode_canonical_rehost_recipe;
pub use request_admission::{
    ManagedCreateLineageAdmission, prepare_root_request, reserve, reserve_request,
    reserve_successor_with_rehost_recipe_and_conversation, reserve_with_rehost_recipe,
    reserve_with_rehost_recipe_and_conversation,
};
pub use retirement::{
    ManagedSessionRetirementObservation, final_stop_receipt, observe_session_retirement,
};
#[cfg(any(feature = "local-runtime", test))]
pub use retirement::{close_finalized_create, close_stopped_creation};

const LEGACY_LEDGER_DIRECTORY: &str = ".managed-create-v1";
const LEDGER_DIRECTORY: &str = ".managed-create-v2";
const LEDGER_SHARD_SCHEMA_VERSION_V2: u16 = 2;
const LEDGER_SHARD_SCHEMA_VERSION: u16 = 3;
const LEDGER_RECORD_SCHEMA_VERSION_V2: u16 = 2;
const LEDGER_RECORD_SCHEMA_VERSION: u16 = 3;
const LEDGER_SHARDS: usize = 256;
const MAX_SHARD_RECORDS: usize = 8_192;
const MAX_SHARD_BYTES: u64 = 8 * 1024 * 1024;
const SUCCESSOR_LEDGER_SCHEMA_VERSION: u16 = 1;
const SUCCESSOR_DIGEST_LEDGER_SCHEMA_VERSION: u16 = 1;
const SUCCESSOR_PREDECESSOR_LEDGER_SCHEMA_VERSION: u16 = 1;
const LEGACY_SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION: u16 = 1;
const LEGACY_BITMAP_SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION: u16 = 2;
const SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION: u16 = 3;
const SUCCESSOR_PREDECESSOR_BITMAP_WORDS: usize = LEDGER_SHARDS / 64;
const SUCCESSOR_PREDECESSOR_COVERAGE_FILE: &str = "predecessor_coverage_complete.json";
const SUCCESSOR_PREDECESSOR_COVERAGE_LOCK: &str = "predecessor_coverage.lock";
const EMPTY_V3_CREATE_SHARD_FENCE_FILE: &str = "create_shard_v3_empty_fence.json";
const CONVERSATION_WRITER_SCHEMA_VERSION: u16 = 1;
const PROVIDER_RELEASE_GUARD_SCHEMA_VERSION: u16 = 1;
const MANAGED_STOP_SCHEMA: &str = "hmux-managed-stop-v1";
const ARCHIVED_UNTOUCHED_STOP_RECEIPT_VERSION: u64 = 3;
const CURRENT_STOP_RECEIPT_VERSION: u64 = 2;

/// A fixed-inode, generation-preserving create ledger keyed by logical
/// session. Different canonical requests never reuse one logical session ID;
/// callers create a fresh session identity for a replacement generation.
pub enum ManagedCreateLedgerState {
    Prepared(ManagedCreateLedgerReservation),
    SpawnReserved {
        reservation: ManagedCreateLedgerReservation,
        host_process: ProcessDescriptor,
    },
    LaunchReleased {
        reservation: ManagedCreateLedgerReservation,
        host_process: ProcessDescriptor,
        starting_generation: Option<Box<ManagedStartingGeneration>>,
    },
    Completed(String),
    Retired,
}

/// Identity-only projection used when the caller no longer has the canonical
/// create request. The reservation variants retain the record CAS; they do not
/// expose or reconstruct the request digest.
pub enum ManagedCreateReconcileLedgerState {
    NotFound,
    PreSpawnAbsenceUnverified(ManagedCreateLedgerReservation),
    PreSpawnAbsenceCheckpointed(ManagedCreateLedgerReservation),
    SpawnReserved {
        reservation: ManagedCreateLedgerReservation,
        host_process: ProcessDescriptor,
    },
    LaunchReleased {
        reservation: ManagedCreateLedgerReservation,
        host_process: ProcessDescriptor,
        starting_generation: Option<Box<ManagedStartingGeneration>>,
        provider_release_guard: bool,
    },
    Completed(ManagedCreateReceipt),
    Pending,
    Retiring(ManagedStopReceipt),
    AbandonedBeforeCompletion,
    Retired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagedCreateSuccessorLedgerState {
    NotFound,
    Pending,
    /// Destructive cleanup durably closed successor admission.
    Closed,
    /// The immutable edge was already durable before this reservation call.
    Existing(ManagedCreateSuccessorIdentity),
    /// The immutable edge was already durable, but its replaceable launch
    /// authority is currently unavailable.
    ExistingUnavailable {
        successor: ManagedCreateSuccessorIdentity,
        error: Box<ManagedCreateAdmissionError>,
    },
    /// This reservation call published the immutable edge.
    Created(ManagedCreateSuccessorIdentity),
}

/// Complete identity and retirement lineage recovered for one successor chain.
#[cfg(any(feature = "local-runtime", test))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedCreateSuccessorChain {
    identities: Vec<ManagedCreateReconcileRequest>,
    prior_stop_receipts: Vec<ManagedStopReceipt>,
}

#[cfg(any(feature = "local-runtime", test))]
impl ManagedCreateSuccessorChain {
    fn new(
        identities: Vec<ManagedCreateReconcileRequest>,
        prior_stop_receipts: Vec<ManagedStopReceipt>,
    ) -> Self {
        Self {
            identities,
            prior_stop_receipts,
        }
    }

    #[must_use]
    pub fn identities(&self) -> &[ManagedCreateReconcileRequest] {
        &self.identities
    }

    #[must_use]
    pub fn root(&self) -> &ManagedCreateReconcileRequest {
        self.identities
            .first()
            .expect("resolved managed create successor chain has a root identity")
    }

    #[must_use]
    pub fn effective(&self) -> &ManagedCreateReconcileRequest {
        self.identities
            .last()
            .expect("resolved managed create successor chain has an effective identity")
    }

    #[must_use]
    pub fn prior_stop_receipts(&self) -> &[ManagedStopReceipt] {
        &self.prior_stop_receipts
    }

    #[must_use]
    pub fn into_identities(self) -> Vec<ManagedCreateReconcileRequest> {
        self.identities
    }
}

/// Resolution of a managed-create identity through every durable successor
/// edge, including exact stop receipts owned by terminal ancestors.
#[cfg(any(feature = "local-runtime", test))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagedCreateSuccessorChainResolution {
    NotFound,
    Completed {
        chain: ManagedCreateSuccessorChain,
        receipt: Box<ManagedCreateReceipt>,
    },
    Pending {
        chain: ManagedCreateSuccessorChain,
    },
    UnbornSuccessor {
        chain: ManagedCreateSuccessorChain,
        expected: ManagedCreateSuccessorIdentity,
    },
    Retiring {
        chain: ManagedCreateSuccessorChain,
        stop_receipt: Box<ManagedStopReceipt>,
    },
    TerminalWithoutSuccessor {
        chain: ManagedCreateSuccessorChain,
        stop_receipt: Option<Box<ManagedStopReceipt>>,
    },
}

/// Cycle fence shared by effectful advance and read-only recovery. The caller
/// supplies already-validated identities; this type owns only chain topology.
#[derive(Debug, Default)]
pub struct ManagedCreateSuccessorTraversal {
    visited: BTreeSet<(String, String, String)>,
}

impl ManagedCreateSuccessorTraversal {
    #[must_use]
    pub fn visit(&mut self, identity: &ManagedCreateReconcileRequest) -> bool {
        self.visited.insert((
            identity.workspace_id().to_string(),
            identity.session_id().to_string(),
            identity.idempotency_key().to_string(),
        ))
    }
}

/// Immutable target identity chosen under the source create-shard lock.
/// This frozen v1 wire shape remains readable in legacy sibling edges; v3
/// records carry complete policy evidence beside the identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedCreateSuccessorIdentity {
    schema_version: u16,
    session_id: String,
    idempotency_key: String,
    request_digest: String,
    #[serde(skip)]
    policy_digests: Option<ManagedCreateSuccessorPolicyDigests>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCreateSuccessorPolicyDigests {
    canonical_request_digest: String,
    rehost_recipe_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    canonical_rehost_recipe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversation_identity: Option<ProviderConversationIdentitySeed>,
}

impl ManagedCreateSuccessorIdentity {
    pub fn new(
        session_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        request_digest: impl Into<String>,
    ) -> Result<Self, ManagedCreateAdmissionError> {
        let identity = Self {
            schema_version: SUCCESSOR_LEDGER_SCHEMA_VERSION,
            session_id: session_id.into(),
            idempotency_key: idempotency_key.into(),
            request_digest: request_digest.into(),
            policy_digests: None,
        };
        validate_successor_identity(&identity)?;
        Ok(identity)
    }

    pub fn with_policy_digests(
        session_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        request_digest: impl Into<String>,
        canonical_request_digest: impl Into<String>,
        rehost_recipe_digest: Option<String>,
    ) -> Result<Self, ManagedCreateAdmissionError> {
        let identity = Self {
            schema_version: SUCCESSOR_LEDGER_SCHEMA_VERSION,
            session_id: session_id.into(),
            idempotency_key: idempotency_key.into(),
            request_digest: request_digest.into(),
            policy_digests: Some(ManagedCreateSuccessorPolicyDigests {
                canonical_request_digest: canonical_request_digest.into(),
                rehost_recipe_digest,
                canonical_rehost_recipe: None,
                conversation_identity: None,
            }),
        };
        validate_successor_identity(&identity)?;
        Ok(identity)
    }

    pub fn with_target_policy(
        session_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        request_digest: impl Into<String>,
        canonical_request_digest: impl Into<String>,
        rehost_recipe_digest: Option<String>,
        canonical_rehost_recipe: Option<String>,
        conversation_identity: Option<ProviderConversationIdentitySeed>,
    ) -> Result<Self, ManagedCreateAdmissionError> {
        let identity = Self {
            schema_version: SUCCESSOR_LEDGER_SCHEMA_VERSION,
            session_id: session_id.into(),
            idempotency_key: idempotency_key.into(),
            request_digest: request_digest.into(),
            policy_digests: Some(ManagedCreateSuccessorPolicyDigests {
                canonical_request_digest: canonical_request_digest.into(),
                rehost_recipe_digest,
                canonical_rehost_recipe,
                conversation_identity,
            }),
        };
        validate_successor_identity(&identity)?;
        Ok(identity)
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub fn ensure_request_policy_digests(
        &self,
        request_digest: &str,
        canonical_request_digest: &str,
        rehost_recipe_digest: Option<&str>,
    ) -> Result<(), ManagedCreateAdmissionError> {
        if self.request_digest != request_digest {
            return Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict);
        }
        self.policy_digests.as_ref().map_or(Ok(()), |policy| {
            if policy.canonical_request_digest == canonical_request_digest
                && policy.rehost_recipe_digest.as_deref() == rehost_recipe_digest
            {
                Ok(())
            } else {
                Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict)
            }
        })
    }

    fn ensure_admitted_policy_digests(
        &self,
        canonical_request_digest: &str,
        rehost_recipe_digest: Option<&str>,
    ) -> Result<(), ManagedCreateAdmissionError> {
        match self.policy_digests.as_ref() {
            Some(policy)
                if policy.canonical_request_digest == canonical_request_digest
                    && policy.rehost_recipe_digest.as_deref() == rehost_recipe_digest =>
            {
                Ok(())
            }
            Some(_) => Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict),
            None if rehost_recipe_digest.is_none()
                && self.request_digest != canonical_request_digest =>
            {
                Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict)
            }
            None => Ok(()),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedCreateRetirement {
    NoLedger,
    Exact,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagedCreateAdmissionError {
    GenerationRetiredExact,
    CanonicalRequestDigestConflict,
    CanonicalConversationIdentityConflict,
    CanonicalRehostRecipeConflict,
    SuccessorRequestDigestConflict,
    SuccessorLineageConflict,
    ConversationWriterConflict {
        provider_id: String,
        owner_workspace_id: String,
        owner_session_id: String,
    },
    Ledger(String),
}

impl ManagedCreateAdmissionError {
    #[must_use]
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::GenerationRetiredExact => {
                Some(hmux_runtime_contract::MANAGED_CREATE_RETIRED_EXACT_CODE)
            }
            Self::CanonicalRequestDigestConflict => {
                Some(hmux_runtime_contract::MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE)
            }
            Self::SuccessorRequestDigestConflict => {
                Some(hmux_runtime_contract::MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE)
            }
            Self::ConversationWriterConflict { .. } => {
                Some(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE)
            }
            Self::CanonicalConversationIdentityConflict
            | Self::CanonicalRehostRecipeConflict
            | Self::SuccessorLineageConflict
            | Self::Ledger(_) => None,
        }
    }

    /// Whether this exact logical create is bound to a different immutable
    /// source policy. Ordinary create keeps these distinctions; the explicit
    /// advance broker may reconcile the old source without parsing messages.
    #[must_use]
    pub fn canonical_source_changed(&self) -> bool {
        matches!(
            self,
            Self::CanonicalRequestDigestConflict
                | Self::CanonicalConversationIdentityConflict
                | Self::CanonicalRehostRecipeConflict
        )
    }

    #[must_use]
    pub fn successor_lineage_conflict(&self) -> bool {
        matches!(self, Self::SuccessorLineageConflict)
    }
}

impl std::fmt::Display for ManagedCreateAdmissionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GenerationRetiredExact => formatter
                .write_str("managed create generation is retired; use a new logical session id"),
            Self::CanonicalRequestDigestConflict => write!(
                formatter,
                "{}: the same idempotency identity is permanently bound to another canonical create request",
                hmux_runtime_contract::MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE
            ),
            Self::CanonicalConversationIdentityConflict => formatter.write_str(
                "hmux_managed_create_idempotency_conflict: exact conversation identity changed",
            ),
            Self::CanonicalRehostRecipeConflict => formatter.write_str(
                "hmux_managed_create_idempotency_conflict: canonical rehost recipe changed",
            ),
            Self::SuccessorRequestDigestConflict => write!(
                formatter,
                "{}: the terminal source is permanently bound to another successor request",
                hmux_runtime_contract::MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE
            ),
            Self::SuccessorLineageConflict => formatter.write_str(
                "hmux_managed_create_successor_conflict: target lineage is already claimed",
            ),
            Self::ConversationWriterConflict {
                provider_id,
                owner_workspace_id,
                owner_session_id,
            } => write!(
                formatter,
                "{MANAGED_CONVERSATION_WRITER_CONFLICT_CODE}: provider {provider_id} conversation is already reserved by managed session {owner_workspace_id}/{owner_session_id}"
            ),
            Self::Ledger(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ManagedCreateAdmissionError {}

impl From<String> for ManagedCreateAdmissionError {
    fn from(message: String) -> Self {
        Self::Ledger(message)
    }
}

/// Returns the bounded discovery paths whose create/retirement state still
/// needs its manifest as a durable launch witness. GC callers hold the
/// discovery maintenance fence before using this set for deletion.
pub fn pending_session_paths(discovery_root: &Path) -> Result<BTreeSet<PathBuf>, String> {
    pending_session_paths_with(discovery_root, |path| acquire_shard_lock(path).map(Some))
        .map(|paths| paths.expect("blocking shard admission acquires every lease"))
}

/// Capacity maintenance must defer rather than hold the root-exclusive lease
/// while waiting for an unrelated ledger owner.
#[cfg(feature = "local-runtime")]
pub(crate) fn try_pending_session_paths(
    discovery_root: &Path,
) -> Result<Option<BTreeSet<PathBuf>>, String> {
    pending_session_paths_with(discovery_root, |path| {
        RecoveryLock::try_acquire_for_maintenance(open_private_lock(path)?)
    })
}

fn pending_session_paths_with(
    discovery_root: &Path,
    acquire: impl Fn(&Path) -> Result<Option<RecoveryLock>, String>,
) -> Result<Option<BTreeSet<PathBuf>>, String> {
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Some(BTreeSet::new()));
        }
        Err(_) => {
            return Err(
                "hmux_managed_create_ledger_invalid: ledger directory is unreadable".to_string(),
            );
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let mut protected = BTreeSet::new();
    for index in 0..LEDGER_SHARDS {
        let lock_path = directory.join(format!("shard_{index:02x}.lock"));
        let shard_path = directory.join(format!("shard_{index:02x}.json"));
        if !private_path_exists(&shard_path)? {
            continue;
        }
        let Some(_lock) = acquire(&lock_path)? else {
            return Ok(None);
        };
        let shard = read_shard_or_default(&shard_path)?;
        validate_shard(&shard, index)?;
        for record in shard.records.values() {
            let protect = match &record.state {
                ManagedCreateLedgerRecordState::Completed {
                    receipt,
                    retired: false,
                    ..
                } => {
                    let receipt: ManagedCreateReceipt = serde_json::from_str(receipt).map_err(|_| {
                        "hmux_managed_create_ledger_invalid: completed create receipt is malformed"
                            .to_string()
                    })?;
                    receipt
                        .validate()
                        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
                    if receipt.generation_fence().is_none() {
                        return Err(
                            "hmux_managed_create_ledger_invalid: completed create receipt has no generation fence"
                                .to_string(),
                        );
                    }
                    if receipt.workspace_id() != record.workspace_id
                        || receipt.session_id() != record.session_id
                        || receipt.idempotency_key() != record.idempotency_key
                        || receipt.discovery_root() != discovery_root
                        || record
                            .conversation_identity
                            .as_ref()
                            .is_some_and(|identity| identity.provider_id() != receipt.provider_id())
                    {
                        return Err(
                            "hmux_managed_create_ledger_conflict: completed create identity changed"
                                .to_string(),
                        );
                    }
                    true
                }
                state => matches!(
                    state,
                    ManagedCreateLedgerRecordState::RootLineagePending
                        | ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified
                        | ManagedCreateLedgerRecordState::SpawnReserved { .. }
                        | ManagedCreateLedgerRecordState::LaunchReleased { .. }
                        | ManagedCreateLedgerRecordState::RetiringBeforeCreateCompletion { .. }
                ),
            };
            if protect {
                let key = SessionLookupKey::new(&record.workspace_id, &record.session_id)
                    .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
                protected.insert(key.relative_path());
            }
        }
    }
    Ok(Some(protected))
}

/// Which launch colours a create uses: the stored rehost seed when the recipe
/// actually carries one, the caller's request otherwise.
///
/// The outer `Option` is "is there a recipe", the inner is "does it carry a
/// seed". Collapsing both to `unwrap_or` made a recipe without a seed win, and
/// the session started on the type's default — opaque black.
fn resolved_launch_colors(
    stored: Option<Option<TerminalDefaultColors>>,
    request: Option<TerminalDefaultColors>,
) -> Option<TerminalDefaultColors> {
    stored.flatten().or(request)
}

pub struct ManagedCreateLedgerReservation {
    directory: PathBuf,
    lock_path: PathBuf,
    shard_path: PathBuf,
    record_key: String,
    record: ManagedCreateLedgerRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCreateLedgerShard {
    schema_version: u16,
    records: BTreeMap<String, ManagedCreateLedgerRecord>,
}

impl Default for ManagedCreateLedgerShard {
    fn default() -> Self {
        Self {
            schema_version: LEDGER_SHARD_SCHEMA_VERSION,
            records: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCreateSuccessorShard {
    schema_version: u16,
    records: BTreeMap<String, ManagedCreateSuccessorRecord>,
}

impl Default for ManagedCreateSuccessorShard {
    fn default() -> Self {
        Self {
            schema_version: SUCCESSOR_LEDGER_SCHEMA_VERSION,
            records: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCreateSuccessorDigestShard {
    schema_version: u16,
    records: BTreeMap<String, ManagedCreateSuccessorDigestRecord>,
}

impl Default for ManagedCreateSuccessorDigestShard {
    fn default() -> Self {
        Self {
            schema_version: SUCCESSOR_DIGEST_LEDGER_SCHEMA_VERSION,
            records: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCreateSuccessorDigestRecord {
    schema_version: u16,
    edge_fingerprint: String,
    canonical_request_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw_rehost_recipe_digest: Option<String>,
    created_unix_ms: u64,
}

/// Additive proof written before the corresponding launch-released ledger
/// record. Keeping this projection outside the shared ledger shard lets older
/// writers preserve evidence they do not understand.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedProviderReleaseGuardShard {
    schema_version: u16,
    records: BTreeMap<String, ManagedProviderReleaseGuardRecord>,
}

impl Default for ManagedProviderReleaseGuardShard {
    fn default() -> Self {
        Self {
            schema_version: PROVIDER_RELEASE_GUARD_SCHEMA_VERSION,
            records: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedProviderReleaseGuardRecord {
    schema_version: u16,
    launch_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCreateSuccessorPredecessorShard {
    schema_version: u16,
    records: BTreeMap<String, ManagedCreateSuccessorPredecessorRecord>,
}

impl Default for ManagedCreateSuccessorPredecessorShard {
    fn default() -> Self {
        Self {
            schema_version: SUCCESSOR_PREDECESSOR_LEDGER_SCHEMA_VERSION,
            records: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCreateSuccessorPredecessorRecord {
    schema_version: u16,
    workspace_id: String,
    target_session_id: String,
    target_idempotency_key: String,
    authority: ManagedCreateSuccessorPredecessorAuthority,
    created_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ManagedCreateSuccessorPredecessorAuthority {
    Root {
        create_fingerprint: String,
        #[serde(default, skip_serializing_if = "is_false")]
        legacy_predecessor_absence_proven: bool,
    },
    Predecessor {
        predecessor: ManagedCreateReconcileRequest,
        edge_fingerprint: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCreateSuccessorPredecessorCoverageReceipt {
    schema_version: u16,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    legacy_source_shards_by_target: Vec<[u64; SUCCESSOR_PREDECESSOR_BITMAP_WORDS]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    locator_shards: Vec<predecessor_locator::ShardManifest>,
}

#[derive(Clone, Debug)]
enum CompleteSuccessorPredecessorCoverage {
    LegacyReverseIndex,
    LegacyBitmapRequiresUpgrade,
    FrozenForwardLocator {
        coverage: predecessor_locator::Coverage,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCreateSuccessorRecord {
    schema_version: u16,
    workspace_id: String,
    source_session_id: String,
    source_idempotency_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    successor: Option<ManagedCreateSuccessorIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cleanup_closed_unix_ms: Option<u64>,
    created_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCreateLedgerRecord {
    schema_version: u16,
    workspace_id: String,
    session_id: String,
    idempotency_key: String,
    request_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversation_identity: Option<ProviderConversationIdentitySeed>,
    #[serde(default, skip_serializing_if = "is_false")]
    conversation_writer_released: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    canonical_rehost_recipe: Option<String>,
    created_unix_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    authority: Option<ManagedCreateLedgerAuthorityV3>,
    #[serde(flatten)]
    state: ManagedCreateLedgerRecordState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCreateLedgerAuthorityV3 {
    lineage: ManagedCreateLineageAuthorityV3,
    successor: ManagedCreateSuccessorSlotV3,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ManagedCreateLineageAuthorityV3 {
    Root {
        #[serde(default, skip_serializing_if = "is_false")]
        legacy_predecessor_absence_proven: bool,
    },
    Predecessor {
        source: ManagedCreateReconcileRequest,
        edge_fingerprint: String,
    },
    /// This record predates direct lineage and retains its immutable sibling
    /// projection as decode-only ancestry authority.
    LegacyV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ManagedCreateSuccessorSlotV3 {
    Vacant,
    Intent {
        successor: Box<ManagedCreateSuccessorIdentity>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        policy_digests: Option<ManagedCreateSuccessorPolicyDigests>,
    },
    Closed {
        closed_unix_ms: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedConversationWriterShard {
    schema_version: u16,
    claims: BTreeMap<String, ManagedConversationWriterClaim>,
}

impl Default for ManagedConversationWriterShard {
    fn default() -> Self {
        Self {
            schema_version: CONVERSATION_WRITER_SCHEMA_VERSION,
            claims: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedConversationWriterClaim {
    schema_version: u16,
    conversation_identity: ProviderConversationIdentitySeed,
    owner: ManagedConversationWriterOwner,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedConversationWriterOwner {
    workspace_id: String,
    session_id: String,
    idempotency_key: String,
    request_digest: String,
}

struct ManagedConversationWriterAdmission {
    directory: PathBuf,
    shard_path: PathBuf,
    claim_key: String,
    shard: ManagedConversationWriterShard,
    _lock: RecoveryLock,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum ManagedCreateLedgerRecordState {
    /// Decode-only write-ahead marker emitted by the preceding v2 lineage
    /// writer while its Root reverse projection was not yet durable.
    RootLineagePending,
    /// A v3 predecessor-owned target that consumes its create capacity but is
    /// not launch-authoritative until the exact source is terminal.
    SuccessorLineagePending,
    /// Additive durable state written by current creators before they inspect
    /// discovery. Legacy `Prepared` records lack this provenance and can never
    /// be promoted automatically.
    PreSpawnAbsenceUnverified,
    Prepared,
    PreSpawnAbsenceCheckpointed,
    SpawnReserved {
        host_process: ProcessDescriptor,
    },
    LaunchReleased {
        host_process: ProcessDescriptor,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        starting_generation: Option<Box<ManagedStartingGeneration>>,
    },
    Completed {
        receipt: String,
        #[serde(default)]
        retired: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retiring_stop_receipt: Option<String>,
    },
    RetiringBeforeCreateCompletion {
        stop_receipt: String,
    },
    RetiredBeforeCreateCompletion {
        stop_receipt: String,
    },
    AbandonedBeforeCreateCompletion,
    /// A predecessor edge was durable but this target had not begun create
    /// admission. This one terminal fact fences both target creation and any
    /// later successor allocation; older readers reject the unknown state.
    CleanupClosedBeforeCreateAdmission,
}

/// Exact generation evidence checkpointed by a managed Host after its provider
/// process exists but before the Host publishes Ready. This is recovery
/// authority only for an abandoned Starting manifest; a live or unobservable
/// process generation remains fail-closed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedStartingGeneration {
    idempotency_key: String,
    host_process: ProcessDescriptor,
    provider_process: ProcessDescriptor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_containment: Option<ManagedStartingProviderContainment>,
    generation_fence: ManagedCreateGenerationFence,
    endpoint: LocalEndpoint,
    capability_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversation_identity: Option<ProviderConversationIdentitySeed>,
}

/// Platform-exact containment established before a managed provider may
/// execute. Older Unix checkpoints omit this field and retain their existing
/// POSIX-session absence proof; Windows cleanup requires the explicit Job
/// ownership variant because leader-process absence alone cannot prove that
/// descendants are gone.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedStartingProviderContainment {
    PosixSessionV1,
    WindowsKillOnJobCloseV1,
}

/// Provider-neutral evidence that one create attempt crossed launch release.
/// The runtime combines this immutable ledger projection with an exact
/// Ready/Exited manifest before constructing destructive stop authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedCreateLaunchedGenerationEvidence {
    host_process: ProcessDescriptor,
    conversation_identity: Option<ProviderConversationIdentitySeed>,
    starting_generation: Option<ManagedStartingGeneration>,
}

impl ManagedCreateLaunchedGenerationEvidence {
    #[must_use]
    pub fn host_process(&self) -> &ProcessDescriptor {
        &self.host_process
    }

    #[must_use]
    pub fn conversation_identity(&self) -> Option<&ProviderConversationIdentitySeed> {
        self.conversation_identity.as_ref()
    }

    #[must_use]
    pub fn starting_generation(&self) -> Option<&ManagedStartingGeneration> {
        self.starting_generation.as_ref()
    }
}

/// Immutable, owner-only source evidence for one completed logical
/// generation. A persisted conversation identity is an exact additional
/// fence; its absence means no identity was known at create time. An incoming
/// replacement request is never allowed to redefine either fact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedCreateCompletedGenerationEvidence {
    receipt: ManagedCreateReceipt,
    conversation_identity: Option<ProviderConversationIdentitySeed>,
}

impl ManagedCreateCompletedGenerationEvidence {
    #[must_use]
    pub fn receipt(&self) -> &ManagedCreateReceipt {
        &self.receipt
    }

    #[must_use]
    pub fn conversation_identity(&self) -> Option<&ProviderConversationIdentitySeed> {
        self.conversation_identity.as_ref()
    }
}

impl ManagedStartingGeneration {
    pub fn new(
        idempotency_key: impl Into<String>,
        host_process: ProcessDescriptor,
        provider_process: ProcessDescriptor,
        generation_fence: ManagedCreateGenerationFence,
        endpoint: LocalEndpoint,
        capability_token: impl Into<String>,
        conversation_identity: Option<ProviderConversationIdentitySeed>,
    ) -> Result<Self, String> {
        let generation = Self {
            idempotency_key: idempotency_key.into(),
            host_process,
            provider_process,
            provider_containment: None,
            generation_fence,
            endpoint,
            capability_token: capability_token.into(),
            conversation_identity,
        };
        validate_starting_generation(&generation)?;
        Ok(generation)
    }

    pub fn with_provider_containment(
        mut self,
        provider_containment: ManagedStartingProviderContainment,
    ) -> Result<Self, String> {
        self.provider_containment = Some(provider_containment);
        validate_starting_generation(&self)?;
        Ok(self)
    }

    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    #[must_use]
    pub fn host_process(&self) -> &ProcessDescriptor {
        &self.host_process
    }

    #[must_use]
    pub fn provider_process(&self) -> &ProcessDescriptor {
        &self.provider_process
    }

    #[must_use]
    pub fn provider_containment(&self) -> Option<ManagedStartingProviderContainment> {
        self.provider_containment
    }

    #[must_use]
    pub fn generation_fence(&self) -> &ManagedCreateGenerationFence {
        &self.generation_fence
    }

    #[must_use]
    pub fn endpoint(&self) -> &LocalEndpoint {
        &self.endpoint
    }

    #[must_use]
    pub fn capability_token(&self) -> &str {
        &self.capability_token
    }

    #[must_use]
    pub fn conversation_identity(&self) -> Option<&ProviderConversationIdentitySeed> {
        self.conversation_identity.as_ref()
    }
}

/// Reads one permanent create identity without supplying or comparing a new
/// request digest. A mismatched idempotency key is an authority failure, never
/// a miss and never permission to reuse the logical session.
pub fn reconcile_identity(
    discovery_root: &Path,
    request: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateReconcileLedgerState, String> {
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ManagedCreateReconcileLedgerState::NotFound);
        }
        Err(_) => {
            return Err(
                "hmux_managed_create_ledger_invalid: ledger directory is unreadable".to_string(),
            );
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let record_key = logical_key(request.workspace_id(), request.session_id());
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    if !private_path_exists(&shard_path)? {
        return Ok(ManagedCreateReconcileLedgerState::NotFound);
    }
    let _lock = acquire_shard_lock(&lock_path)?;
    let shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let Some(record) = shard.records.get(&record_key).cloned() else {
        return Ok(ManagedCreateReconcileLedgerState::NotFound);
    };
    validate_record(&record, request.workspace_id(), request.session_id())?;
    if record.idempotency_key != request.idempotency_key() {
        return Err(
            "hmux_managed_create_reconcile_authority_unavailable: idempotency identity changed"
                .to_string(),
        );
    }
    reconcile_record_state(
        &directory,
        &lock_path,
        &shard_path,
        &record_key,
        &record,
        request,
    )
}

fn reconcile_record_state(
    directory: &Path,
    lock_path: &Path,
    shard_path: &Path,
    record_key: &str,
    record: &ManagedCreateLedgerRecord,
    request: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateReconcileLedgerState, String> {
    let reservation = || ManagedCreateLedgerReservation {
        directory: directory.to_path_buf(),
        lock_path: lock_path.to_path_buf(),
        shard_path: shard_path.to_path_buf(),
        record_key: record_key.to_string(),
        record: record.clone(),
    };
    match &record.state {
        ManagedCreateLedgerRecordState::RootLineagePending => {
            Ok(ManagedCreateReconcileLedgerState::Pending)
        }
        ManagedCreateLedgerRecordState::SuccessorLineagePending => {
            Ok(ManagedCreateReconcileLedgerState::Pending)
        }
        ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified => {
            Ok(ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(reservation()))
        }
        ManagedCreateLedgerRecordState::Prepared => Ok(ManagedCreateReconcileLedgerState::Pending),
        ManagedCreateLedgerRecordState::PreSpawnAbsenceCheckpointed => {
            Ok(ManagedCreateReconcileLedgerState::PreSpawnAbsenceCheckpointed(reservation()))
        }
        ManagedCreateLedgerRecordState::SpawnReserved { host_process } => {
            Ok(ManagedCreateReconcileLedgerState::SpawnReserved {
                reservation: reservation(),
                host_process: host_process.clone(),
            })
        }
        ManagedCreateLedgerRecordState::LaunchReleased {
            host_process,
            starting_generation,
        } => Ok(ManagedCreateReconcileLedgerState::LaunchReleased {
            reservation: reservation(),
            host_process: host_process.clone(),
            starting_generation: starting_generation.clone(),
            provider_release_guard: matching_provider_release_guard(directory, record_key, record)?,
        }),
        ManagedCreateLedgerRecordState::Completed {
            retired: false,
            retiring_stop_receipt: Some(stop_receipt),
            ..
        }
        | ManagedCreateLedgerRecordState::RetiringBeforeCreateCompletion { stop_receipt } => {
            let receipt = decode_persisted_stop_receipt(
                stop_receipt,
                "hmux_managed_create_ledger_invalid: retiring stop receipt is malformed",
            )?;
            if receipt.workspace_id() != request.workspace_id()
                || receipt.session_id() != request.session_id()
            {
                return Err(
                    "hmux_managed_create_ledger_conflict: retiring stop identity changed"
                        .to_string(),
                );
            }
            Ok(ManagedCreateReconcileLedgerState::Retiring(receipt))
        }
        ManagedCreateLedgerRecordState::Completed {
            receipt,
            retired: false,
            retiring_stop_receipt: None,
        } => {
            let receipt: ManagedCreateReceipt = serde_json::from_str(receipt).map_err(|_| {
                "hmux_managed_create_ledger_invalid: completed create receipt is malformed"
                    .to_string()
            })?;
            receipt
                .validate()
                .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
            if receipt.workspace_id() != request.workspace_id()
                || receipt.session_id() != request.session_id()
                || receipt.idempotency_key() != request.idempotency_key()
            {
                return Err(
                    "hmux_managed_create_ledger_conflict: completed create identity changed"
                        .to_string(),
                );
            }
            Ok(ManagedCreateReconcileLedgerState::Completed(receipt))
        }
        ManagedCreateLedgerRecordState::Completed { retired: true, .. }
        | ManagedCreateLedgerRecordState::RetiredBeforeCreateCompletion { .. }
        | ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission => {
            Ok(ManagedCreateReconcileLedgerState::Retired)
        }
        ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion => {
            Ok(ManagedCreateReconcileLedgerState::AbandonedBeforeCompletion)
        }
    }
}

struct SuccessorSlotReservation {
    _source_lock: RecoveryLock,
    directory: PathBuf,
    source_path: PathBuf,
    source_shard: ManagedCreateLedgerShard,
    source_record: ManagedCreateLedgerRecord,
    record_key: String,
}

struct SuccessorPredecessorReservation {
    directory: PathBuf,
    shard_path: PathBuf,
    payload: Option<BoundedSuccessorShardPayload>,
    _lock: RecoveryLock,
}

struct LockedSuccessorPredecessorShard {
    directory: PathBuf,
    shard_path: PathBuf,
    target_key: String,
    shard: ManagedCreateSuccessorPredecessorShard,
    lock: RecoveryLock,
}

struct BoundedSuccessorShardPayload(Vec<u8>);

struct ManagedCreateLineageContext<'a> {
    canonical_rehost_recipe: Option<&'a str>,
    conversation_identity: Option<&'a ProviderConversationIdentitySeed>,
    admission: ManagedCreateLineageAdmission,
}

enum ManagedCreateSuccessorPredecessorProjection {
    Root,
    Predecessor(ManagedCreateReconcileRequest),
    Missing,
}

enum ManagedCreateSuccessorSourceState {
    Pending,
    CleanupClosed,
    #[cfg(any(feature = "local-runtime", test))]
    Retiring(Box<ManagedStopReceipt>),
    #[cfg(not(any(feature = "local-runtime", test)))]
    Retiring,
    #[cfg(any(feature = "local-runtime", test))]
    Completed(Box<ManagedCreateReceipt>),
    #[cfg(not(any(feature = "local-runtime", test)))]
    Completed,
    Terminal {
        #[cfg(any(feature = "local-runtime", test))]
        stop_receipt: Option<Box<ManagedStopReceipt>>,
    },
}

impl ManagedCreateSuccessorSourceState {
    fn is_terminal(&self) -> bool {
        matches!(self, Self::CleanupClosed | Self::Terminal { .. })
    }
}

enum ManagedCreateSuccessorSlot {
    Vacant(Box<SuccessorSlotReservation>),
    Existing(Box<ManagedCreateSuccessorIdentity>),
    Closed,
}

enum ManagedCreateSuccessorInspection {
    NotFound,
    Found {
        source: ManagedCreateSuccessorSourceState,
        source_record: Box<ManagedCreateLedgerRecord>,
        source_lock: Option<RecoveryLock>,
        slot: ManagedCreateSuccessorSlot,
    },
}

#[cfg(any(feature = "local-runtime", test))]
fn terminal_stop_receipt(
    record: &ManagedCreateLedgerRecord,
) -> Result<Option<Box<ManagedStopReceipt>>, ManagedCreateAdmissionError> {
    let serialized = match &record.state {
        ManagedCreateLedgerRecordState::Completed {
            retired: true,
            retiring_stop_receipt,
            ..
        } => Some(retiring_stop_receipt.as_deref().ok_or_else(|| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_ledger_invalid: retired completion has no stop receipt"
                    .to_string(),
            )
        })?),
        ManagedCreateLedgerRecordState::RetiredBeforeCreateCompletion { stop_receipt } => {
            Some(stop_receipt.as_str())
        }
        ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion
        | ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission => None,
        ManagedCreateLedgerRecordState::RootLineagePending => None,
        _ => None,
    };
    serialized
        .map(|serialized| {
            decode_persisted_stop_receipt(
                serialized,
                "hmux_managed_create_ledger_invalid: terminal stop receipt is malformed",
            )
            .map(Box::new)
            .map_err(ManagedCreateAdmissionError::Ledger)
        })
        .transpose()
}

fn admitted_rehost_recipe_digest(
    record: &ManagedCreateLedgerRecord,
) -> Result<Option<String>, ManagedCreateAdmissionError> {
    record
        .canonical_rehost_recipe
        .as_deref()
        .map(|serialized| {
            let source_recipe = decode_canonical_rehost_recipe(
                serialized,
                &record.workspace_id,
                &record.session_id,
            )?;
            let rehost = serde_json::to_string(source_recipe.rehost()).map_err(|error| {
                format!("hmux_managed_create_ledger_invalid: rehost recipe digest failed: {error}")
            })?;
            Ok(request_fingerprint(&[&rehost]))
        })
        .transpose()
}

fn ensure_expected_successor_record(
    expected: &ManagedCreateSuccessorIdentity,
    record: &ManagedCreateLedgerRecord,
) -> Result<(), ManagedCreateAdmissionError> {
    if matches!(
        record.state,
        ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission
    ) {
        let direct_predecessor = matches!(
            record
                .authority
                .as_ref()
                .map(|authority| &authority.lineage),
            Some(ManagedCreateLineageAuthorityV3::Predecessor { .. })
        );
        return if record.request_digest
            == if direct_predecessor {
                successor_canonical_request_digest(expected)
            } else {
                expected.request_digest.as_str()
            } {
            Ok(())
        } else {
            Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict)
        };
    }
    let rehost_recipe_digest = admitted_rehost_recipe_digest(record)?;
    expected.ensure_admitted_policy_digests(&record.request_digest, rehost_recipe_digest.as_deref())
}

fn successor_edge_fingerprint(
    source: &ManagedCreateReconcileRequest,
    successor: &ManagedCreateSuccessorIdentity,
) -> Result<String, ManagedCreateAdmissionError> {
    let serialized = serde_json::to_string(successor).map_err(|_| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: edge fingerprint serialization failed"
                .to_string(),
        )
    })?;
    Ok(request_fingerprint(&[
        "managed-create-successor-digest-v1",
        source.workspace_id(),
        source.session_id(),
        source.idempotency_key(),
        &serialized,
    ]))
}

fn managed_create_root_fingerprint(record: &ManagedCreateLedgerRecord) -> String {
    let (recipe_presence, canonical_rehost_recipe) = match &record.canonical_rehost_recipe {
        Some(recipe) => ("present", recipe.as_str()),
        None => ("absent", ""),
    };
    request_fingerprint(&[
        "managed-create-successor-root-v1",
        &record.workspace_id,
        &record.session_id,
        &record.idempotency_key,
        &record.request_digest,
        recipe_presence,
        canonical_rehost_recipe,
    ])
}

fn attach_successor_policy_digests(
    mut successor: ManagedCreateSuccessorIdentity,
    record: Option<&ManagedCreateSuccessorDigestRecord>,
) -> ManagedCreateSuccessorIdentity {
    if let Some(record) = record {
        successor.policy_digests = Some(ManagedCreateSuccessorPolicyDigests {
            canonical_request_digest: record.canonical_request_digest.clone(),
            rehost_recipe_digest: record.raw_rehost_recipe_digest.clone(),
            canonical_rehost_recipe: None,
            conversation_identity: None,
        });
    }
    successor
}

fn successor_digest_record(
    source: &ManagedCreateReconcileRequest,
    successor: &ManagedCreateSuccessorIdentity,
) -> Result<Option<ManagedCreateSuccessorDigestRecord>, ManagedCreateAdmissionError> {
    successor
        .policy_digests
        .as_ref()
        .map(|policy| {
            Ok(ManagedCreateSuccessorDigestRecord {
                schema_version: SUCCESSOR_DIGEST_LEDGER_SCHEMA_VERSION,
                edge_fingerprint: successor_edge_fingerprint(source, successor)?,
                canonical_request_digest: policy.canonical_request_digest.clone(),
                raw_rehost_recipe_digest: policy.rehost_recipe_digest.clone(),
                created_unix_ms: unix_time_ms(),
            })
        })
        .transpose()
}

fn successor_canonical_request_digest(successor: &ManagedCreateSuccessorIdentity) -> &str {
    successor
        .policy_digests
        .as_ref()
        .map_or(successor.request_digest.as_str(), |policy| {
            policy.canonical_request_digest.as_str()
        })
}

fn successor_has_direct_lineage(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    expected: &ManagedCreateSuccessorIdentity,
) -> Result<bool, ManagedCreateAdmissionError> {
    let Some(record) = read_lineage_create_record(discovery_root, source)? else {
        return Ok(false);
    };
    let Some(ManagedCreateLedgerAuthorityV3 {
        successor:
            ManagedCreateSuccessorSlotV3::Intent {
                successor,
                policy_digests,
            },
        ..
    }) = record.authority.as_ref()
    else {
        return Ok(false);
    };
    let mut successor = successor.as_ref().clone();
    successor.policy_digests = policy_digests.clone();
    successor.ensure_request_policy_digests(
        &expected.request_digest,
        expected
            .policy_digests
            .as_ref()
            .map_or(expected.request_digest.as_str(), |policy| {
                policy.canonical_request_digest.as_str()
            }),
        expected
            .policy_digests
            .as_ref()
            .and_then(|policy| policy.rehost_recipe_digest.as_deref()),
    )?;
    Ok(successor.session_id == expected.session_id
        && successor.idempotency_key == expected.idempotency_key)
}

fn inspect_successor_node(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    expected_successor: Option<&ManagedCreateSuccessorIdentity>,
) -> Result<ManagedCreateSuccessorInspection, ManagedCreateAdmissionError> {
    source.validate().map_err(|error| {
        ManagedCreateAdmissionError::Ledger(format!(
            "hmux_managed_create_successor_invalid: {error}"
        ))
    })?;
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ManagedCreateSuccessorInspection::NotFound);
        }
        Err(_) => {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_ledger_invalid: ledger directory is unreadable".to_string(),
            ));
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let record_key = logical_key(source.workspace_id(), source.session_id());
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    if !private_path_exists(&shard_path)? {
        return Ok(ManagedCreateSuccessorInspection::NotFound);
    }
    let source_lock = acquire_shard_lock(&lock_path)?;
    let shard = read_shard_or_default(&shard_path)?;
    let index = shard_index(&record_key)?;
    validate_shard(&shard, index)?;
    let Some(source_record) = shard.records.get(&record_key).cloned() else {
        return Ok(ManagedCreateSuccessorInspection::NotFound);
    };
    validate_record(&source_record, source.workspace_id(), source.session_id())?;
    if source_record.idempotency_key != source.idempotency_key() {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_advance_authority_unavailable: source idempotency identity changed"
                .to_string(),
        ));
    }
    if let Some(expected) = expected_successor {
        ensure_expected_successor_record(expected, &source_record)?;
    }

    let direct_authority = source_record.authority.is_some();
    let (successors, successor_digests) = if direct_authority {
        (
            ManagedCreateSuccessorShard::default(),
            ManagedCreateSuccessorDigestShard::default(),
        )
    } else {
        read_successor_topology_snapshot(&directory, index)?
    };

    let source_state = match reconcile_record_state(
        &directory,
        &lock_path,
        &shard_path,
        &record_key,
        &source_record,
        source,
    )? {
        ManagedCreateReconcileLedgerState::Completed(receipt) => {
            #[cfg(any(feature = "local-runtime", test))]
            {
                ManagedCreateSuccessorSourceState::Completed(Box::new(receipt))
            }
            #[cfg(not(any(feature = "local-runtime", test)))]
            {
                drop(receipt);
                ManagedCreateSuccessorSourceState::Completed
            }
        }
        ManagedCreateReconcileLedgerState::AbandonedBeforeCompletion => {
            ManagedCreateSuccessorSourceState::Terminal {
                #[cfg(any(feature = "local-runtime", test))]
                stop_receipt: None,
            }
        }
        ManagedCreateReconcileLedgerState::Retired
            if matches!(
                &source_record.state,
                ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission
            ) =>
        {
            ManagedCreateSuccessorSourceState::CleanupClosed
        }
        ManagedCreateReconcileLedgerState::Retired => ManagedCreateSuccessorSourceState::Terminal {
            #[cfg(any(feature = "local-runtime", test))]
            stop_receipt: terminal_stop_receipt(&source_record)?,
        },
        ManagedCreateReconcileLedgerState::Retiring(stop_receipt) => {
            #[cfg(any(feature = "local-runtime", test))]
            {
                ManagedCreateSuccessorSourceState::Retiring(Box::new(stop_receipt))
            }
            #[cfg(not(any(feature = "local-runtime", test)))]
            {
                drop(stop_receipt);
                ManagedCreateSuccessorSourceState::Retiring
            }
        }
        ManagedCreateReconcileLedgerState::NotFound => {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: locked source disappeared during inspection"
                    .to_string(),
            ));
        }
        ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(_)
        | ManagedCreateReconcileLedgerState::PreSpawnAbsenceCheckpointed(_)
        | ManagedCreateReconcileLedgerState::SpawnReserved { .. }
        | ManagedCreateReconcileLedgerState::LaunchReleased { .. }
        | ManagedCreateReconcileLedgerState::Pending => ManagedCreateSuccessorSourceState::Pending,
    };

    let persisted_slot = if let Some(authority) = &source_record.authority {
        match &authority.successor {
            ManagedCreateSuccessorSlotV3::Vacant => None,
            ManagedCreateSuccessorSlotV3::Intent {
                successor,
                policy_digests,
            } => {
                let mut successor = successor.as_ref().clone();
                successor.policy_digests = policy_digests.clone();
                Some(ManagedCreateSuccessorSlot::Existing(Box::new(successor)))
            }
            ManagedCreateSuccessorSlotV3::Closed { .. } => Some(ManagedCreateSuccessorSlot::Closed),
        }
    } else {
        match successors.records.get(&record_key) {
            Some(existing) => {
                validate_successor_record(existing, source, &record_key, index)?;
                Some(match &existing.successor {
                    Some(successor) => ManagedCreateSuccessorSlot::Existing(Box::new(
                        attach_successor_policy_digests(
                            successor.clone(),
                            successor_digests.records.get(&record_key),
                        ),
                    )),
                    None => ManagedCreateSuccessorSlot::Closed,
                })
            }
            None => None,
        }
    };
    if matches!(
        &persisted_slot,
        Some(ManagedCreateSuccessorSlot::Existing(_))
    ) && matches!(
        &source_state,
        ManagedCreateSuccessorSourceState::CleanupClosed
    ) {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: cleanup-closed target has a successor edge"
                .to_string(),
        ));
    }
    let inspected_source_record = source_record.clone();
    let (slot, retained_source_lock) = if matches!(
        &source_state,
        ManagedCreateSuccessorSourceState::CleanupClosed
    ) {
        (ManagedCreateSuccessorSlot::Closed, Some(source_lock))
    } else {
        match persisted_slot {
            Some(slot) => (slot, Some(source_lock)),
            None => (
                ManagedCreateSuccessorSlot::Vacant(Box::new(SuccessorSlotReservation {
                    _source_lock: source_lock,
                    directory,
                    source_path: shard_path,
                    source_shard: shard,
                    source_record,
                    record_key,
                })),
                None,
            ),
        }
    };
    Ok(ManagedCreateSuccessorInspection::Found {
        source: source_state,
        source_record: Box::new(inspected_source_record),
        source_lock: retained_source_lock,
        slot,
    })
}

#[cfg(any(feature = "local-runtime", test))]
#[derive(Clone, Copy)]
enum ManagedCreateSuccessorChainMode {
    ReadOnly,
    ClaimCleanup,
}

/// Follows only already-durable successor edges. This never invokes a runtime,
/// mutates a ledger, or allocates a target identity.
#[cfg(any(feature = "local-runtime", test))]
pub fn resolve_successor_chain(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateSuccessorChainResolution, String> {
    resolve_successor_chain_with_mode(
        discovery_root,
        source,
        ManagedCreateSuccessorChainMode::ReadOnly,
    )
}

/// Claims the final create record or source slot for destructive cleanup
/// before exposing a completed target or terminal chain. Pending cleanup and
/// advance serialize on the same create-shard lock.
#[cfg(any(feature = "local-runtime", test))]
pub fn claim_successor_chain_cleanup(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateSuccessorChainResolution, String> {
    resolve_successor_chain_with_mode(
        discovery_root,
        source,
        ManagedCreateSuccessorChainMode::ClaimCleanup,
    )
}

#[cfg(any(feature = "local-runtime", test))]
fn resolve_successor_chain_with_mode(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    mode: ManagedCreateSuccessorChainMode,
) -> Result<ManagedCreateSuccessorChainResolution, String> {
    source
        .validate()
        .map_err(|error| format!("hmux_managed_create_successor_invalid: {error}"))?;
    let mut current = if matches!(mode, ManagedCreateSuccessorChainMode::ClaimCleanup) {
        oldest_successor_ancestor(discovery_root, source)
            .map_err(|error| error.to_string())?
            .0
    } else {
        source.clone()
    };
    let recovered_ancestor = current != *source;
    let mut traversal = ManagedCreateSuccessorTraversal::default();
    let mut identities = Vec::new();
    let mut prior_stop_receipts = Vec::new();
    let mut followed_successor = false;
    let mut expected_successor = None;
    loop {
        if matches!(mode, ManagedCreateSuccessorChainMode::ClaimCleanup)
            && identities.len() >= MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES
        {
            return Err(format!(
                "hmux_managed_create_successor_capacity: successor chain exceeds {MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES} identities"
            ));
        }
        if !traversal.visit(&current) {
            return Err(
                "hmux_managed_create_successor_invalid: successor chain contains an identity cycle"
                    .to_string(),
            );
        }
        identities.push(current.clone());
        match inspect_successor_node(discovery_root, &current, expected_successor.as_ref())
            .map_err(|error| error.to_string())?
        {
            ManagedCreateSuccessorInspection::NotFound if followed_successor => {
                let expected = expected_successor.take().ok_or_else(|| {
                    "hmux_managed_create_successor_invalid: unborn target has no predecessor edge"
                        .to_string()
                })?;
                return Ok(ManagedCreateSuccessorChainResolution::UnbornSuccessor {
                    chain: ManagedCreateSuccessorChain::new(identities, prior_stop_receipts),
                    expected,
                });
            }
            ManagedCreateSuccessorInspection::NotFound if recovered_ancestor => {
                return Err(
                    "hmux_managed_create_successor_invalid: recovered ancestor has no create record"
                        .to_string(),
                );
            }
            ManagedCreateSuccessorInspection::NotFound => {
                return Ok(ManagedCreateSuccessorChainResolution::NotFound);
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::Pending,
                slot,
                ..
            } => {
                if matches!(mode, ManagedCreateSuccessorChainMode::ClaimCleanup) {
                    if let ManagedCreateSuccessorSlot::Vacant(reservation) = slot {
                        close_successor_slot(*reservation, &current)
                            .map_err(|error| error.to_string())?;
                    }
                }
                return Ok(ManagedCreateSuccessorChainResolution::Pending {
                    chain: ManagedCreateSuccessorChain::new(identities, prior_stop_receipts),
                });
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::Retiring(stop_receipt),
                slot,
                ..
            } => {
                if matches!(mode, ManagedCreateSuccessorChainMode::ClaimCleanup) {
                    if let ManagedCreateSuccessorSlot::Vacant(reservation) = slot {
                        close_successor_slot(*reservation, &current)
                            .map_err(|error| error.to_string())?;
                    }
                }
                return Ok(ManagedCreateSuccessorChainResolution::Retiring {
                    chain: ManagedCreateSuccessorChain::new(identities, prior_stop_receipts),
                    stop_receipt,
                });
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::CleanupClosed,
                ..
            } => {
                return Ok(
                    ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                        chain: ManagedCreateSuccessorChain::new(identities, prior_stop_receipts),
                        stop_receipt: None,
                    },
                );
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::Completed(receipt),
                slot,
                ..
            } => {
                if matches!(mode, ManagedCreateSuccessorChainMode::ClaimCleanup) {
                    if let ManagedCreateSuccessorSlot::Vacant(reservation) = slot {
                        close_successor_slot(*reservation, &current)
                            .map_err(|error| error.to_string())?;
                    }
                }
                return Ok(ManagedCreateSuccessorChainResolution::Completed {
                    chain: ManagedCreateSuccessorChain::new(identities, prior_stop_receipts),
                    receipt,
                });
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::Terminal { stop_receipt },
                slot: ManagedCreateSuccessorSlot::Existing(successor),
                ..
            } => {
                if let Some(stop_receipt) = stop_receipt {
                    prior_stop_receipts.push(*stop_receipt);
                }
                let successor = *successor;
                expected_successor = Some(successor.clone());
                current = ManagedCreateReconcileRequest::new(
                    successor.idempotency_key(),
                    successor.session_id(),
                    current.workspace_id(),
                )
                .map_err(|error| format!("hmux_managed_create_successor_invalid: {error}"))?;
                followed_successor = true;
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::Terminal { stop_receipt },
                slot: ManagedCreateSuccessorSlot::Vacant(reservation),
                ..
            } => {
                if matches!(mode, ManagedCreateSuccessorChainMode::ClaimCleanup) {
                    close_successor_slot(*reservation, &current)
                        .map_err(|error| error.to_string())?;
                }
                return Ok(
                    ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                        chain: ManagedCreateSuccessorChain::new(identities, prior_stop_receipts),
                        stop_receipt,
                    },
                );
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::Terminal { stop_receipt },
                slot: ManagedCreateSuccessorSlot::Closed,
                ..
            } => {
                return Ok(
                    ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                        chain: ManagedCreateSuccessorChain::new(identities, prior_stop_receipts),
                        stop_receipt,
                    },
                );
            }
        }
    }
}

fn record_has_direct_cleanup_fence(record: &ManagedCreateLedgerRecord) -> bool {
    matches!(
        record.state,
        ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission
    ) || matches!(
        record
            .authority
            .as_ref()
            .map(|authority| &authority.successor),
        Some(ManagedCreateSuccessorSlotV3::Closed { .. })
    )
}

fn successor_cleanup_is_closed(
    directory: &Path,
    index: usize,
    record_key: &str,
    source: &ManagedCreateReconcileRequest,
) -> Result<bool, ManagedCreateAdmissionError> {
    let (successors, _) = read_successor_topology_snapshot(directory, index)?;
    let Some(record) = successors.records.get(record_key) else {
        return Ok(false);
    };
    validate_successor_record(record, source, record_key, index)?;
    Ok(record.successor.is_none())
}

fn read_successor_topology_snapshot(
    directory: &Path,
    index: usize,
) -> Result<
    (
        ManagedCreateSuccessorShard,
        ManagedCreateSuccessorDigestShard,
    ),
    ManagedCreateAdmissionError,
> {
    #[cfg(test)]
    note_frozen_predecessor_forward_read();
    read_successor_topology_snapshot_with_interleave(directory, index, || {})
}

#[cfg(test)]
thread_local! {
    static FROZEN_PREDECESSOR_FORWARD_READS: std::cell::Cell<Option<usize>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn note_frozen_predecessor_forward_read() {
    FROZEN_PREDECESSOR_FORWARD_READS.with(|reads| {
        if let Some(current) = reads.get() {
            reads.set(Some(current + 1));
        }
    });
}

#[cfg(all(test, unix))]
fn measure_frozen_predecessor_forward_reads<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    FROZEN_PREDECESSOR_FORWARD_READS.with(|reads| {
        assert_eq!(reads.replace(Some(0)), None);
        let result = operation();
        let measured = reads.replace(None).unwrap();
        (result, measured)
    })
}

fn read_successor_topology_snapshot_with_interleave<F>(
    directory: &Path,
    index: usize,
    after_digest_snapshot: F,
) -> Result<
    (
        ManagedCreateSuccessorShard,
        ManagedCreateSuccessorDigestShard,
    ),
    ManagedCreateAdmissionError,
>
where
    F: FnOnce(),
{
    // Writers publish the immutable v1 edge before its optional digest
    // projection. Reading in the opposite order means every unlocked pair is
    // either one complete generation or an older digest projection paired
    // with a newer edge set. A newer digest can therefore never be paired
    // with an older edge set and misclassified as corruption.
    let successor_digest_path = directory.join(format!("successor_digest_{index:02x}.json"));
    let successor_digests = read_successor_digest_shard_or_default(&successor_digest_path)?;
    after_digest_snapshot();
    let successor_path = directory.join(format!("successor_{index:02x}.json"));
    let successors = read_successor_shard_or_default(&successor_path)?;
    validate_successor_shard(&successors, index)?;
    validate_successor_digest_shard(&successor_digests, &successors, index)?;
    Ok((successors, successor_digests))
}

fn predecessor_shard_paths(
    directory: &Path,
    target_key: &str,
) -> Result<(PathBuf, PathBuf, usize), ManagedCreateAdmissionError> {
    let index = shard_index(target_key).map_err(ManagedCreateAdmissionError::Ledger)?;
    Ok((
        directory.join(format!("successor_predecessor_{index:02x}.lock")),
        directory.join(format!("successor_predecessor_{index:02x}.json")),
        index,
    ))
}

fn read_successor_predecessor_coverage(
    directory: &Path,
) -> Result<Option<CompleteSuccessorPredecessorCoverage>, ManagedCreateAdmissionError> {
    let path = directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE);
    if !private_path_exists(&path)? {
        return Ok(None);
    }
    let mut file = open_private_existing(&path, "managed create predecessor coverage receipt")?;
    let metadata = file.metadata().map_err(|_| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor coverage receipt is unreadable"
                .to_string(),
        )
    })?;
    if metadata.len() > MAX_RECORD_BYTES {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor coverage receipt is too large"
                .to_string(),
        ));
    }
    let mut payload = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|_| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: predecessor coverage receipt is unreadable"
                    .to_string(),
            )
        })?;
    if payload.len() as u64 > MAX_RECORD_BYTES {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor coverage receipt is too large"
                .to_string(),
        ));
    }
    ensure_same_open_file(&path, &file)?;
    let receipt: ManagedCreateSuccessorPredecessorCoverageReceipt =
        serde_json::from_slice(&payload).map_err(|_| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: predecessor coverage receipt is malformed"
                    .to_string(),
            )
        })?;
    match receipt.schema_version {
        LEGACY_SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION
            if receipt.legacy_source_shards_by_target.is_empty()
                && receipt.locator_shards.is_empty() =>
        {
            Ok(Some(
                CompleteSuccessorPredecessorCoverage::LegacyReverseIndex,
            ))
        }
        LEGACY_BITMAP_SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION
            if receipt.legacy_source_shards_by_target.len() == LEDGER_SHARDS
                && receipt.locator_shards.is_empty() =>
        {
            Ok(Some(
                CompleteSuccessorPredecessorCoverage::LegacyBitmapRequiresUpgrade,
            ))
        }
        SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION => {
            if !receipt.legacy_source_shards_by_target.is_empty() {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "hmux_managed_create_successor_invalid: predecessor coverage locator changed"
                        .to_string(),
                ));
            }
            let coverage = predecessor_locator::Coverage::from_receipt(receipt.locator_shards)?;
            Ok(Some(
                CompleteSuccessorPredecessorCoverage::FrozenForwardLocator { coverage },
            ))
        }
        _ => Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor coverage schema changed"
                .to_string(),
        )),
    }
}

fn ensure_successor_predecessor_coverage(
    directory: &Path,
) -> Result<CompleteSuccessorPredecessorCoverage, ManagedCreateAdmissionError> {
    ensure_successor_predecessor_coverage_with_interleave(directory, |_| Ok(()))
}

fn ensure_successor_predecessor_coverage_with_interleave<F>(
    directory: &Path,
    mut after_successor_shard: F,
) -> Result<CompleteSuccessorPredecessorCoverage, ManagedCreateAdmissionError>
where
    F: FnMut(usize) -> Result<(), ManagedCreateAdmissionError>,
{
    if let Some(coverage) = read_successor_predecessor_coverage(directory)? {
        if !matches!(
            &coverage,
            CompleteSuccessorPredecessorCoverage::LegacyBitmapRequiresUpgrade
        ) {
            return Ok(coverage);
        }
    }
    let coverage_lock_path = directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_LOCK);
    let _coverage_lock = RecoveryLock::acquire_admission(open_private_lock(&coverage_lock_path)?)
        .map_err(|_| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_failed: predecessor coverage lock acquisition failed"
                .to_string(),
        )
    })?;
    if let Some(coverage) = read_successor_predecessor_coverage(directory)? {
        if !matches!(
            &coverage,
            CompleteSuccessorPredecessorCoverage::LegacyBitmapRequiresUpgrade
        ) {
            return Ok(coverage);
        }
    }

    // Every shard is materialized as v3 before any forward-edge scan. A
    // retained indexed-v2 writer either completes under its shard lock before
    // this fence or observes the newer schema and cannot publish afterward.
    // Where supported, empty shards are hard links to one already-synced
    // immutable template. Later writes use atomic replacement, so the links
    // stop sharing an inode before any shard content changes. Filesystems
    // without hard-link support use the ordinary private atomic shard writer.
    let empty_v3_fence = ensure_empty_v3_create_shard_fence(directory)?;
    for index in 0..LEDGER_SHARDS {
        let lock_path = directory.join(format!("shard_{index:02x}.lock"));
        let shard_path = directory.join(format!("shard_{index:02x}.json"));
        let _shard_lock = acquire_shard_lock(&lock_path)?;
        let existed = private_path_exists(&shard_path)?;
        let mut shard = read_shard_or_default(&shard_path)?;
        validate_shard(&shard, index)?;
        if !existed || shard.schema_version != LEDGER_SHARD_SCHEMA_VERSION {
            shard.schema_version = LEDGER_SHARD_SCHEMA_VERSION;
            if shard.records.is_empty() {
                if existed {
                    replace_with_empty_v3_create_shard_fence(
                        directory,
                        &empty_v3_fence,
                        &shard_path,
                    )?;
                } else {
                    link_empty_v3_create_shard_fence_at_absent_path(
                        directory,
                        &empty_v3_fence,
                        &shard_path,
                    )?;
                }
            } else {
                write_shard(directory, &shard_path, &shard)?;
            }
        }
    }
    sync_private_directory(directory)?;

    let mut locator_entries = Vec::new();
    for source_index in 0..LEDGER_SHARDS {
        index_legacy_successor_source_shard(directory, source_index, &mut locator_entries)?;
        after_successor_shard(source_index)?;
    }
    let coverage = predecessor_locator::publish(directory, &mut locator_entries)?;
    after_successor_shard(LEDGER_SHARDS)?;

    let receipt = ManagedCreateSuccessorPredecessorCoverageReceipt {
        schema_version: SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION,
        legacy_source_shards_by_target: Vec::new(),
        locator_shards: coverage.receipt_shards(),
    };
    write_successor_shard(
        directory,
        &directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE),
        &receipt,
    )?;
    Ok(CompleteSuccessorPredecessorCoverage::FrozenForwardLocator { coverage })
}

fn ensure_empty_v3_create_shard_fence(directory: &Path) -> Result<PathBuf, String> {
    let path = directory.join(EMPTY_V3_CREATE_SHARD_FENCE_FILE);
    if private_path_exists(&path)? {
        let shard = read_shard_or_default(&path)?;
        if shard != ManagedCreateLedgerShard::default() {
            return Err(
                "hmux_managed_create_ledger_invalid: empty v3 shard fence changed".to_string(),
            );
        }
        return Ok(path);
    }
    write_shard(directory, &path, &ManagedCreateLedgerShard::default())?;
    Ok(path)
}

fn link_empty_v3_create_shard_fence_at_absent_path(
    directory: &Path,
    fence_path: &Path,
    shard_path: &Path,
) -> Result<(), String> {
    if hard_link_empty_v3_create_shard(fence_path, shard_path).is_err() {
        return write_shard(directory, shard_path, &ManagedCreateLedgerShard::default());
    }
    let linked = open_private_existing(shard_path, "managed create coverage shard")?;
    ensure_same_open_file(shard_path, &linked)
}

fn replace_with_empty_v3_create_shard_fence(
    directory: &Path,
    fence_path: &Path,
    shard_path: &Path,
) -> Result<(), String> {
    let stem = shard_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "hmux_managed_create_ledger_invalid: shard path is malformed".to_string())?;
    let temporary = directory.join(format!(".{stem}.coverage.tmp"));
    if private_path_exists(&temporary)? {
        let stale = open_private_existing(&temporary, "managed create coverage temporary shard")?;
        ensure_same_open_file(&temporary, &stale)?;
        fs::remove_file(&temporary).map_err(|_| {
            "hmux_managed_create_ledger_failed: stale coverage temporary removal failed".to_string()
        })?;
    }
    if hard_link_empty_v3_create_shard(fence_path, &temporary).is_err() {
        return write_shard(directory, shard_path, &ManagedCreateLedgerShard::default());
    }
    let linked = open_private_existing(&temporary, "managed create coverage temporary shard")?;
    ensure_same_open_file(&temporary, &linked)?;
    if private_path_exists(shard_path)? {
        let existing = open_private_existing(shard_path, "managed create ledger shard")?;
        ensure_same_open_file(shard_path, &existing)?;
    }
    replace_private_file(&temporary, shard_path).map_err(|_| {
        "hmux_managed_create_ledger_failed: empty v3 shard fence publish failed".to_string()
    })
}

#[cfg(test)]
thread_local! {
    static INJECT_EMPTY_V3_CREATE_SHARD_HARD_LINK_FAILURE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

fn hard_link_empty_v3_create_shard(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if INJECT_EMPTY_V3_CREATE_SHARD_HARD_LINK_FAILURE.with(std::cell::Cell::get) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "injected empty v3 create-shard hard-link failure",
        ));
    }
    fs::hard_link(source, target)
}

fn index_legacy_successor_source_shard(
    directory: &Path,
    source_index: usize,
    locator_entries: &mut Vec<predecessor_locator::Entry>,
) -> Result<(), ManagedCreateAdmissionError> {
    let (successors, _) = read_successor_topology_snapshot(directory, source_index)?;
    for (source_key, record) in &successors.records {
        let source = ManagedCreateReconcileRequest::new(
            &record.source_idempotency_key,
            &record.source_session_id,
            &record.workspace_id,
        )
        .map_err(|error| {
            ManagedCreateAdmissionError::Ledger(format!(
                "hmux_managed_create_successor_invalid: {error}"
            ))
        })?;
        validate_successor_record(record, &source, source_key, source_index)?;
        let Some(successor) = &record.successor else {
            continue;
        };
        let target = ManagedCreateReconcileRequest::new(
            successor.idempotency_key(),
            successor.session_id(),
            source.workspace_id(),
        )
        .map_err(|error| {
            ManagedCreateAdmissionError::Ledger(format!(
                "hmux_managed_create_successor_invalid: {error}"
            ))
        })?;
        let target_key = logical_key(target.workspace_id(), target.session_id());
        locator_entries.push(predecessor_locator::Entry::new(
            &target_key,
            source_index,
            source_key,
        )?);
    }
    Ok(())
}

fn scan_frozen_legacy_predecessor(
    directory: &Path,
    coverage: &CompleteSuccessorPredecessorCoverage,
    target: &ManagedCreateReconcileRequest,
) -> Result<Option<ManagedCreateReconcileRequest>, ManagedCreateAdmissionError> {
    let coverage = match coverage {
        CompleteSuccessorPredecessorCoverage::LegacyReverseIndex => return Ok(None),
        CompleteSuccessorPredecessorCoverage::LegacyBitmapRequiresUpgrade => {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: predecessor coverage locator upgrade is incomplete"
                    .to_string(),
            ));
        }
        CompleteSuccessorPredecessorCoverage::FrozenForwardLocator { coverage } => coverage,
    };
    let target_key = logical_key(target.workspace_id(), target.session_id());
    match predecessor_locator::lookup(directory, coverage, &target_key)? {
        None => Ok(None),
        Some(predecessor_locator::LocatedAuthority::Conflict) => {
            Err(ManagedCreateAdmissionError::SuccessorLineageConflict)
        }
        Some(predecessor_locator::LocatedAuthority::Edge {
            source_shard,
            source_record_key,
        }) => read_frozen_predecessor_forward_edge(
            directory,
            source_shard,
            &source_record_key,
            target,
        )
        .map(Some),
    }
}

fn read_frozen_predecessor_forward_edge(
    directory: &Path,
    source_index: usize,
    source_key: &str,
    target: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateReconcileRequest, ManagedCreateAdmissionError> {
    if shard_index(source_key).map_err(ManagedCreateAdmissionError::Ledger)? != source_index {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor locator source changed".to_string(),
        ));
    }
    let (successors, _) = read_successor_topology_snapshot(directory, source_index)?;
    let record = successors.records.get(source_key).ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: located forward edge disappeared".to_string(),
        )
    })?;
    let source = ManagedCreateReconcileRequest::new(
        &record.source_idempotency_key,
        &record.source_session_id,
        &record.workspace_id,
    )
    .map_err(|error| {
        ManagedCreateAdmissionError::Ledger(format!(
            "hmux_managed_create_successor_invalid: {error}"
        ))
    })?;
    validate_successor_record(record, &source, source_key, source_index)?;
    let successor = record.successor.as_ref().ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: located forward edge changed".to_string(),
        )
    })?;
    if record.workspace_id != target.workspace_id() || successor.session_id() != target.session_id()
    {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor locator target changed".to_string(),
        ));
    }
    if successor.idempotency_key() != target.idempotency_key() {
        return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
    }
    Ok(source)
}

fn reserve_successor_predecessor_projection(
    directory: &Path,
    source: &ManagedCreateReconcileRequest,
    successor: &ManagedCreateSuccessorIdentity,
) -> Result<SuccessorPredecessorReservation, ManagedCreateAdmissionError> {
    let target = ManagedCreateReconcileRequest::new(
        successor.idempotency_key(),
        successor.session_id(),
        source.workspace_id(),
    )
    .map_err(|error| {
        ManagedCreateAdmissionError::Ledger(format!(
            "hmux_managed_create_successor_invalid: {error}"
        ))
    })?;
    let locked = lock_successor_predecessor_shard(directory, &target)?;
    let authority = ManagedCreateSuccessorPredecessorAuthority::Predecessor {
        predecessor: source.clone(),
        edge_fingerprint: successor_edge_fingerprint(source, successor)?,
    };
    if read_successor_predecessor_coverage(directory)?.is_some() {
        if locked.shard.records.contains_key(&locked.target_key) {
            let mut verified = locked.reserve(&target, authority)?;
            verified.payload = None;
            return Ok(verified);
        }
        return Ok(locked.hold());
    }
    locked.reserve(&target, authority)
}

fn lock_successor_predecessor_shard(
    directory: &Path,
    target: &ManagedCreateReconcileRequest,
) -> Result<LockedSuccessorPredecessorShard, ManagedCreateAdmissionError> {
    let target_key = logical_key(target.workspace_id(), target.session_id());
    let (lock_path, shard_path, index) = predecessor_shard_paths(directory, &target_key)?;
    let lock = RecoveryLock::acquire_admission(open_private_lock(&lock_path)?).map_err(|_| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_failed: predecessor lock acquisition failed".to_string(),
        )
    })?;
    let shard: ManagedCreateSuccessorPredecessorShard =
        read_successor_state_or_default(&shard_path)?;
    validate_successor_predecessor_shard(&shard, index)?;
    Ok(LockedSuccessorPredecessorShard {
        directory: directory.to_path_buf(),
        shard_path,
        target_key,
        shard,
        lock,
    })
}

impl LockedSuccessorPredecessorShard {
    fn reserve(
        mut self,
        target: &ManagedCreateReconcileRequest,
        authority: ManagedCreateSuccessorPredecessorAuthority,
    ) -> Result<SuccessorPredecessorReservation, ManagedCreateAdmissionError> {
        let projected = successor_predecessor_record(target, authority);
        let changed =
            merge_successor_predecessor_record(&mut self.shard, &self.target_key, projected)?;
        let payload = changed
            .then(|| serialize_successor_shard(&self.shard))
            .transpose()?;
        Ok(SuccessorPredecessorReservation {
            directory: self.directory,
            shard_path: self.shard_path,
            payload,
            _lock: self.lock,
        })
    }

    fn hold(self) -> SuccessorPredecessorReservation {
        SuccessorPredecessorReservation {
            directory: self.directory,
            shard_path: self.shard_path,
            payload: None,
            _lock: self.lock,
        }
    }
}

fn successor_predecessor_record(
    target: &ManagedCreateReconcileRequest,
    authority: ManagedCreateSuccessorPredecessorAuthority,
) -> ManagedCreateSuccessorPredecessorRecord {
    ManagedCreateSuccessorPredecessorRecord {
        schema_version: SUCCESSOR_PREDECESSOR_LEDGER_SCHEMA_VERSION,
        workspace_id: target.workspace_id().to_string(),
        target_session_id: target.session_id().to_string(),
        target_idempotency_key: target.idempotency_key().to_string(),
        authority,
        created_unix_ms: unix_time_ms(),
    }
}

fn merge_successor_predecessor_record(
    shard: &mut ManagedCreateSuccessorPredecessorShard,
    target_key: &str,
    projected: ManagedCreateSuccessorPredecessorRecord,
) -> Result<bool, ManagedCreateAdmissionError> {
    let Some(record) = shard.records.get(target_key) else {
        if shard.records.len() >= MAX_SHARD_RECORDS {
            return Err(ManagedCreateAdmissionError::Ledger(format!(
                "hmux_managed_create_successor_capacity: predecessor shard reached {MAX_SHARD_RECORDS} logical sessions"
            )));
        }
        shard.records.insert(target_key.to_string(), projected);
        return Ok(true);
    };
    if record.authority == projected.authority {
        return Ok(false);
    }
    let upgrade_root = matches!(
        (&record.authority, &projected.authority),
        (
            ManagedCreateSuccessorPredecessorAuthority::Root {
                create_fingerprint: current_fingerprint,
                legacy_predecessor_absence_proven: false,
            },
            ManagedCreateSuccessorPredecessorAuthority::Root {
                create_fingerprint: projected_fingerprint,
                legacy_predecessor_absence_proven: true,
            },
        ) if current_fingerprint == projected_fingerprint
    );
    let replace_unproven_root = matches!(
        (&record.authority, &projected.authority),
        (
            ManagedCreateSuccessorPredecessorAuthority::Root {
                legacy_predecessor_absence_proven: false,
                ..
            },
            ManagedCreateSuccessorPredecessorAuthority::Predecessor { .. },
        )
    );
    if !upgrade_root && !replace_unproven_root {
        return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
    }
    let mut upgraded = record.clone();
    upgraded.authority = projected.authority;
    shard.records.insert(target_key.to_string(), upgraded);
    Ok(true)
}

impl SuccessorPredecessorReservation {
    fn publish(&mut self) -> Result<(), ManagedCreateAdmissionError> {
        if let Some(payload) = self.payload.take() {
            write_bounded_successor_shard(&self.directory, &self.shard_path, payload)?;
        }
        Ok(())
    }
}

fn admit_create_lineage(
    discovery_root: &Path,
    predecessor_coverage: &CompleteSuccessorPredecessorCoverage,
    target: &ManagedCreateReconcileRequest,
    create_record: &mut ManagedCreateLedgerRecord,
    create_shard: &ManagedCreateLedgerShard,
    admission: ManagedCreateLineageAdmission,
    record_is_new: bool,
) -> Result<Option<SuccessorPredecessorReservation>, ManagedCreateAdmissionError> {
    if record_is_new && matches!(admission, ManagedCreateLineageAdmission::Root) {
        return prove_root_lineage(discovery_root, predecessor_coverage, target, create_record);
    }
    if let Some(authority) = &create_record.authority {
        match (&authority.lineage, admission) {
            (ManagedCreateLineageAuthorityV3::Root { .. }, ManagedCreateLineageAdmission::Root) => {
                return prove_root_lineage(
                    discovery_root,
                    predecessor_coverage,
                    target,
                    create_record,
                );
            }
            (
                ManagedCreateLineageAuthorityV3::Predecessor { source, .. },
                ManagedCreateLineageAdmission::Successor,
            ) => {
                let source_key = logical_key(source.workspace_id(), source.session_id());
                let source_record = create_shard.records.get(&source_key).ok_or_else(|| {
                    ManagedCreateAdmissionError::Ledger(
                        "hmux_managed_create_successor_invalid: predecessor create authority is absent"
                            .to_string(),
                    )
                })?;
                ensure_successor_predecessor_record_terminal(source_record)?;
                return Ok(None);
            }
            (ManagedCreateLineageAuthorityV3::LegacyV2, _) => {}
            (ManagedCreateLineageAuthorityV3::Root { .. }, _) => {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "hmux_managed_create_successor_conflict: Root create authority is already claimed"
                        .to_string(),
                ));
            }
            (ManagedCreateLineageAuthorityV3::Predecessor { .. }, _) => {
                return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
            }
        }
    }
    // A retained v2 Root-pending record is its explicit write-ahead marker.
    // Successor admission can never reinterpret that legacy Root authority.
    if matches!(
        &create_record.state,
        ManagedCreateLedgerRecordState::RootLineagePending
    ) {
        return match admission {
            ManagedCreateLineageAdmission::Root => {
                prove_legacy_root_projection(discovery_root, predecessor_coverage, target).map(Some)
            }
            ManagedCreateLineageAdmission::Successor => Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_conflict: Root create authority is already claimed"
                    .to_string(),
            )),
        };
    }
    match (
        admission,
        predecessor_projection_with_coverage(discovery_root, predecessor_coverage, target)?,
    ) {
        (
            ManagedCreateLineageAdmission::Root,
            ManagedCreateSuccessorPredecessorProjection::Missing,
        ) => prove_legacy_root_projection(discovery_root, predecessor_coverage, target).map(Some),
        (
            ManagedCreateLineageAdmission::Root,
            ManagedCreateSuccessorPredecessorProjection::Root,
        ) => Ok(None),
        (
            ManagedCreateLineageAdmission::Root,
            ManagedCreateSuccessorPredecessorProjection::Predecessor(_),
        ) => Err(ManagedCreateAdmissionError::SuccessorLineageConflict),
        (
            ManagedCreateLineageAdmission::Successor,
            ManagedCreateSuccessorPredecessorProjection::Predecessor(source),
        ) => {
            ensure_successor_predecessor_terminal(discovery_root, &source)?;
            Ok(None)
        }
        (
            ManagedCreateLineageAdmission::Successor,
            ManagedCreateSuccessorPredecessorProjection::Root
            | ManagedCreateSuccessorPredecessorProjection::Missing,
        ) => Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: successor create has no predecessor authority"
                .to_string(),
        )),
    }
}

fn prove_root_lineage(
    discovery_root: &Path,
    predecessor_coverage: &CompleteSuccessorPredecessorCoverage,
    target: &ManagedCreateReconcileRequest,
    create_record: &mut ManagedCreateLedgerRecord,
) -> Result<Option<SuccessorPredecessorReservation>, ManagedCreateAdmissionError> {
    let Some(ManagedCreateLedgerAuthorityV3 {
        lineage: ManagedCreateLineageAuthorityV3::Root { .. },
        ..
    }) = create_record.authority.as_ref()
    else {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: Root proof has no Root create authority"
                .to_string(),
        ));
    };
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    let locked = lock_successor_predecessor_shard(&directory, target)?;
    if let Some(projected) = locked.shard.records.get(&locked.target_key) {
        match &projected.authority {
            ManagedCreateSuccessorPredecessorAuthority::Predecessor { .. } => {
                verify_successor_predecessor_projection(discovery_root, projected, target)?;
                return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
            }
            ManagedCreateSuccessorPredecessorAuthority::Root {
                legacy_predecessor_absence_proven: true,
                ..
            } => {
                verify_successor_root_projection(discovery_root, projected, target)?;
                mark_root_lineage_proven(create_record)?;
                return Ok(Some(locked.hold()));
            }
            ManagedCreateSuccessorPredecessorAuthority::Root {
                legacy_predecessor_absence_proven: false,
                ..
            } => {
                verify_successor_root_projection(discovery_root, projected, target)?;
            }
        }
    }
    if scan_frozen_legacy_predecessor(&directory, predecessor_coverage, target)?.is_some() {
        return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
    }
    mark_root_lineage_proven(create_record)?;
    Ok(Some(locked.hold()))
}

fn prove_legacy_root_projection(
    discovery_root: &Path,
    predecessor_coverage: &CompleteSuccessorPredecessorCoverage,
    target: &ManagedCreateReconcileRequest,
) -> Result<SuccessorPredecessorReservation, ManagedCreateAdmissionError> {
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    let locked = lock_successor_predecessor_shard(&directory, target)?;
    if let Some(projected) = locked.shard.records.get(&locked.target_key) {
        match &projected.authority {
            ManagedCreateSuccessorPredecessorAuthority::Predecessor { .. } => {
                verify_successor_predecessor_projection(discovery_root, projected, target)?;
                return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
            }
            ManagedCreateSuccessorPredecessorAuthority::Root {
                legacy_predecessor_absence_proven: true,
                ..
            } => {
                verify_successor_root_projection(discovery_root, projected, target)?;
                return Ok(locked.hold());
            }
            ManagedCreateSuccessorPredecessorAuthority::Root {
                legacy_predecessor_absence_proven: false,
                ..
            } => {
                verify_successor_root_projection(discovery_root, projected, target)?;
            }
        }
    }
    if scan_frozen_legacy_predecessor(&directory, predecessor_coverage, target)?.is_some() {
        return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
    }
    Ok(locked.hold())
}

fn mark_root_lineage_proven(
    create_record: &mut ManagedCreateLedgerRecord,
) -> Result<(), ManagedCreateAdmissionError> {
    let Some(ManagedCreateLedgerAuthorityV3 {
        lineage:
            ManagedCreateLineageAuthorityV3::Root {
                legacy_predecessor_absence_proven,
            },
        ..
    }) = create_record.authority.as_mut()
    else {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: Root proof authority changed".to_string(),
        ));
    };
    *legacy_predecessor_absence_proven = true;
    Ok(())
}

fn ensure_successor_predecessor_terminal(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
) -> Result<(), ManagedCreateAdmissionError> {
    let record = read_lineage_create_record(discovery_root, source)?.ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor create authority is absent"
                .to_string(),
        )
    })?;
    ensure_successor_predecessor_record_terminal(&record)
}

fn ensure_successor_predecessor_record_terminal(
    record: &ManagedCreateLedgerRecord,
) -> Result<(), ManagedCreateAdmissionError> {
    if matches!(
        &record.state,
        ManagedCreateLedgerRecordState::Completed {
            retired: true,
            retiring_stop_receipt: Some(_),
            ..
        } | ManagedCreateLedgerRecordState::RetiredBeforeCreateCompletion { .. }
            | ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion
    ) {
        Ok(())
    } else {
        Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor source is not terminal".to_string(),
        ))
    }
}

#[cfg(all(test, unix))]
fn predecessor_projection(
    discovery_root: &Path,
    target: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateSuccessorPredecessorProjection, ManagedCreateAdmissionError> {
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ManagedCreateSuccessorPredecessorProjection::Missing);
        }
        Err(_) => {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_ledger_invalid: ledger directory is unreadable".to_string(),
            ));
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let coverage = ensure_successor_predecessor_coverage(&directory)?;
    predecessor_projection_with_coverage(discovery_root, &coverage, target)
}

fn predecessor_projection_with_coverage(
    discovery_root: &Path,
    predecessor_coverage: &CompleteSuccessorPredecessorCoverage,
    target: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateSuccessorPredecessorProjection, ManagedCreateAdmissionError> {
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    if let Some(target_record) = read_lineage_create_record_from_directory(&directory, target)? {
        if let Some(projection) = direct_create_predecessor_projection(
            discovery_root,
            predecessor_coverage,
            target,
            &target_record,
        )? {
            return Ok(projection);
        }
    }
    let target_key = logical_key(target.workspace_id(), target.session_id());
    let (_, shard_path, index) = predecessor_shard_paths(&directory, &target_key)?;
    let shard: ManagedCreateSuccessorPredecessorShard =
        read_successor_state_or_default(&shard_path)?;
    validate_successor_predecessor_shard(&shard, index)?;
    if let Some(record) = shard.records.get(&target_key) {
        validate_successor_predecessor_record(record, target, &target_key, index)?;
        if !matches!(
            record.authority,
            ManagedCreateSuccessorPredecessorAuthority::Root {
                legacy_predecessor_absence_proven: false,
                ..
            }
        ) {
            return verify_successor_predecessor_projection(discovery_root, record, target);
        }
    }

    let locked = lock_successor_predecessor_shard(&directory, target)?;
    if let Some(record) = locked.shard.records.get(&locked.target_key) {
        validate_successor_predecessor_record(record, target, &locked.target_key, index)?;
        let unproven_root = matches!(
            &record.authority,
            ManagedCreateSuccessorPredecessorAuthority::Root {
                legacy_predecessor_absence_proven: false,
                ..
            }
        );
        if unproven_root {
            verify_successor_root_projection(discovery_root, record, target)?;
            if let Some(predecessor) =
                scan_frozen_legacy_predecessor(&directory, predecessor_coverage, target)?
            {
                return Ok(ManagedCreateSuccessorPredecessorProjection::Predecessor(
                    predecessor,
                ));
            }
            return Ok(ManagedCreateSuccessorPredecessorProjection::Root);
        }
        return verify_successor_predecessor_projection(discovery_root, record, target);
    }

    if let Some(predecessor) =
        scan_frozen_legacy_predecessor(&directory, predecessor_coverage, target)?
    {
        return Ok(ManagedCreateSuccessorPredecessorProjection::Predecessor(
            predecessor,
        ));
    }

    let Some(create_record) = read_lineage_create_record(discovery_root, target)? else {
        return Ok(ManagedCreateSuccessorPredecessorProjection::Missing);
    };
    if matches!(
        create_record.state,
        ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission
    ) {
        return Ok(ManagedCreateSuccessorPredecessorProjection::Missing);
    }
    if create_record.authority.as_ref().is_some_and(|authority| {
        !matches!(authority.lineage, ManagedCreateLineageAuthorityV3::LegacyV2)
    }) {
        drop(locked);
        return direct_create_predecessor_projection(
            discovery_root,
            predecessor_coverage,
            target,
            &create_record,
        )?
        .ok_or_else(|| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: direct lineage authority disappeared"
                    .to_string(),
            )
        });
    }
    Ok(ManagedCreateSuccessorPredecessorProjection::Root)
}

fn direct_create_predecessor_projection(
    discovery_root: &Path,
    predecessor_coverage: &CompleteSuccessorPredecessorCoverage,
    target: &ManagedCreateReconcileRequest,
    target_record: &ManagedCreateLedgerRecord,
) -> Result<Option<ManagedCreateSuccessorPredecessorProjection>, ManagedCreateAdmissionError> {
    let Some(authority) = &target_record.authority else {
        return Ok(None);
    };
    match &authority.lineage {
        ManagedCreateLineageAuthorityV3::Root {
            legacy_predecessor_absence_proven: true,
        } => {
            if scan_frozen_legacy_predecessor(
                &discovery_root.join(LEDGER_DIRECTORY),
                predecessor_coverage,
                target,
            )?
            .is_some()
            {
                return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
            }
            confirm_direct_root_projection(discovery_root, target).map(Some)
        }
        ManagedCreateLineageAuthorityV3::Root {
            legacy_predecessor_absence_proven: false,
        } => recover_unproven_root_lineage(discovery_root, predecessor_coverage, target).map(Some),
        ManagedCreateLineageAuthorityV3::Predecessor {
            source,
            edge_fingerprint,
        } => {
            if scan_frozen_legacy_predecessor(
                &discovery_root.join(LEDGER_DIRECTORY),
                predecessor_coverage,
                target,
            )?
            .is_some_and(|legacy_source| legacy_source != *source)
            {
                return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
            }
            let directory = discovery_root.join(LEDGER_DIRECTORY);
            let source_record = read_lineage_create_record_from_directory(&directory, source)?
                .ok_or_else(|| {
                    ManagedCreateAdmissionError::Ledger(
                        "hmux_managed_create_successor_invalid: v3 predecessor source is absent"
                            .to_string(),
                    )
                })?;
            let Some(ManagedCreateLedgerAuthorityV3 {
                successor:
                    ManagedCreateSuccessorSlotV3::Intent {
                        successor,
                        policy_digests,
                    },
                ..
            }) = source_record.authority.as_ref()
            else {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "hmux_managed_create_successor_invalid: v3 predecessor has no matching intent"
                        .to_string(),
                ));
            };
            let mut successor = successor.as_ref().clone();
            successor.policy_digests = policy_digests.clone();
            if successor.session_id() != target.session_id()
                || successor.idempotency_key() != target.idempotency_key()
                || successor_edge_fingerprint(source, &successor)? != *edge_fingerprint
            {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "hmux_managed_create_successor_invalid: v3 reverse lineage changed".to_string(),
                ));
            }
            ensure_expected_successor_record(&successor, target_record)?;
            confirm_direct_predecessor_projection(discovery_root, target, source, edge_fingerprint)
                .map(Some)
        }
        ManagedCreateLineageAuthorityV3::LegacyV2 => Ok(None),
    }
}

fn confirm_direct_predecessor_projection(
    discovery_root: &Path,
    target: &ManagedCreateReconcileRequest,
    source: &ManagedCreateReconcileRequest,
    edge_fingerprint: &str,
) -> Result<ManagedCreateSuccessorPredecessorProjection, ManagedCreateAdmissionError> {
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    let locked = lock_successor_predecessor_shard(&directory, target)?;
    let Some(record) = locked.shard.records.get(&locked.target_key) else {
        return Ok(ManagedCreateSuccessorPredecessorProjection::Predecessor(
            source.clone(),
        ));
    };
    let index = shard_index(&locked.target_key).map_err(ManagedCreateAdmissionError::Ledger)?;
    validate_successor_predecessor_record(record, target, &locked.target_key, index)?;
    match &record.authority {
        ManagedCreateSuccessorPredecessorAuthority::Predecessor {
            predecessor,
            edge_fingerprint: projected_fingerprint,
        } => {
            verify_successor_predecessor_projection(discovery_root, record, target)?;
            if predecessor != source || projected_fingerprint != edge_fingerprint {
                return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
            }
            Ok(ManagedCreateSuccessorPredecessorProjection::Predecessor(
                source.clone(),
            ))
        }
        ManagedCreateSuccessorPredecessorAuthority::Root { .. } => {
            verify_successor_root_projection(discovery_root, record, target)?;
            Err(ManagedCreateAdmissionError::SuccessorLineageConflict)
        }
    }
}

fn confirm_direct_root_projection(
    discovery_root: &Path,
    target: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateSuccessorPredecessorProjection, ManagedCreateAdmissionError> {
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    let locked = lock_successor_predecessor_shard(&directory, target)?;
    let Some(record) = locked.shard.records.get(&locked.target_key) else {
        return Ok(ManagedCreateSuccessorPredecessorProjection::Root);
    };
    let index = shard_index(&locked.target_key).map_err(ManagedCreateAdmissionError::Ledger)?;
    validate_successor_predecessor_record(record, target, &locked.target_key, index)?;
    match &record.authority {
        ManagedCreateSuccessorPredecessorAuthority::Predecessor { .. } => {
            verify_successor_predecessor_projection(discovery_root, record, target)?;
            Err(ManagedCreateAdmissionError::SuccessorLineageConflict)
        }
        ManagedCreateSuccessorPredecessorAuthority::Root {
            legacy_predecessor_absence_proven: true,
            ..
        } => {
            verify_successor_root_projection(discovery_root, record, target)?;
            Ok(ManagedCreateSuccessorPredecessorProjection::Root)
        }
        ManagedCreateSuccessorPredecessorAuthority::Root {
            legacy_predecessor_absence_proven: false,
            ..
        } => {
            verify_successor_root_projection(discovery_root, record, target)?;
            Ok(ManagedCreateSuccessorPredecessorProjection::Root)
        }
    }
}

fn recover_unproven_root_lineage(
    discovery_root: &Path,
    predecessor_coverage: &CompleteSuccessorPredecessorCoverage,
    target: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateSuccessorPredecessorProjection, ManagedCreateAdmissionError> {
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    let record_key = logical_key(target.workspace_id(), target.session_id());
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    let _create_lock = acquire_shard_lock(&lock_path)?;
    let mut shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let mut record = shard.records.get(&record_key).cloned().ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: Root proof has no create authority".to_string(),
        )
    })?;
    validate_record(&record, target.workspace_id(), target.session_id())?;
    if record.idempotency_key != target.idempotency_key() {
        return Err(ManagedCreateAdmissionError::SuccessorLineageConflict);
    }
    let authority_before = record.authority.clone();
    let mut lineage_lock =
        prove_root_lineage(discovery_root, predecessor_coverage, target, &mut record)?;
    if record.authority != authority_before {
        shard.records.insert(record_key, record);
        write_shard(&directory, &shard_path, &shard)?;
    }
    if let Some(lineage_lock) = lineage_lock.as_mut() {
        lineage_lock.publish()?;
    }
    Ok(ManagedCreateSuccessorPredecessorProjection::Root)
}

fn verify_successor_predecessor_projection(
    discovery_root: &Path,
    projected: &ManagedCreateSuccessorPredecessorRecord,
    target: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateSuccessorPredecessorProjection, ManagedCreateAdmissionError> {
    let ManagedCreateSuccessorPredecessorAuthority::Predecessor {
        predecessor: source,
        edge_fingerprint,
    } = &projected.authority
    else {
        verify_successor_root_projection(discovery_root, projected, target)?;
        return Ok(ManagedCreateSuccessorPredecessorProjection::Root);
    };
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    let record_key = logical_key(source.workspace_id(), source.session_id());
    let index = shard_index(&record_key).map_err(ManagedCreateAdmissionError::Ledger)?;
    let (successors, _) = read_successor_topology_snapshot(&directory, index)?;
    let Some(record) = successors.records.get(&record_key) else {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor projection has no forward edge"
                .to_string(),
        ));
    };
    validate_successor_record(record, source, &record_key, index)?;
    let successor = record.successor.as_ref().ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor projection targets a closure"
                .to_string(),
        )
    })?;
    if successor.session_id() != target.session_id()
        || successor.idempotency_key() != target.idempotency_key()
        || source.workspace_id() != target.workspace_id()
        || edge_fingerprint != &successor_edge_fingerprint(source, successor)?
    {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor projection fingerprint mismatch"
                .to_string(),
        ));
    }
    Ok(ManagedCreateSuccessorPredecessorProjection::Predecessor(
        source.clone(),
    ))
}

fn verify_successor_root_projection(
    discovery_root: &Path,
    projected: &ManagedCreateSuccessorPredecessorRecord,
    target: &ManagedCreateReconcileRequest,
) -> Result<(), ManagedCreateAdmissionError> {
    let ManagedCreateSuccessorPredecessorAuthority::Root {
        create_fingerprint, ..
    } = &projected.authority
    else {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: root projection authority changed".to_string(),
        ));
    };
    let record = read_lineage_create_record(discovery_root, target)?.ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: root projection has no create authority"
                .to_string(),
        )
    })?;
    if matches!(
        record.state,
        ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission
    ) || create_fingerprint != &managed_create_root_fingerprint(&record)
    {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: root projection fingerprint mismatch"
                .to_string(),
        ));
    }
    Ok(())
}

fn read_lineage_create_record(
    discovery_root: &Path,
    target: &ManagedCreateReconcileRequest,
) -> Result<Option<ManagedCreateLedgerRecord>, ManagedCreateAdmissionError> {
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    read_lineage_create_record_from_directory(&directory, target)
}

fn read_lineage_create_record_from_directory(
    directory: &Path,
    target: &ManagedCreateReconcileRequest,
) -> Result<Option<ManagedCreateLedgerRecord>, ManagedCreateAdmissionError> {
    let record_key = logical_key(target.workspace_id(), target.session_id());
    let (_, shard_path) =
        shard_paths(directory, &record_key).map_err(ManagedCreateAdmissionError::Ledger)?;
    if !private_path_exists(&shard_path)? {
        return Ok(None);
    }
    let shard = read_shard_or_default(&shard_path).map_err(ManagedCreateAdmissionError::Ledger)?;
    let index = shard_index(&record_key).map_err(ManagedCreateAdmissionError::Ledger)?;
    validate_shard(&shard, index).map_err(ManagedCreateAdmissionError::Ledger)?;
    let Some(record) = shard.records.get(&record_key) else {
        return Ok(None);
    };
    validate_record(record, target.workspace_id(), target.session_id())
        .map_err(ManagedCreateAdmissionError::Ledger)?;
    if record.idempotency_key != target.idempotency_key() {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: create lineage identity changed".to_string(),
        ));
    }
    Ok(Some(record.clone()))
}

/// Walks target-keyed lineage while verifying every hop against its immutable
/// forward edge. The one-time coverage receipt binds the exact target-sharded
/// locator trees used to prove a missing retained predecessor before absence
/// is accepted.
fn oldest_successor_ancestor(
    discovery_root: &Path,
    requested: &ManagedCreateReconcileRequest,
) -> Result<(ManagedCreateReconcileRequest, usize), ManagedCreateAdmissionError> {
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((requested.clone(), 1));
        }
        Err(_) => {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_ledger_invalid: ledger directory is unreadable".to_string(),
            ));
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let predecessor_coverage = ensure_successor_predecessor_coverage(&directory)?;

    let mut current = requested.clone();
    let mut visited = BTreeSet::new();
    loop {
        let current_key = (
            current.workspace_id().to_string(),
            current.session_id().to_string(),
            current.idempotency_key().to_string(),
        );
        if !visited.insert(current_key.clone()) {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: successor ancestry contains an identity cycle"
                    .to_string(),
            ));
        }
        if visited.len() > MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES {
            return Err(ManagedCreateAdmissionError::Ledger(format!(
                "hmux_managed_create_successor_capacity: successor chain exceeds {MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES} identities"
            )));
        }
        match predecessor_projection_with_coverage(discovery_root, &predecessor_coverage, &current)?
        {
            ManagedCreateSuccessorPredecessorProjection::Predecessor(predecessor) => {
                current = predecessor;
            }
            ManagedCreateSuccessorPredecessorProjection::Root
            | ManagedCreateSuccessorPredecessorProjection::Missing => {
                return Ok((current, visited.len()));
            }
        }
    }
}

/// Cancels an unlaunched successor. V3 updates its already-reserved target
/// record; retained v2 topology creates the legacy target tombstone.
#[cfg(any(feature = "local-runtime", test))]
pub fn claim_unborn_successor_cleanup(
    discovery_root: &Path,
    target: &ManagedCreateReconcileRequest,
    expected: &ManagedCreateSuccessorIdentity,
) -> Result<(), String> {
    target
        .validate()
        .map_err(|error| format!("hmux_managed_create_successor_invalid: {error}"))?;
    validate_successor_identity(expected).map_err(|error| error.to_string())?;
    if expected.session_id != target.session_id()
        || expected.idempotency_key != target.idempotency_key()
    {
        return Err(
            "hmux_managed_create_successor_invalid: unborn target changed edge identity"
                .to_string(),
        );
    }
    refuse_legacy_writer(discovery_root).map_err(|error| error.to_string())?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    ensure_private_directory(&directory).map_err(|error| error.to_string())?;
    let record_key = logical_key(target.workspace_id(), target.session_id());
    let (lock_path, shard_path) =
        shard_paths(&directory, &record_key).map_err(|error| error.to_string())?;
    let _target_lock = acquire_shard_lock(&lock_path).map_err(|error| error.to_string())?;
    let mut shard = read_shard_or_default(&shard_path).map_err(|error| error.to_string())?;
    let index = shard_index(&record_key).map_err(|error| error.to_string())?;
    validate_shard(&shard, index).map_err(|error| error.to_string())?;
    if let Some(record) = shard.records.get(&record_key).cloned() {
        validate_record(&record, target.workspace_id(), target.session_id())
            .map_err(|error| error.to_string())?;
        if record.idempotency_key != target.idempotency_key() {
            return Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict.to_string());
        }
        ensure_expected_successor_record(expected, &record).map_err(|error| error.to_string())?;
        if matches!(
            record.state,
            ManagedCreateLedgerRecordState::SuccessorLineagePending
        ) {
            let mut closed = record;
            closed.state = ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission;
            shard.records.insert(record_key, closed);
            write_shard(&directory, &shard_path, &shard)?;
        }
        return Ok(());
    }

    let successor_path = directory.join(format!("successor_{index:02x}.json"));
    let successors =
        read_successor_shard_or_default(&successor_path).map_err(|error| error.to_string())?;
    validate_successor_shard(&successors, index).map_err(|error| error.to_string())?;
    let successor_digest_path = directory.join(format!("successor_digest_{index:02x}.json"));
    let successor_digests = read_successor_digest_shard_or_default(&successor_digest_path)
        .map_err(|error| error.to_string())?;
    validate_successor_digest_shard(&successor_digests, &successors, index)
        .map_err(|error| error.to_string())?;
    if let Some(record) = successors.records.get(&record_key) {
        validate_successor_record(record, target, &record_key, index)
            .map_err(|error| error.to_string())?;
        if record.successor.is_some() {
            return Err(
                "hmux_managed_create_successor_invalid: unborn target already has a successor"
                    .to_string(),
            );
        }
    }

    if shard.records.len() >= MAX_SHARD_RECORDS {
        return Err(format!(
            "hmux_managed_create_ledger_capacity: shard reached {MAX_SHARD_RECORDS} logical sessions"
        ));
    }
    let record = ManagedCreateLedgerRecord {
        schema_version: LEDGER_RECORD_SCHEMA_VERSION_V2,
        workspace_id: target.workspace_id().to_string(),
        session_id: target.session_id().to_string(),
        idempotency_key: target.idempotency_key().to_string(),
        request_digest: expected.request_digest.clone(),
        conversation_identity: None,
        conversation_writer_released: false,
        canonical_rehost_recipe: None,
        created_unix_ms: unix_time_ms(),
        authority: None,
        state: ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission,
    };
    shard.records.insert(record_key, record);
    write_shard(&directory, &shard_path, &shard).map_err(|error| error.to_string())?;
    Ok(())
}

fn preflight_successor_source_ancestry(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
) -> Result<usize, ManagedCreateAdmissionError> {
    // Recovery of an unproven retained Root may write the source create shard.
    // Resolve it before inspect_successor_node returns that shard's lock.
    oldest_successor_ancestor(discovery_root, source).map(|(_, ancestry_len)| ancestry_len)
}

fn prepare_successor_candidate<F>(
    source: &ManagedCreateReconcileRequest,
    source_ancestry_len: usize,
    reservation: &SuccessorSlotReservation,
    allocate: &mut F,
) -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>
where
    F: FnMut() -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>,
{
    if source_ancestry_len >= MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES {
        return Err(ManagedCreateAdmissionError::Ledger(format!(
            "hmux_managed_create_successor_capacity: successor would exceed {MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES} identities"
        )));
    }
    if reservation.source_shard.records.len() >= MAX_SHARD_RECORDS {
        return Err(ManagedCreateAdmissionError::Ledger(format!(
            "hmux_managed_create_ledger_capacity: shard reached {MAX_SHARD_RECORDS} logical sessions"
        )));
    }
    let source_index = shard_index(&reservation.record_key)?;
    let mut attempted = BTreeSet::new();
    loop {
        let successor = allocate()?;
        validate_successor_identity(&successor)?;
        if successor.session_id == source.session_id()
            || successor.idempotency_key == source.idempotency_key()
        {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: successor reused the terminal source identity"
                    .to_string(),
            ));
        }
        let candidate = (
            successor.session_id.clone(),
            successor.idempotency_key.clone(),
        );
        if !attempted.insert(candidate) {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_conflict: target create authority is already claimed"
                    .to_string(),
            ));
        }
        let target_key = logical_key(source.workspace_id(), successor.session_id());
        if shard_index(&target_key)? != source_index {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: deterministic target is not in the source create shard"
                    .to_string(),
            ));
        }
        if !reservation.source_shard.records.contains_key(&target_key) {
            return Ok(successor);
        }
    }
}

fn single_successor_allocator<F>(
    allocate: F,
) -> impl FnMut() -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>
where
    F: FnOnce() -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>,
{
    let mut allocate = Some(allocate);
    move || match allocate.take() {
        Some(allocate) => allocate(),
        None => Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_conflict: target create authority is already claimed"
                .to_string(),
        )),
    }
}

/// Durably reserves one immutable successor intent before a caller retires a
/// live source. A forward edge on a non-terminal source is not actionable:
/// source terminal state remains the sole target-launch gate. Exact retries
/// replay an existing edge, including a legacy randomly allocated identity.
pub fn reserve_successor_intent<F>(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    allocate: F,
) -> Result<ManagedCreateSuccessorLedgerState, ManagedCreateAdmissionError>
where
    F: FnOnce() -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>,
{
    reserve_successor_intent_with_conversation(
        discovery_root,
        source,
        None,
        single_successor_allocator(allocate),
    )
}

pub fn reserve_successor_intent_with_conversation<F>(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    conversation_identity: Option<&ProviderConversationIdentitySeed>,
    allocate: F,
) -> Result<ManagedCreateSuccessorLedgerState, ManagedCreateAdmissionError>
where
    F: FnMut() -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>,
{
    reserve_successor_intent_with_conversation_and_lock_attempt(
        discovery_root,
        source,
        conversation_identity,
        || {},
        allocate,
    )
}

fn reserve_successor_intent_with_conversation_and_lock_attempt<B, F>(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    conversation_identity: Option<&ProviderConversationIdentitySeed>,
    before_conversation_lock: B,
    mut allocate: F,
) -> Result<ManagedCreateSuccessorLedgerState, ManagedCreateAdmissionError>
where
    B: FnOnce(),
    F: FnMut() -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>,
{
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    before_conversation_lock();
    let conversation_writer_admission = conversation_identity
        .map(|identity| begin_conversation_writer_admission(&directory, identity))
        .transpose()?;
    let released_claim = released_successor_conversation_writer_claim(
        discovery_root,
        conversation_writer_admission.as_ref(),
    )?;
    let mut preflight_ancestry_len = None;
    let (mut reservation, source_ancestry_len) = loop {
        match inspect_successor_node(discovery_root, source, None)? {
            ManagedCreateSuccessorInspection::NotFound => {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "hmux_managed_create_successor_invalid: intent source is absent".to_string(),
                ));
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::CleanupClosed,
                ..
            }
            | ManagedCreateSuccessorInspection::Found {
                slot: ManagedCreateSuccessorSlot::Closed,
                ..
            } => {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "hmux_managed_create_successor_invalid: successor intent slot is closed"
                        .to_string(),
                ));
            }
            ManagedCreateSuccessorInspection::Found {
                slot: ManagedCreateSuccessorSlot::Existing(successor),
                source_record,
                source_lock,
                ..
            } => {
                let _source_lock = source_lock;
                let successor = *successor;
                if let Err(error) = ensure_successor_conversation_writer_available(
                    conversation_writer_admission.as_ref(),
                    released_claim.as_ref(),
                    conversation_identity,
                    &source_record,
                    source,
                    &successor,
                ) {
                    return Ok(ManagedCreateSuccessorLedgerState::ExistingUnavailable {
                        successor,
                        error: Box::new(error),
                    });
                }
                if !successor_has_direct_lineage(discovery_root, source, &successor)? {
                    let mut predecessor = reserve_successor_predecessor_projection(
                        &discovery_root.join(LEDGER_DIRECTORY),
                        source,
                        &successor,
                    )?;
                    predecessor.publish()?;
                }
                return Ok(ManagedCreateSuccessorLedgerState::Existing(successor));
            }
            ManagedCreateSuccessorInspection::Found {
                slot: ManagedCreateSuccessorSlot::Vacant(reservation),
                ..
            } => {
                if let Some(ancestry_len) = preflight_ancestry_len {
                    break (reservation, ancestry_len);
                }
                drop(reservation);
                preflight_ancestry_len =
                    Some(preflight_successor_source_ancestry(discovery_root, source)?);
            }
        }
    };
    let successor =
        prepare_successor_candidate(source, source_ancestry_len, &reservation, &mut allocate)?;
    ensure_successor_conversation_identity(conversation_identity, &successor)?;
    ensure_successor_conversation_writer_available(
        conversation_writer_admission.as_ref(),
        released_claim.as_ref(),
        conversation_identity,
        &reservation.source_record,
        source,
        &successor,
    )?;
    publish_successor_candidate(&mut reservation, source, &successor, || Ok(()))?;
    Ok(ManagedCreateSuccessorLedgerState::Created(successor))
}

/// Reserves exactly one immutable successor for a terminal managed-create
/// source. Current records atomically own both directions and target capacity
/// in the source create shard; existing v2 edges replay through their
/// decode-only sibling topology, while a vacant v2 source upgrades to v3.
/// Returning `Pending` or `NotFound` never allocates.
pub fn reserve_terminal_successor<F>(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    allocate: F,
) -> Result<ManagedCreateSuccessorLedgerState, ManagedCreateAdmissionError>
where
    F: FnOnce() -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>,
{
    reserve_terminal_successor_with_conversation(
        discovery_root,
        source,
        None,
        single_successor_allocator(allocate),
    )
}

pub fn reserve_terminal_successor_with_conversation<F>(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    conversation_identity: Option<&ProviderConversationIdentitySeed>,
    allocate: F,
) -> Result<ManagedCreateSuccessorLedgerState, ManagedCreateAdmissionError>
where
    F: FnMut() -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>,
{
    reserve_terminal_successor_with_conversation_and_interleave(
        discovery_root,
        source,
        conversation_identity,
        allocate,
        || Ok(()),
    )
}

#[cfg(all(test, unix))]
fn reserve_terminal_successor_with_interleave<F, G>(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    allocate: F,
    after_atomic_publish: G,
) -> Result<ManagedCreateSuccessorLedgerState, ManagedCreateAdmissionError>
where
    F: FnMut() -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>,
    G: FnOnce() -> Result<(), ManagedCreateAdmissionError>,
{
    reserve_terminal_successor_with_conversation_and_interleave(
        discovery_root,
        source,
        None,
        allocate,
        after_atomic_publish,
    )
}

fn reserve_terminal_successor_with_conversation_and_interleave<F, G>(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    conversation_identity: Option<&ProviderConversationIdentitySeed>,
    mut allocate: F,
    after_atomic_publish: G,
) -> Result<ManagedCreateSuccessorLedgerState, ManagedCreateAdmissionError>
where
    F: FnMut() -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError>,
    G: FnOnce() -> Result<(), ManagedCreateAdmissionError>,
{
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    let conversation_writer_admission = conversation_identity
        .map(|identity| begin_conversation_writer_admission(&directory, identity))
        .transpose()?;
    let released_claim = released_successor_conversation_writer_claim(
        discovery_root,
        conversation_writer_admission.as_ref(),
    )?;
    let mut preflight_ancestry_len = None;
    let (mut reservation, source_ancestry_len) = loop {
        match inspect_successor_node(discovery_root, source, None)? {
            ManagedCreateSuccessorInspection::NotFound => {
                return Ok(ManagedCreateSuccessorLedgerState::NotFound);
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::CleanupClosed,
                ..
            } => return Ok(ManagedCreateSuccessorLedgerState::Closed),
            ManagedCreateSuccessorInspection::Found {
                slot: ManagedCreateSuccessorSlot::Closed,
                ..
            } => return Ok(ManagedCreateSuccessorLedgerState::Closed),
            ManagedCreateSuccessorInspection::Found { source, .. } if !source.is_terminal() => {
                return Ok(ManagedCreateSuccessorLedgerState::Pending);
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::Terminal { .. },
                slot: ManagedCreateSuccessorSlot::Existing(successor),
                source_record,
                source_lock,
            } => {
                let _source_lock = source_lock;
                let successor = *successor;
                if let Err(error) = ensure_successor_conversation_writer_available(
                    conversation_writer_admission.as_ref(),
                    released_claim.as_ref(),
                    conversation_identity,
                    &source_record,
                    source,
                    &successor,
                ) {
                    return Ok(ManagedCreateSuccessorLedgerState::ExistingUnavailable {
                        successor,
                        error: Box::new(error),
                    });
                }
                if !successor_has_direct_lineage(discovery_root, source, &successor)? {
                    let mut predecessor = reserve_successor_predecessor_projection(
                        &discovery_root.join(LEDGER_DIRECTORY),
                        source,
                        &successor,
                    )?;
                    predecessor.publish()?;
                }
                return Ok(ManagedCreateSuccessorLedgerState::Existing(successor));
            }
            ManagedCreateSuccessorInspection::Found {
                source: ManagedCreateSuccessorSourceState::Terminal { .. },
                slot: ManagedCreateSuccessorSlot::Vacant(reservation),
                ..
            } => {
                if let Some(ancestry_len) = preflight_ancestry_len {
                    break (reservation, ancestry_len);
                }
                drop(reservation);
                preflight_ancestry_len =
                    Some(preflight_successor_source_ancestry(discovery_root, source)?);
            }
            ManagedCreateSuccessorInspection::Found { .. } => {
                return Ok(ManagedCreateSuccessorLedgerState::Pending);
            }
        }
    };
    let successor =
        prepare_successor_candidate(source, source_ancestry_len, &reservation, &mut allocate)?;
    ensure_successor_conversation_identity(conversation_identity, &successor)?;
    ensure_successor_conversation_writer_available(
        conversation_writer_admission.as_ref(),
        released_claim.as_ref(),
        conversation_identity,
        &reservation.source_record,
        source,
        &successor,
    )?;
    publish_successor_candidate(&mut reservation, source, &successor, after_atomic_publish)?;
    Ok(ManagedCreateSuccessorLedgerState::Created(successor))
}

fn publish_successor_candidate<G>(
    reservation: &mut SuccessorSlotReservation,
    source: &ManagedCreateReconcileRequest,
    successor: &ManagedCreateSuccessorIdentity,
    after_atomic_publish: G,
) -> Result<(), ManagedCreateAdmissionError>
where
    G: FnOnce() -> Result<(), ManagedCreateAdmissionError>,
{
    let source_index =
        shard_index(&reservation.record_key).map_err(ManagedCreateAdmissionError::Ledger)?;
    let target_key = logical_key(
        reservation.source_record.workspace_id.as_str(),
        successor.session_id(),
    );
    if target_key == reservation.record_key || shard_index(&target_key)? != source_index {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: deterministic target is not in the source create shard"
                .to_string(),
        ));
    }
    if reservation.source_shard.records.contains_key(&target_key) {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_conflict: target create authority is already claimed"
                .to_string(),
        ));
    }
    if reservation.source_shard.records.len() >= MAX_SHARD_RECORDS {
        return Err(ManagedCreateAdmissionError::Ledger(format!(
            "hmux_managed_create_ledger_capacity: shard reached {MAX_SHARD_RECORDS} logical sessions"
        )));
    }
    let edge_fingerprint = successor_edge_fingerprint(source, successor)?;
    let policy = successor.policy_digests.as_ref().ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: target policy authority is absent".to_string(),
        )
    })?;
    if policy.rehost_recipe_digest.is_some() != policy.canonical_rehost_recipe.is_some() {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: target rehost authority is incomplete"
                .to_string(),
        ));
    }
    let canonical_rehost_recipe = policy.canonical_rehost_recipe.clone();
    let conversation_identity = policy.conversation_identity.clone();
    let source_authority =
        reservation
            .source_record
            .authority
            .get_or_insert(ManagedCreateLedgerAuthorityV3 {
                lineage: ManagedCreateLineageAuthorityV3::LegacyV2,
                successor: ManagedCreateSuccessorSlotV3::Vacant,
            });
    if !matches!(
        source_authority.successor,
        ManagedCreateSuccessorSlotV3::Vacant
    ) {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_conflict: v3 successor slot changed".to_string(),
        ));
    }
    source_authority.successor = ManagedCreateSuccessorSlotV3::Intent {
        successor: Box::new(successor.clone()),
        policy_digests: successor.policy_digests.clone(),
    };
    reservation.source_record.schema_version = LEDGER_RECORD_SCHEMA_VERSION;
    reservation.source_shard.schema_version = LEDGER_SHARD_SCHEMA_VERSION;
    reservation.source_shard.records.insert(
        reservation.record_key.clone(),
        reservation.source_record.clone(),
    );
    reservation.source_shard.records.insert(
        target_key,
        ManagedCreateLedgerRecord {
            schema_version: LEDGER_RECORD_SCHEMA_VERSION,
            workspace_id: source.workspace_id().to_string(),
            session_id: successor.session_id().to_string(),
            idempotency_key: successor.idempotency_key().to_string(),
            request_digest: successor_canonical_request_digest(successor).to_string(),
            conversation_identity,
            conversation_writer_released: false,
            canonical_rehost_recipe,
            created_unix_ms: unix_time_ms(),
            authority: Some(ManagedCreateLedgerAuthorityV3 {
                lineage: ManagedCreateLineageAuthorityV3::Predecessor {
                    source: source.clone(),
                    edge_fingerprint,
                },
                successor: ManagedCreateSuccessorSlotV3::Vacant,
            }),
            state: ManagedCreateLedgerRecordState::SuccessorLineagePending,
        },
    );
    validate_shard(&reservation.source_shard, source_index)
        .map_err(ManagedCreateAdmissionError::Ledger)?;
    write_shard(
        &reservation.directory,
        &reservation.source_path,
        &reservation.source_shard,
    )
    .map_err(ManagedCreateAdmissionError::Ledger)?;
    after_atomic_publish()?;
    Ok(())
}

/// Publishes the additive split-digest projection for an exact retained v1
/// edge. The v1 edge remains the sole lineage authority and is written first;
/// this operation can therefore safely backfill an interrupted or legacy
/// advance without choosing a new target.
pub fn ensure_successor_digest_projection(
    discovery_root: &Path,
    source: &ManagedCreateReconcileRequest,
    expected: &ManagedCreateSuccessorIdentity,
    canonical_request_digest: &str,
    rehost_recipe_digest: Option<&str>,
) -> Result<(), ManagedCreateAdmissionError> {
    source.validate().map_err(|error| {
        ManagedCreateAdmissionError::Ledger(format!(
            "hmux_managed_create_successor_invalid: {error}"
        ))
    })?;
    validate_successor_identity(expected)?;
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    ensure_private_directory(&directory)?;
    let record_key = logical_key(source.workspace_id(), source.session_id());
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    let _source_lock = acquire_shard_lock(&lock_path)?;
    let source_shard = read_shard_or_default(&shard_path)?;
    let index = shard_index(&record_key)?;
    validate_shard(&source_shard, index)?;
    let source_record = source_shard.records.get(&record_key).ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: projection source disappeared".to_string(),
        )
    })?;
    if source_record.idempotency_key != source.idempotency_key() {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: projection source identity changed".to_string(),
        ));
    }
    if let Some(ManagedCreateLedgerAuthorityV3 {
        successor:
            ManagedCreateSuccessorSlotV3::Intent {
                successor,
                policy_digests,
            },
        ..
    }) = source_record.authority.as_ref()
    {
        let mut successor = successor.as_ref().clone();
        successor.policy_digests = policy_digests.clone();
        if successor.session_id != expected.session_id
            || successor.idempotency_key != expected.idempotency_key
        {
            return Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict);
        }
        successor.ensure_request_policy_digests(
            &expected.request_digest,
            canonical_request_digest,
            rehost_recipe_digest,
        )?;
        return Ok(());
    }

    let successor_path = directory.join(format!("successor_{index:02x}.json"));
    let successors = read_successor_shard_or_default(&successor_path)?;
    validate_successor_shard(&successors, index)?;
    let record = successors.records.get(&record_key).ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: projection edge disappeared".to_string(),
        )
    })?;
    validate_successor_record(record, source, &record_key, index)?;
    let actual = record.successor.as_ref().ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: projection edge was closed".to_string(),
        )
    })?;
    if actual.session_id != expected.session_id
        || actual.idempotency_key != expected.idempotency_key
        || actual.request_digest != expected.request_digest
    {
        return Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict);
    }

    let successor_digest_path = directory.join(format!("successor_digest_{index:02x}.json"));
    let mut successor_digests = read_successor_digest_shard_or_default(&successor_digest_path)?;
    validate_successor_digest_shard(&successor_digests, &successors, index)?;
    if let Some(existing) = successor_digests.records.get(&record_key) {
        let actual = attach_successor_policy_digests(actual.clone(), Some(existing));
        actual.ensure_request_policy_digests(
            &expected.request_digest,
            canonical_request_digest,
            rehost_recipe_digest,
        )?;
        return Ok(());
    }
    if successor_digests.records.len() >= MAX_SHARD_RECORDS {
        return Err(ManagedCreateAdmissionError::Ledger(format!(
            "hmux_managed_create_successor_capacity: digest shard reached {MAX_SHARD_RECORDS} logical sessions"
        )));
    }
    let projected = ManagedCreateSuccessorIdentity::with_policy_digests(
        &actual.session_id,
        &actual.idempotency_key,
        &actual.request_digest,
        canonical_request_digest,
        rehost_recipe_digest.map(str::to_string),
    )?;
    let digest_record = successor_digest_record(source, &projected)?.ok_or_else(|| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_failed: digest projection was not constructed"
                .to_string(),
        )
    })?;
    successor_digests.records.insert(record_key, digest_record);
    write_successor_shard(&directory, &successor_digest_path, &successor_digests)?;
    Ok(())
}

/// Loads the exact owner-only recovery recipe bound at create admission.
/// `None` means either no logical session exists or it predates recipe storage;
/// rehost callers treat both cases as a typed pre-destructive refusal.
pub fn managed_rehost_recipe(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<Option<ManagedRehostSourceRecipe>, String> {
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(
                "hmux_managed_create_ledger_invalid: ledger directory is unreadable".to_string(),
            );
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let record_key = logical_key(workspace_id, session_id);
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    if !private_path_exists(&shard_path)? {
        return Ok(None);
    }
    let _lock = acquire_shard_lock(&lock_path)?;
    let shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let Some(record) = shard.records.get(&record_key) else {
        return Ok(None);
    };
    validate_record(record, workspace_id, session_id)?;
    let Some(serialized) = record.canonical_rehost_recipe.as_deref() else {
        return Ok(None);
    };
    decode_canonical_rehost_recipe(serialized, workspace_id, session_id).map(Some)
}

/// Loads the immutable create receipt for one live logical generation without
/// reserving or mutating ledger state. Presentation handoff callers use this
/// receipt instead of reconstructing the create idempotency key from a session
/// name or recovery convention.
pub fn completed_create_receipt(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<Option<ManagedCreateReceipt>, String> {
    read_completed_generation(discovery_root, workspace_id, session_id, false)
        .map(|evidence| evidence.map(|evidence| evidence.receipt))
}

/// Read an immutable completed create, including one already retiring or
/// retired. This is ancestry evidence, never live or destructive authority.
pub fn historical_create_receipt(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<Option<ManagedCreateReceipt>, String> {
    read_completed_generation(discovery_root, workspace_id, session_id, true)
        .map(|evidence| evidence.map(|evidence| evidence.receipt))
}

/// Reads the exact completed source receipt together with the conversation
/// identity persisted by its canonical create admission. This is deliberately
/// not a protocol projection: only Hmux lifecycle brokers consume it.
pub fn completed_generation_evidence(
    discovery_root: &Path,
    request: &ManagedCreateReconcileRequest,
) -> Result<Option<ManagedCreateCompletedGenerationEvidence>, String> {
    request
        .validate()
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let evidence = read_completed_generation(
        discovery_root,
        request.workspace_id(),
        request.session_id(),
        false,
    )?;
    if evidence
        .as_ref()
        .is_some_and(|evidence| evidence.receipt.idempotency_key() != request.idempotency_key())
    {
        return Err(
            "hmux_managed_create_reconcile_authority_unavailable: idempotency identity changed"
                .to_string(),
        );
    }
    Ok(evidence)
}

fn read_completed_generation(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    include_retired: bool,
) -> Result<Option<ManagedCreateCompletedGenerationEvidence>, String> {
    refuse_legacy_writer(discovery_root)?;
    let bounded = |value: &str| {
        !value.is_empty() && value.len() <= 4_096 && !value.chars().any(char::is_control)
    };
    if !bounded(workspace_id) || !bounded(session_id) {
        return Err("hmux_managed_create_ledger_invalid: identity is malformed".to_string());
    }
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(
                "hmux_managed_create_ledger_invalid: ledger directory is unreadable".to_string(),
            );
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let record_key = logical_key(workspace_id, session_id);
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    if !private_path_exists(&shard_path)? {
        return Ok(None);
    }
    let _lock = acquire_shard_lock(&lock_path)?;
    let shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let Some(record) = shard.records.get(&record_key) else {
        return Ok(None);
    };
    validate_record(record, workspace_id, session_id)?;
    let ManagedCreateLedgerRecordState::Completed {
        receipt,
        retired,
        retiring_stop_receipt,
    } = &record.state
    else {
        return Ok(None);
    };
    if !include_retired && (*retired || retiring_stop_receipt.is_some()) {
        return Ok(None);
    }
    let receipt: ManagedCreateReceipt = serde_json::from_str(receipt).map_err(|_| {
        "hmux_managed_create_ledger_invalid: completed create receipt is malformed".to_string()
    })?;
    receipt
        .validate()
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    if receipt.workspace_id() != workspace_id
        || receipt.session_id() != session_id
        || receipt.idempotency_key() != record.idempotency_key
        || record
            .conversation_identity
            .as_ref()
            .is_some_and(|identity| identity.provider_id() != receipt.provider_id())
    {
        return Err(
            "hmux_managed_create_ledger_conflict: completed create identity changed".to_string(),
        );
    }
    Ok(Some(ManagedCreateCompletedGenerationEvidence {
        receipt,
        conversation_identity: record.conversation_identity.clone(),
    }))
}

/// Checkpoints the exact provider generation while the Host still owns the
/// Starting lifetime lock. Only the Host process already recorded by the
/// launch-released create intent may publish this evidence.
pub fn checkpoint_starting_generation_exact(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    idempotency_key: &str,
    generation: ManagedStartingGeneration,
) -> Result<(), String> {
    validate_starting_generation(&generation)?;
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    ensure_private_directory(&directory)?;
    let record_key = logical_key(workspace_id, session_id);
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    let _lock = acquire_shard_lock(&lock_path)?;
    let mut shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let mut record = shard.records.get(&record_key).cloned().ok_or_else(|| {
        "hmux_managed_create_ledger_invalid: Starting generation has no create intent".to_string()
    })?;
    validate_record(&record, workspace_id, session_id)?;
    if record.idempotency_key != idempotency_key || generation.idempotency_key != idempotency_key {
        return Err(
            "hmux_managed_create_ledger_conflict: Starting generation changed create identity"
                .to_string(),
        );
    }
    let identity = ManagedCreateReconcileRequest::new(idempotency_key, session_id, workspace_id)
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    if record_has_direct_cleanup_fence(&record)
        || successor_cleanup_is_closed(
            &directory,
            shard_index(&record_key)?,
            &record_key,
            &identity,
        )
        .map_err(|error| error.to_string())?
    {
        return Err(
            "hmux_managed_create_retired_exact: cleanup closed this create generation".to_string(),
        );
    }
    record.state = match &record.state {
        ManagedCreateLedgerRecordState::LaunchReleased {
            host_process,
            starting_generation,
        } if *host_process == generation.host_process => {
            if starting_generation
                .as_ref()
                .is_some_and(|existing| existing.as_ref() != &generation)
            {
                return Err(
                    "hmux_managed_create_ledger_conflict: Starting generation changed".to_string(),
                );
            }
            ManagedCreateLedgerRecordState::LaunchReleased {
                host_process: host_process.clone(),
                starting_generation: Some(Box::new(generation)),
            }
        }
        ManagedCreateLedgerRecordState::LaunchReleased { .. } => {
            return Err(
                "hmux_managed_create_ledger_conflict: Starting Host generation changed".to_string(),
            );
        }
        _ => {
            return Err(
                "hmux_managed_create_ledger_invalid: Starting generation is not launch-released"
                    .to_string(),
            );
        }
    };
    shard.records.insert(record_key, record);
    write_shard(&directory, &shard_path, &shard)
}

/// Reads exact Starting generation evidence without reopening or mutating the
/// create intent. Missing evidence is a typed `None`, never inferred from a
/// client request or the process table.
pub fn starting_generation(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<Option<ManagedStartingGeneration>, String> {
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err("hmux_managed_create_ledger_invalid: directory is unreadable".to_string());
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let record_key = logical_key(workspace_id, session_id);
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    if !private_path_exists(&shard_path)? {
        return Ok(None);
    }
    let _lock = acquire_shard_lock(&lock_path)?;
    let shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let Some(record) = shard.records.get(&record_key) else {
        return Ok(None);
    };
    validate_record(record, workspace_id, session_id)?;
    let ManagedCreateLedgerRecordState::LaunchReleased {
        starting_generation: Some(generation),
        ..
    } = &record.state
    else {
        return Ok(None);
    };
    validate_starting_generation(generation)?;
    Ok(Some(generation.as_ref().clone()))
}

/// Reads exact launch-release evidence for an identity-only recovery caller.
/// No provider or generation fence is inferred here; those remain manifest
/// facts that the destructive runtime must match before stopping anything.
pub fn launched_generation_evidence(
    discovery_root: &Path,
    request: &ManagedCreateReconcileRequest,
) -> Result<Option<ManagedCreateLaunchedGenerationEvidence>, String> {
    request
        .validate()
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err("hmux_managed_create_ledger_invalid: directory is unreadable".to_string());
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let record_key = logical_key(request.workspace_id(), request.session_id());
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    if !private_path_exists(&shard_path)? {
        return Ok(None);
    }
    let _lock = acquire_shard_lock(&lock_path)?;
    let shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let Some(record) = shard.records.get(&record_key) else {
        return Ok(None);
    };
    validate_record(record, request.workspace_id(), request.session_id())?;
    if record.idempotency_key != request.idempotency_key() {
        return Err(
            "hmux_managed_create_ledger_conflict: launched generation identity changed".to_string(),
        );
    }
    let ManagedCreateLedgerRecordState::LaunchReleased {
        host_process,
        starting_generation,
    } = &record.state
    else {
        return Ok(None);
    };
    Ok(Some(ManagedCreateLaunchedGenerationEvidence {
        host_process: host_process.clone(),
        conversation_identity: record.conversation_identity.clone(),
        starting_generation: starting_generation.as_deref().cloned(),
    }))
}

impl ManagedCreateLedgerReservation {
    /// Resolves replaceable launch colors without changing the immutable
    /// create reservation. A stored rehost source recipe owns its original
    /// presentation seed; ordinary creates use the current request value.
    ///
    /// A recipe that carries no seed does not own one, so it falls through to
    /// the request. Letting `Some(None)` win instead left the session with the
    /// type's default — opaque black — and a TUI that asks for the background
    /// before painting then chose its own dark surface against a themed
    /// terminal (2026-09-01: Codex rendered #1e1e1e under every scheme).
    pub fn resolve_terminal_default_colors(
        &self,
        request_colors: Option<TerminalDefaultColors>,
    ) -> Result<Option<TerminalDefaultColors>, String> {
        self.record
            .canonical_rehost_recipe
            .as_deref()
            .map(|serialized| {
                decode_canonical_rehost_recipe(
                    serialized,
                    &self.record.workspace_id,
                    &self.record.session_id,
                )
                .map(|recipe| recipe.terminal_default_colors())
            })
            .transpose()
            .map(|stored| resolved_launch_colors(stored, request_colors))
    }

    /// Checkpoints absence while discovery maintenance is held, after the
    /// pre-ledger lookup and before any Host child is spawned. Plain legacy
    /// `Prepared` records carry no such proof and remain non-abandonable.
    pub fn checkpoint_pre_spawn_absence(&mut self) -> Result<(), String> {
        match self.record.state {
            ManagedCreateLedgerRecordState::PreSpawnAbsenceCheckpointed => return Ok(()),
            ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified => {}
            ManagedCreateLedgerRecordState::Prepared => {
                return Err(
                    "hmux_managed_create_recovery_required: an earlier prepared reservation has no durable pre-spawn absence proof"
                        .to_string(),
                );
            }
            _ => {
                return Err(
                    "hmux_managed_create_ledger_invalid: pre-spawn absence checkpoint followed launch"
                        .to_string(),
                );
            }
        }
        let mut next = self.record.clone();
        next.state = ManagedCreateLedgerRecordState::PreSpawnAbsenceCheckpointed;
        self.publish(next)
    }

    /// Records the exact inert Host child while it is still blocked on stdin.
    pub fn mark_spawn_reserved(&mut self, host_process: ProcessDescriptor) -> Result<(), String> {
        validate_process(&host_process)?;
        if !matches!(
            self.record.state,
            ManagedCreateLedgerRecordState::PreSpawnAbsenceCheckpointed
        ) {
            return Err(
                "hmux_managed_create_ledger_invalid: spawn reservation changed twice".to_string(),
            );
        }
        let mut next = self.record.clone();
        next.state = ManagedCreateLedgerRecordState::SpawnReserved { host_process };
        self.publish_forward(next)
    }

    /// Publishes exact barrier capability before crossing the durable boundary
    /// after which the launch packet may be sent. Both projections share the
    /// create-shard lock, so a crash leaves either `SpawnReserved`, which is
    /// inert, or `LaunchReleased` with its matching recovery proof.
    pub fn release_with_barrier_proof(&mut self) -> Result<(), String> {
        let ManagedCreateLedgerRecordState::SpawnReserved { host_process } = &self.record.state
        else {
            return Err(
                "hmux_managed_create_ledger_invalid: launch release preceded spawn reservation"
                    .to_string(),
            );
        };
        let mut next = self.record.clone();
        next.state = ManagedCreateLedgerRecordState::LaunchReleased {
            host_process: host_process.clone(),
            starting_generation: None,
        };
        let launch_fingerprint = provider_release_launch_fingerprint(&next)?;
        let _lock = acquire_shard_lock(&self.lock_path)?;
        let mut shard = read_shard_or_default(&self.shard_path)?;
        let index = shard_index(&self.record_key)?;
        validate_shard(&shard, index)?;
        let current = shard.records.get(&self.record_key).ok_or_else(|| {
            "hmux_managed_create_ledger_invalid: reserved record disappeared".to_string()
        })?;
        if record_has_direct_cleanup_fence(current)
            || successor_cleanup_is_closed(
                &self.directory,
                index,
                &self.record_key,
                &ManagedCreateReconcileRequest::new(
                    current.idempotency_key.clone(),
                    current.session_id.clone(),
                    current.workspace_id.clone(),
                )
                .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?,
            )
            .map_err(|error| error.to_string())?
        {
            return Err(
                "hmux_managed_create_retired_exact: cleanup closed this create generation"
                    .to_string(),
            );
        }
        if current != &self.record {
            return Err(
                "hmux_managed_create_ledger_conflict: record advanced concurrently".to_string(),
            );
        }
        let guard_path = provider_release_guard_path(&self.directory, index);
        let mut guards = read_provider_release_guard_shard_or_default(&guard_path)?;
        validate_provider_release_guard_shard(&guards, index)?;
        if guards.records.len() >= MAX_SHARD_RECORDS
            && !guards.records.contains_key(&self.record_key)
        {
            return Err(format!(
                "hmux_managed_provider_release_guard_capacity: shard reached {MAX_SHARD_RECORDS} logical sessions"
            ));
        }
        guards.records.insert(
            self.record_key.clone(),
            ManagedProviderReleaseGuardRecord {
                schema_version: PROVIDER_RELEASE_GUARD_SCHEMA_VERSION,
                launch_fingerprint,
            },
        );
        write_provider_release_guard_shard(&self.directory, &guard_path, &guards)?;
        shard.records.insert(self.record_key.clone(), next.clone());
        write_shard(&self.directory, &self.shard_path, &shard)?;
        self.record = next;
        Ok(())
    }

    /// Reopens only an exact attempt whose live broker or shared reconcile
    /// authority proved all launch effects stopped. Recovered callers must not
    /// infer that proof from Host absence alone.
    pub fn reset_after_definite_pre_ready_failure(&mut self) -> Result<(), String> {
        if !matches!(
            self.record.state,
            ManagedCreateLedgerRecordState::SpawnReserved { .. }
                | ManagedCreateLedgerRecordState::LaunchReleased { .. }
        ) {
            return Err(
                "hmux_managed_create_ledger_invalid: no started launch can be reset".to_string(),
            );
        }
        let mut next = self.record.clone();
        next.state = ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified;
        self.publish_forward(next)
    }

    pub fn complete(&mut self, receipt: String) -> Result<String, String> {
        validate_create_receipt(&receipt)?;
        if !matches!(
            self.record.state,
            ManagedCreateLedgerRecordState::LaunchReleased { .. }
        ) {
            return Err(
                "hmux_managed_create_ledger_invalid: completion preceded launch release"
                    .to_string(),
            );
        }
        let _lock = acquire_shard_lock(&self.lock_path)?;
        let mut shard = read_shard_or_default(&self.shard_path)?;
        validate_shard(&shard, shard_index(&self.record_key)?)?;
        let current = shard.records.get(&self.record_key).ok_or_else(|| {
            "hmux_managed_create_ledger_invalid: reserved record disappeared".to_string()
        })?;
        if current != &self.record {
            match &current.state {
                ManagedCreateLedgerRecordState::Completed {
                    receipt: canonical,
                    retired: false,
                    retiring_stop_receipt: None,
                } => {
                    if !same_record_identity(current, &self.record)
                        || !same_completed_generation(canonical, &receipt)?
                    {
                        return Err(
                            "hmux_managed_create_ledger_conflict: completion changed generation"
                                .to_string(),
                        );
                    }
                    self.record = current.clone();
                    return Ok(canonical.clone());
                }
                ManagedCreateLedgerRecordState::LaunchReleased { .. }
                    if is_exact_host_starting_checkpoint(&self.record, current) => {}
                _ => {
                    return Err(
                        "hmux_managed_create_ledger_conflict: record advanced concurrently"
                            .to_string(),
                    );
                }
            }
        }
        let mut next = current.clone();
        validate_starting_completion(current, &receipt)?;
        next.state = ManagedCreateLedgerRecordState::Completed {
            receipt: receipt.clone(),
            retired: false,
            retiring_stop_receipt: None,
        };
        shard.records.insert(self.record_key.clone(), next.clone());
        write_shard(&self.directory, &self.shard_path, &shard)?;
        self.record = next;
        Ok(receipt)
    }

    /// Publishes a terminal no-create tombstone after the runtime has proved
    /// this exact record never released a live generation, or that its recorded
    /// Host generation and discovery identity are both absent. The CAS rejects
    /// any concurrent launch advancement.
    pub fn abandon_before_completion(&mut self) -> Result<(), String> {
        if !matches!(
            self.record.state,
            ManagedCreateLedgerRecordState::PreSpawnAbsenceCheckpointed
                | ManagedCreateLedgerRecordState::SpawnReserved { .. }
                | ManagedCreateLedgerRecordState::LaunchReleased {
                    starting_generation: None,
                    ..
                }
        ) {
            return Err(
                "hmux_managed_create_ledger_invalid: create generation is not abandonable"
                    .to_string(),
            );
        }
        let mut next = self.record.clone();
        next.conversation_writer_released = next.conversation_identity.is_some();
        next.state = ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion;
        self.publish(next)
    }

    /// Publishes the same terminal tombstone after the runtime retired the
    /// exact checkpointed Starting manifest and proved both recorded process
    /// generations absent. The expected checkpoint keeps this CAS bound to the
    /// evidence that was actually inspected.
    pub fn abandon_starting_before_completion(
        &mut self,
        expected: &ManagedStartingGeneration,
    ) -> Result<(), String> {
        let ManagedCreateLedgerRecordState::LaunchReleased {
            starting_generation: Some(current),
            ..
        } = &self.record.state
        else {
            return Err(
                "hmux_managed_create_ledger_invalid: no Starting generation is abandonable"
                    .to_string(),
            );
        };
        if current.as_ref() != expected {
            return Err(
                "hmux_managed_create_ledger_conflict: Starting generation changed".to_string(),
            );
        }
        let mut next = self.record.clone();
        next.conversation_writer_released = next.conversation_identity.is_some();
        next.state = ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion;
        self.publish(next)
    }

    fn publish(&mut self, next: ManagedCreateLedgerRecord) -> Result<(), String> {
        self.publish_with_cleanup_fence(next, false)
    }

    fn publish_forward(&mut self, next: ManagedCreateLedgerRecord) -> Result<(), String> {
        self.publish_with_cleanup_fence(next, true)
    }

    fn publish_with_cleanup_fence(
        &mut self,
        next: ManagedCreateLedgerRecord,
        refuse_cleanup_closed: bool,
    ) -> Result<(), String> {
        let _lock = acquire_shard_lock(&self.lock_path)?;
        let mut shard = read_shard_or_default(&self.shard_path)?;
        let index = shard_index(&self.record_key)?;
        validate_shard(&shard, index)?;
        let current = shard.records.get(&self.record_key).ok_or_else(|| {
            "hmux_managed_create_ledger_invalid: reserved record disappeared".to_string()
        })?;
        if current == &next {
            self.record = next;
            return Ok(());
        }
        if refuse_cleanup_closed && record_has_direct_cleanup_fence(current) {
            return Err(
                "hmux_managed_create_retired_exact: cleanup closed this create generation"
                    .to_string(),
            );
        }
        if current != &self.record {
            let cleanup_only_advanced = !refuse_cleanup_closed
                && same_record_identity(current, &self.record)
                && current.state == self.record.state
                && matches!(
                    (
                        current.authority.as_ref(),
                        self.record.authority.as_ref(),
                    ),
                    (
                        Some(ManagedCreateLedgerAuthorityV3 {
                            lineage: current_lineage,
                            successor: ManagedCreateSuccessorSlotV3::Closed { .. },
                        }),
                        Some(ManagedCreateLedgerAuthorityV3 {
                            lineage: reserved_lineage,
                            successor: ManagedCreateSuccessorSlotV3::Vacant,
                        }),
                    ) if current_lineage == reserved_lineage
                );
            if cleanup_only_advanced {
                let mut merged = next;
                merged.authority = current.authority.clone();
                shard
                    .records
                    .insert(self.record_key.clone(), merged.clone());
                write_shard(&self.directory, &self.shard_path, &shard)?;
                self.record = merged;
                return Ok(());
            }
            return Err(
                "hmux_managed_create_ledger_conflict: record advanced concurrently".to_string(),
            );
        }
        if refuse_cleanup_closed {
            let identity = ManagedCreateReconcileRequest::new(
                current.idempotency_key.clone(),
                current.session_id.clone(),
                current.workspace_id.clone(),
            )
            .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
            if successor_cleanup_is_closed(&self.directory, index, &self.record_key, &identity)
                .map_err(|error| error.to_string())?
            {
                return Err(
                    "hmux_managed_create_retired_exact: cleanup closed this create generation"
                        .to_string(),
                );
            }
        }
        shard.records.insert(self.record_key.clone(), next.clone());
        write_shard(&self.directory, &self.shard_path, &shard)?;
        self.record = next;
        Ok(())
    }
}

fn same_record_identity(
    left: &ManagedCreateLedgerRecord,
    right: &ManagedCreateLedgerRecord,
) -> bool {
    left.schema_version == right.schema_version
        && left.workspace_id == right.workspace_id
        && left.session_id == right.session_id
        && left.idempotency_key == right.idempotency_key
        && left.request_digest == right.request_digest
        && left.conversation_identity == right.conversation_identity
        && left.conversation_writer_released == right.conversation_writer_released
        && left.canonical_rehost_recipe == right.canonical_rehost_recipe
        && left.created_unix_ms == right.created_unix_ms
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedProviderReleaseLaunchIdentity<'a> {
    workspace_id: &'a str,
    session_id: &'a str,
    idempotency_key: &'a str,
    request_digest: &'a str,
    conversation_identity: &'a Option<ProviderConversationIdentitySeed>,
    canonical_rehost_recipe: &'a Option<String>,
    created_unix_ms: u64,
    host_process: &'a ProcessDescriptor,
}

/// Fingerprints only the immutable create record identity plus the exact Host
/// generation. Later Starting checkpoints, cleanup projections, and terminal
/// writer release cannot invalidate evidence for this launch.
fn provider_release_launch_fingerprint(
    record: &ManagedCreateLedgerRecord,
) -> Result<String, String> {
    let ManagedCreateLedgerRecordState::LaunchReleased { host_process, .. } = &record.state else {
        return Err(
            "hmux_managed_provider_release_guard_invalid: record is not launch-released"
                .to_string(),
        );
    };
    let identity = ManagedProviderReleaseLaunchIdentity {
        workspace_id: &record.workspace_id,
        session_id: &record.session_id,
        idempotency_key: &record.idempotency_key,
        request_digest: &record.request_digest,
        conversation_identity: &record.conversation_identity,
        canonical_rehost_recipe: &record.canonical_rehost_recipe,
        created_unix_ms: record.created_unix_ms,
        host_process,
    };
    let serialized = serde_json::to_string(&identity).map_err(|_| {
        "hmux_managed_provider_release_guard_failed: launch fingerprint serialization failed"
            .to_string()
    })?;
    Ok(request_fingerprint(&[
        "managed-create-provider-release-guard-v1",
        &serialized,
    ]))
}

fn matching_provider_release_guard(
    directory: &Path,
    record_key: &str,
    record: &ManagedCreateLedgerRecord,
) -> Result<bool, String> {
    let index = shard_index(record_key)?;
    let path = provider_release_guard_path(directory, index);
    if !private_path_exists(&path)? {
        return Ok(false);
    }
    let guards = read_provider_release_guard_shard_or_default(&path)?;
    validate_provider_release_guard_shard(&guards, index)?;
    let Some(guard) = guards.records.get(record_key) else {
        return Ok(false);
    };
    Ok(guard.launch_fingerprint == provider_release_launch_fingerprint(record)?)
}

/// The managed Host is the only writer allowed to add this exact checkpoint
/// after the broker released launch. Let the broker consume that additive
/// evidence when it completes the same launch, while every other concurrent
/// state change remains a conflict.
fn is_exact_host_starting_checkpoint(
    broker_record: &ManagedCreateLedgerRecord,
    current: &ManagedCreateLedgerRecord,
) -> bool {
    if !same_record_identity(broker_record, current) {
        return false;
    }
    matches!(
        (&broker_record.state, &current.state),
        (
            ManagedCreateLedgerRecordState::LaunchReleased {
                host_process: broker_host,
                starting_generation: None,
            },
            ManagedCreateLedgerRecordState::LaunchReleased {
                host_process: current_host,
                starting_generation: Some(generation),
            },
        ) if broker_host == current_host && generation.host_process() == current_host
    )
}

fn validate_starting_completion(
    record: &ManagedCreateLedgerRecord,
    serialized: &str,
) -> Result<(), String> {
    let ManagedCreateLedgerRecordState::LaunchReleased {
        starting_generation: Some(starting),
        ..
    } = &record.state
    else {
        return Ok(());
    };
    let receipt: ManagedCreateReceipt = serde_json::from_str(serialized).map_err(|_| {
        "hmux_managed_create_ledger_invalid: completed create receipt is malformed".to_string()
    })?;
    receipt.validate().map_err(|error| {
        format!("hmux_managed_create_ledger_invalid: completed create receipt: {error}")
    })?;
    if receipt.idempotency_key() != record.idempotency_key
        || receipt.workspace_id() != record.workspace_id
        || receipt.session_id() != record.session_id
        || receipt.generation_fence() != Some(starting.generation_fence())
        || starting
            .conversation_identity()
            .is_some_and(|identity| identity.provider_id() != receipt.provider_id())
    {
        return Err(
            "hmux_managed_create_ledger_conflict: completion changed Starting generation"
                .to_string(),
        );
    }
    Ok(())
}

fn same_completed_generation(left: &str, right: &str) -> Result<bool, String> {
    let left: ManagedCreateReceipt = serde_json::from_str(left).map_err(|_| {
        "hmux_managed_create_ledger_invalid: canonical create receipt is malformed".to_string()
    })?;
    let right: ManagedCreateReceipt = serde_json::from_str(right).map_err(|_| {
        "hmux_managed_create_ledger_invalid: competing create receipt is malformed".to_string()
    })?;
    left.validate().map_err(|error| {
        format!("hmux_managed_create_ledger_invalid: canonical create receipt: {error}")
    })?;
    right.validate().map_err(|error| {
        format!("hmux_managed_create_ledger_invalid: competing create receipt: {error}")
    })?;
    Ok(left.idempotency_key() == right.idempotency_key()
        && left.session_id() == right.session_id()
        && left.workspace_id() == right.workspace_id()
        && left.provider_id() == right.provider_id()
        && left.permission_mode() == right.permission_mode()
        && left.discovery_root() == right.discovery_root()
        && left.generation_fence() == right.generation_fence())
}

pub fn checkpoint_retirement_exact(
    discovery_root: &Path,
    receipt: &ManagedStopReceipt,
) -> Result<ManagedCreateRetirement, String> {
    update_retirement_exact(discovery_root, receipt, false)
}

pub fn finalize_retirement_exact(
    discovery_root: &Path,
    receipt: &ManagedStopReceipt,
) -> Result<ManagedCreateRetirement, String> {
    update_retirement_exact(discovery_root, receipt, true)
}

fn update_retirement_exact(
    discovery_root: &Path,
    receipt: &ManagedStopReceipt,
    finalize: bool,
) -> Result<ManagedCreateRetirement, String> {
    receipt
        .validate()
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Ok(_) => ensure_private_directory(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ManagedCreateRetirement::NoLedger);
        }
        Err(_) => {
            return Err("hmux_managed_create_ledger_invalid: directory is unreadable".to_string());
        }
    }
    let record_key = logical_key(receipt.workspace_id(), receipt.session_id());
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    let _lock = acquire_shard_lock(&lock_path)?;
    let mut shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let Some(mut record) = shard.records.get(&record_key).cloned() else {
        return Ok(ManagedCreateRetirement::NoLedger);
    };
    validate_record(&record, receipt.workspace_id(), receipt.session_id())?;
    record.state = match &record.state {
        ManagedCreateLedgerRecordState::Completed {
            receipt: create_receipt,
            retired,
            retiring_stop_receipt,
        } => {
            validate_completed_generation(create_receipt, receipt)?;
            if *retired {
                return Ok(ManagedCreateRetirement::Exact);
            }
            validate_retirement_owner(retiring_stop_receipt.as_deref(), receipt, finalize)?;
            ManagedCreateLedgerRecordState::Completed {
                receipt: create_receipt.clone(),
                retired: finalize,
                retiring_stop_receipt: Some(encode_stop_receipt(receipt)?),
            }
        }
        ManagedCreateLedgerRecordState::LaunchReleased {
            host_process,
            starting_generation,
        } => {
            validate_uncompleted_generation(
                discovery_root,
                &record,
                host_process,
                starting_generation.as_deref(),
                receipt,
            )?;
            if finalize {
                return Err(
                    "hmux_managed_create_ledger_invalid: retirement was not checkpointed"
                        .to_string(),
                );
            }
            ManagedCreateLedgerRecordState::RetiringBeforeCreateCompletion {
                stop_receipt: encode_stop_receipt(receipt)?,
            }
        }
        ManagedCreateLedgerRecordState::RetiringBeforeCreateCompletion { stop_receipt } => {
            validate_same_stop_generation(stop_receipt, receipt)?;
            if finalize {
                ManagedCreateLedgerRecordState::RetiredBeforeCreateCompletion {
                    stop_receipt: stop_receipt.clone(),
                }
            } else {
                record.state.clone()
            }
        }
        ManagedCreateLedgerRecordState::RetiredBeforeCreateCompletion { stop_receipt } => {
            validate_same_stop_generation(stop_receipt, receipt)?;
            return Ok(ManagedCreateRetirement::Exact);
        }
        ManagedCreateLedgerRecordState::RootLineagePending => {
            return Err(
                "hmux_managed_create_ledger_invalid: Root lineage is not yet admitted".to_string(),
            );
        }
        ManagedCreateLedgerRecordState::SuccessorLineagePending => {
            return Err(
                "hmux_managed_create_ledger_invalid: successor lineage is not yet actionable"
                    .to_string(),
            );
        }
        ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified
        | ManagedCreateLedgerRecordState::Prepared
        | ManagedCreateLedgerRecordState::PreSpawnAbsenceCheckpointed => {
            if finalize {
                return Err(
                    "hmux_managed_create_ledger_invalid: retirement was not checkpointed"
                        .to_string(),
                );
            }
            // A current broker reserves `prepared` before checking for an
            // already-running managed generation. When that generation
            // predates the create ledger, the broker deliberately refuses to
            // adopt it and leaves this side-effect-free reservation behind.
            // An exact managed-stop receipt proves the independently fenced
            // predecessor has now exited. Permanently retire the logical ID
            // before allowing the recovery saga to create its fresh target;
            // a concurrent creator still has to CAS this prepared record and
            // therefore cannot release another Host after this checkpoint.
            ManagedCreateLedgerRecordState::RetiringBeforeCreateCompletion {
                stop_receipt: encode_stop_receipt(receipt)?,
            }
        }
        ManagedCreateLedgerRecordState::SpawnReserved { .. } => {
            return Err(
                "hmux_managed_create_ledger_invalid: stop does not match a released create generation"
                    .to_string(),
            );
        }
        ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion => {
            return Err(
                "hmux_managed_create_ledger_invalid: abandoned create has no stopped generation"
                    .to_string(),
            );
        }
        ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission => {
            return Err(
                "hmux_managed_create_ledger_invalid: cleanup-closed create has no stopped generation"
                    .to_string(),
            );
        }
    };
    shard.records.insert(record_key, record);
    write_shard(&directory, &shard_path, &shard)?;
    Ok(ManagedCreateRetirement::Exact)
}

fn validate_uncompleted_generation(
    discovery_root: &Path,
    record: &ManagedCreateLedgerRecord,
    host_process: &ProcessDescriptor,
    starting_generation: Option<&ManagedStartingGeneration>,
    stop: &ManagedStopReceipt,
) -> Result<(), String> {
    let root = DiscoveryRoot::open(discovery_root)
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let found = root
        .find_manifest_by_session(&record.workspace_id, &record.session_id)
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let DiscoveryManifest::Exited(exited) = &found.manifest else {
        return Err(
            "hmux_managed_create_ledger_invalid: stopped uncompleted generation changed"
                .to_string(),
        );
    };
    let common = found.manifest.common();
    let generation = found.manifest.generation();
    if common.session_class != SessionClass::Managed
        || common.claim_linkage.kickoff_action_id.as_deref()
            != Some(record.idempotency_key.as_str())
        || common.host_process.process_id != host_process.process_id
        || common.host_process.start_marker != host_process.start_marker
        || common.lifetime.runner_principal != stop.runner_principal()
        || common.lifetime.runner_instance != stop.runner_instance()
        || common.lifetime.channel_epoch != stop.channel_epoch()
        || generation.host_instance_id != stop.host_instance_id()
        || generation.terminal_epoch.as_deref() != Some(stop.terminal_epoch())
        || starting_generation.is_some_and(|starting| {
            starting.host_process != *host_process
                || starting.provider_process.process_id
                    != exited.tombstone.provider_process.process_id
                || starting.provider_process.start_marker
                    != exited.tombstone.provider_process.start_marker
                || !starting.generation_fence.matches_generation(
                    stop.runner_principal(),
                    stop.runner_instance(),
                    &stop.channel_epoch().to_string(),
                    stop.host_instance_id(),
                    stop.terminal_epoch(),
                )
        })
    {
        return Err(
            "hmux_managed_create_ledger_invalid: stopped uncompleted generation changed"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_completed_generation(
    serialized: &str,
    stop: &ManagedStopReceipt,
) -> Result<(), String> {
    let create: ManagedCreateReceipt = serde_json::from_str(serialized).map_err(|_| {
        "hmux_managed_create_ledger_invalid: completed create receipt is malformed".to_string()
    })?;
    create
        .validate()
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let fence = create.generation_fence().ok_or_else(|| {
        "hmux_managed_create_ledger_invalid: completed create receipt has no generation fence"
            .to_string()
    })?;
    if create.workspace_id() != stop.workspace_id()
        || create.session_id() != stop.session_id()
        || !fence.matches_generation(
            stop.runner_principal(),
            stop.runner_instance(),
            &stop.channel_epoch().to_string(),
            stop.host_instance_id(),
            stop.terminal_epoch(),
        )
    {
        return Err(
            "hmux_managed_create_ledger_invalid: stopped generation does not match create receipt"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_retirement_owner(
    serialized: Option<&str>,
    receipt: &ManagedStopReceipt,
    finalize: bool,
) -> Result<(), String> {
    match serialized {
        Some(existing) => validate_same_stop_generation(existing, receipt),
        None if finalize => {
            Err("hmux_managed_create_ledger_invalid: retirement was not checkpointed".to_string())
        }
        None => Ok(()),
    }
}

fn validate_same_stop_generation(
    serialized: &str,
    receipt: &ManagedStopReceipt,
) -> Result<(), String> {
    let existing = decode_persisted_stop_receipt(
        serialized,
        "hmux_managed_create_ledger_invalid: retiring stop receipt is malformed",
    )?;
    let changed = if existing.stop_id() != receipt.stop_id() {
        Some("stop id")
    } else if existing.workspace_id() != receipt.workspace_id() {
        Some("workspace id")
    } else if existing.session_id() != receipt.session_id() {
        Some("session id")
    } else if existing.runner_principal() != receipt.runner_principal() {
        Some("runner principal")
    } else if existing.runner_instance() != receipt.runner_instance() {
        Some("runner instance")
    } else if existing.channel_epoch() != receipt.channel_epoch() {
        Some("channel epoch")
    } else if existing.host_instance_id() != receipt.host_instance_id() {
        Some("Host instance id")
    } else if existing.terminal_epoch() != receipt.terminal_epoch() {
        Some("terminal epoch")
    } else {
        None
    };
    if let Some(changed) = changed {
        return Err(format!(
            "hmux_managed_create_ledger_invalid: another generation owns retirement ({changed} changed)"
        ));
    }
    Ok(())
}

fn encode_stop_receipt(receipt: &ManagedStopReceipt) -> Result<String, String> {
    serde_json::to_string(receipt).map_err(|_| {
        "hmux_managed_create_ledger_failed: stop receipt serialization failed".to_string()
    })
}

fn refuse_legacy_writer(discovery_root: &Path) -> Result<(), String> {
    let legacy = discovery_root.join(LEGACY_LEDGER_DIRECTORY);
    match fs::symlink_metadata(&legacy) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(metadata) if metadata.file_type().is_dir() => {
            let mut entries = fs::read_dir(&legacy).map_err(|_| {
                "hmux_managed_create_ledger_invalid: legacy ledger state is unreadable".to_string()
            })?;
            match entries.next() {
                None => Ok(()),
                Some(Ok(_)) => Err(
                    "hmux_managed_create_ledger_upgrade_required: legacy v1 create ledger contains state and requires explicit reconciliation"
                        .to_string(),
                ),
                Some(Err(_)) => Err(
                    "hmux_managed_create_ledger_invalid: legacy ledger state is unreadable"
                        .to_string(),
                ),
            }
        }
        Ok(_) => Err(
            "hmux_managed_create_ledger_invalid: legacy ledger path is not a directory".to_string(),
        ),
        Err(_) => {
            Err("hmux_managed_create_ledger_invalid: legacy ledger state is unreadable".to_string())
        }
    }
}

fn begin_conversation_writer_admission(
    directory: &Path,
    identity: &ProviderConversationIdentitySeed,
) -> Result<ManagedConversationWriterAdmission, String> {
    let claim_key = conversation_writer_key(identity);
    let index = shard_index(&claim_key)?;
    let lock_path = directory.join(format!("conversation_writer_{index:02x}.lock"));
    let shard_path = directory.join(format!("conversation_writer_{index:02x}.json"));
    let lock = acquire_shard_lock(&lock_path)?;
    let shard = read_conversation_writer_shard_or_default(&shard_path)?;
    validate_conversation_writer_shard(&shard, index)?;
    Ok(ManagedConversationWriterAdmission {
        directory: directory.to_path_buf(),
        shard_path,
        claim_key,
        shard,
        _lock: lock,
    })
}

impl ManagedConversationWriterAdmission {
    fn claim(&self) -> Option<&ManagedConversationWriterClaim> {
        self.shard.claims.get(&self.claim_key)
    }

    fn commit(
        &mut self,
        identity: &ProviderConversationIdentitySeed,
        owner: ManagedConversationWriterOwner,
    ) -> Result<(), String> {
        let claim = ManagedConversationWriterClaim {
            schema_version: CONVERSATION_WRITER_SCHEMA_VERSION,
            conversation_identity: identity.clone(),
            owner,
        };
        if self.claim() == Some(&claim) {
            return Ok(());
        }
        if !self.shard.claims.contains_key(&self.claim_key)
            && self.shard.claims.len() >= MAX_SHARD_RECORDS
        {
            return Err(format!(
                "hmux_managed_conversation_writer_capacity: shard reached {MAX_SHARD_RECORDS} exact conversations"
            ));
        }
        self.shard.claims.insert(self.claim_key.clone(), claim);
        write_conversation_writer_shard(&self.directory, &self.shard_path, &self.shard)
    }
}

fn ensure_successor_conversation_identity(
    expected_identity: Option<&ProviderConversationIdentitySeed>,
    successor: &ManagedCreateSuccessorIdentity,
) -> Result<(), ManagedCreateAdmissionError> {
    let successor_identity = successor
        .policy_digests
        .as_ref()
        .and_then(|policy| policy.conversation_identity.as_ref());
    if successor_identity != expected_identity {
        return Err(ManagedCreateAdmissionError::CanonicalConversationIdentityConflict);
    }
    Ok(())
}

struct ReleasedSuccessorConversationClaim {
    successor_owner: Option<ManagedConversationWriterOwner>,
}

fn released_successor_conversation_writer_claim(
    discovery_root: &Path,
    admission: Option<&ManagedConversationWriterAdmission>,
) -> Result<Option<ReleasedSuccessorConversationClaim>, ManagedCreateAdmissionError> {
    let Some(admission) = admission else {
        return Ok(None);
    };
    let Some(claim) = admission.claim() else {
        return Ok(None);
    };
    if !conversation_writer_owner_is_released(discovery_root, &admission.directory, claim)? {
        return Ok(None);
    }
    Ok(Some(ReleasedSuccessorConversationClaim {
        successor_owner: conversation_writer_successor_owner(&admission.directory, claim)?,
    }))
}

fn ensure_successor_conversation_writer_available(
    admission: Option<&ManagedConversationWriterAdmission>,
    released_claim: Option<&ReleasedSuccessorConversationClaim>,
    expected_identity: Option<&ProviderConversationIdentitySeed>,
    source_record: &ManagedCreateLedgerRecord,
    source: &ManagedCreateReconcileRequest,
    successor: &ManagedCreateSuccessorIdentity,
) -> Result<(), ManagedCreateAdmissionError> {
    let (Some(admission), Some(identity)) = (admission, expected_identity) else {
        return Ok(());
    };
    let Some(claim) = admission.claim() else {
        return Ok(());
    };
    let source_owner = ManagedConversationWriterOwner {
        workspace_id: source.workspace_id().to_string(),
        session_id: source.session_id().to_string(),
        idempotency_key: source.idempotency_key().to_string(),
        request_digest: source_record.request_digest.clone(),
    };
    let target_owner = ManagedConversationWriterOwner {
        workspace_id: source.workspace_id().to_string(),
        session_id: successor.session_id().to_string(),
        idempotency_key: successor.idempotency_key().to_string(),
        request_digest: successor_canonical_request_digest(successor).to_string(),
    };
    if (claim.owner == source_owner
        && source_record.conversation_identity.as_ref() == Some(identity))
        || claim.owner == target_owner
    {
        return Ok(());
    }
    if released_claim.is_some_and(|released| {
        released
            .successor_owner
            .as_ref()
            .is_none_or(|owner| owner == &target_owner)
    }) {
        return Ok(());
    }
    Err(ManagedCreateAdmissionError::ConversationWriterConflict {
        provider_id: claim.conversation_identity.provider_id().to_string(),
        owner_workspace_id: claim.owner.workspace_id.clone(),
        owner_session_id: claim.owner.session_id.clone(),
    })
}

/// The caller keeps the exact conversation shard locked through the target
/// session's Prepared publish and the final claim update.
fn ensure_conversation_writer_available(
    discovery_root: &Path,
    directory: &Path,
    admission: &ManagedConversationWriterAdmission,
    candidate: &ManagedConversationWriterOwner,
) -> Result<(), ManagedCreateAdmissionError> {
    let Some(claim) = admission.claim() else {
        return Ok(());
    };
    if claim.owner == *candidate {
        return Ok(());
    }
    if claim.owner.workspace_id == candidate.workspace_id
        && claim.owner.session_id == candidate.session_id
    {
        if claim.owner.idempotency_key == candidate.idempotency_key
            && conversation_writer_claim_matches_owner_record(directory, claim)?
        {
            // The immutable logical owner is intact. Its canonical request
            // digest is classified by the create ledger below; the claim is
            // not rewritten on this path.
            return Ok(());
        }
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_conversation_writer_invalid: claim owner changed".to_string(),
        ));
    }
    if conversation_writer_owner_is_released(discovery_root, directory, claim)? {
        if let Some(successor_owner) = conversation_writer_successor_owner(directory, claim)? {
            if *candidate == successor_owner {
                return Ok(());
            }
            return Err(ManagedCreateAdmissionError::ConversationWriterConflict {
                provider_id: claim.conversation_identity.provider_id().to_string(),
                owner_workspace_id: successor_owner.workspace_id,
                owner_session_id: successor_owner.session_id,
            });
        }
        return Ok(());
    }
    Err(ManagedCreateAdmissionError::ConversationWriterConflict {
        provider_id: claim.conversation_identity.provider_id().to_string(),
        owner_workspace_id: claim.owner.workspace_id.clone(),
        owner_session_id: claim.owner.session_id.clone(),
    })
}

fn conversation_writer_successor_owner(
    directory: &Path,
    claim: &ManagedConversationWriterClaim,
) -> Result<Option<ManagedConversationWriterOwner>, String> {
    let source = ManagedCreateReconcileRequest::new(
        &claim.owner.idempotency_key,
        &claim.owner.session_id,
        &claim.owner.workspace_id,
    )
    .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let Some(record) = read_lineage_create_record_from_directory(directory, &source)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let Some(ManagedCreateLedgerAuthorityV3 {
        successor:
            ManagedCreateSuccessorSlotV3::Intent {
                successor,
                policy_digests,
            },
        ..
    }) = record.authority.as_ref()
    else {
        return Ok(None);
    };
    let mut successor = successor.as_ref().clone();
    successor.policy_digests = policy_digests.clone();
    let target = ManagedCreateReconcileRequest::new(
        successor.idempotency_key(),
        successor.session_id(),
        source.workspace_id(),
    )
    .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let target_record = read_lineage_create_record_from_directory(directory, &target)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            "hmux_managed_create_ledger_invalid: reserved conversation successor is absent"
                .to_string()
        })?;
    if matches!(
        target_record.state,
        ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission
    ) {
        return Ok(None);
    }
    if target_record.conversation_identity.as_ref() != Some(&claim.conversation_identity) {
        return Ok(None);
    }
    Ok(Some(ManagedConversationWriterOwner {
        workspace_id: source.workspace_id().to_string(),
        session_id: successor.session_id().to_string(),
        idempotency_key: successor.idempotency_key().to_string(),
        request_digest: successor_canonical_request_digest(&successor).to_string(),
    }))
}

fn conversation_writer_claim_matches_owner_record(
    directory: &Path,
    claim: &ManagedConversationWriterClaim,
) -> Result<bool, String> {
    let record_key = logical_key(&claim.owner.workspace_id, &claim.owner.session_id);
    let (lock_path, shard_path) = shard_paths(directory, &record_key)?;
    if !private_path_exists(&shard_path)? {
        return Ok(false);
    }
    let _lock = acquire_shard_lock(&lock_path)?;
    let shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let Some(record) = shard.records.get(&record_key) else {
        return Ok(false);
    };
    Ok(record.workspace_id == claim.owner.workspace_id
        && record.session_id == claim.owner.session_id
        && record.idempotency_key == claim.owner.idempotency_key
        && record.request_digest == claim.owner.request_digest
        && record.conversation_identity.as_ref() == Some(&claim.conversation_identity))
}

fn conversation_writer_owner_is_released(
    discovery_root: &Path,
    directory: &Path,
    claim: &ManagedConversationWriterClaim,
) -> Result<bool, String> {
    let record_key = logical_key(&claim.owner.workspace_id, &claim.owner.session_id);
    let (lock_path, shard_path) = shard_paths(directory, &record_key)?;
    if !private_path_exists(&shard_path)? {
        return Err(
            "hmux_managed_create_ledger_invalid: conversation writer owner shard is absent"
                .to_string(),
        );
    }
    let _lock = acquire_shard_lock(&lock_path)?;
    let mut shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let record = shard.records.get(&record_key).cloned().ok_or_else(|| {
        "hmux_managed_create_ledger_invalid: conversation writer owner is absent".to_string()
    })?;
    if record.workspace_id != claim.owner.workspace_id
        || record.session_id != claim.owner.session_id
        || record.idempotency_key != claim.owner.idempotency_key
        || record.request_digest != claim.owner.request_digest
        || record.conversation_identity.as_ref() != Some(&claim.conversation_identity)
    {
        return Err(
            "hmux_managed_create_ledger_invalid: conversation writer owner changed".to_string(),
        );
    }
    if conversation_writer_is_released(&record) {
        return Ok(true);
    }
    if !completed_conversation_writer_has_exited(discovery_root, &record)? {
        return Ok(false);
    }
    let mut released = record;
    released.conversation_writer_released = true;
    shard.records.insert(record_key, released);
    write_shard(directory, &shard_path, &shard)?;
    Ok(true)
}

/// Persist the terminal writer fact immediately after the managed Host
/// publishes its exact Exited generation. A later admission repeats the same
/// proof, while GC protects the tombstone until this checkpoint succeeds.
pub fn release_exited_conversation_writer(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<bool, String> {
    SessionLookupKey::new(workspace_id, session_id)
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => {
            return Err(
                "hmux_managed_create_ledger_invalid: ledger directory is unreadable".to_string(),
            );
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let record_key = logical_key(workspace_id, session_id);
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    if !private_path_exists(&shard_path)? {
        return Ok(false);
    }
    let _lock = acquire_shard_lock(&lock_path)?;
    let mut shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let Some(record) = shard.records.get(&record_key).cloned() else {
        return Ok(false);
    };
    if record.workspace_id != workspace_id || record.session_id != session_id {
        return Err(
            "hmux_managed_create_ledger_invalid: exited writer identity changed".to_string(),
        );
    }
    if record.conversation_identity.is_none() || conversation_writer_is_released(&record) {
        return Ok(false);
    }
    if !completed_conversation_writer_has_exited(discovery_root, &record)? {
        return Ok(false);
    }
    let mut released = record;
    released.conversation_writer_released = true;
    shard.records.insert(record_key, released);
    write_shard(&directory, &shard_path, &shard)?;
    Ok(true)
}

fn conversation_writer_is_released(record: &ManagedCreateLedgerRecord) -> bool {
    record.conversation_writer_released
        || matches!(
            record.state,
            ManagedCreateLedgerRecordState::Completed { retired: true, .. }
                | ManagedCreateLedgerRecordState::RetiredBeforeCreateCompletion { .. }
                | ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion
        )
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn conversation_writer_key(identity: &ProviderConversationIdentitySeed) -> String {
    digest(&format!(
        "managed-conversation-writer-v1\0{}\0{}",
        identity.provider_id(),
        identity.conversation_id()
    ))
}

fn validate_conversation_writer_shard(
    shard: &ManagedConversationWriterShard,
    expected_index: usize,
) -> Result<(), String> {
    if shard.schema_version != CONVERSATION_WRITER_SCHEMA_VERSION
        || shard.claims.len() > MAX_SHARD_RECORDS
    {
        return Err(
            "hmux_managed_conversation_writer_invalid: shard schema or capacity changed"
                .to_string(),
        );
    }
    for (key, claim) in &shard.claims {
        claim
            .conversation_identity
            .validate()
            .map_err(|error| format!("hmux_managed_conversation_writer_invalid: {error}"))?;
        validate_identity(
            &claim.owner.workspace_id,
            &claim.owner.session_id,
            &claim.owner.idempotency_key,
            &claim.owner.request_digest,
        )?;
        if claim.schema_version != CONVERSATION_WRITER_SCHEMA_VERSION
            || conversation_writer_key(&claim.conversation_identity) != *key
            || shard_index(key)? != expected_index
        {
            return Err(
                "hmux_managed_conversation_writer_invalid: claim identity changed".to_string(),
            );
        }
    }
    Ok(())
}

fn read_conversation_writer_shard_or_default(
    path: &Path,
) -> Result<ManagedConversationWriterShard, String> {
    if !private_path_exists(path)? {
        return Ok(ManagedConversationWriterShard::default());
    }
    let file = open_private_existing(path, "managed conversation writer shard")?;
    let metadata = file
        .metadata()
        .map_err(|_| "hmux_managed_conversation_writer_invalid: shard is unreadable".to_string())?;
    if metadata.len() > MAX_SHARD_BYTES {
        return Err("hmux_managed_conversation_writer_capacity: shard is too large".to_string());
    }
    let mut payload = Vec::new();
    file.take(MAX_SHARD_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|_| "hmux_managed_conversation_writer_invalid: shard is unreadable".to_string())?;
    if payload.len() as u64 > MAX_SHARD_BYTES {
        return Err("hmux_managed_conversation_writer_capacity: shard is too large".to_string());
    }
    serde_json::from_slice(&payload)
        .map_err(|_| "hmux_managed_conversation_writer_invalid: shard is malformed".to_string())
}

fn write_conversation_writer_shard(
    directory: &Path,
    path: &Path,
    shard: &ManagedConversationWriterShard,
) -> Result<(), String> {
    let payload = serde_json::to_vec(shard).map_err(|_| {
        "hmux_managed_conversation_writer_failed: shard serialization failed".to_string()
    })?;
    if payload.len() as u64 > MAX_SHARD_BYTES {
        return Err("hmux_managed_conversation_writer_capacity: shard is too large".to_string());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            "hmux_managed_conversation_writer_invalid: shard path is malformed".to_string()
        })?;
    let temporary = directory.join(format!(".{stem}.tmp"));
    if private_path_exists(&temporary)? {
        let stale =
            open_private_existing(&temporary, "managed conversation writer temporary shard")?;
        ensure_same_open_file(&temporary, &stale)?;
        fs::remove_file(&temporary).map_err(|_| {
            "hmux_managed_conversation_writer_failed: stale temporary removal failed".to_string()
        })?;
        sync_private_directory(directory)?;
    }
    let write_result = (|| -> Result<(), String> {
        let mut file = open_private_new(&temporary)?;
        file.write_all(&payload).map_err(|_| {
            "hmux_managed_conversation_writer_failed: shard write failed".to_string()
        })?;
        file.sync_all().map_err(|_| {
            "hmux_managed_conversation_writer_failed: shard sync failed".to_string()
        })?;
        ensure_same_open_file(&temporary, &file)?;
        if private_path_exists(path)? {
            let existing = open_private_existing(path, "managed conversation writer shard")?;
            ensure_same_open_file(path, &existing)?;
        }
        drop(file);
        replace_private_file(&temporary, path).map_err(|_| {
            "hmux_managed_conversation_writer_failed: shard publish failed".to_string()
        })?;
        sync_private_directory(directory)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn logical_key(workspace_id: &str, session_id: &str) -> String {
    digest(&format!(
        "managed-create-ledger-v2\0{workspace_id}\0{session_id}"
    ))
}

/// Returns whether a deterministic successor session is routed through the
/// same atomic create shard as its source. The shard hash remains the sole
/// routing authority for both legacy and v3 records.
pub fn successor_session_shares_create_shard(
    source: &ManagedCreateReconcileRequest,
    target_session_id: &str,
) -> Result<bool, ManagedCreateAdmissionError> {
    source.validate().map_err(|error| {
        ManagedCreateAdmissionError::Ledger(format!(
            "hmux_managed_create_successor_invalid: {error}"
        ))
    })?;
    SessionLookupKey::new(source.workspace_id(), target_session_id).map_err(|error| {
        ManagedCreateAdmissionError::Ledger(format!(
            "hmux_managed_create_successor_invalid: {error}"
        ))
    })?;
    let source_index = shard_index(&logical_key(source.workspace_id(), source.session_id()))
        .map_err(ManagedCreateAdmissionError::Ledger)?;
    let target_index = shard_index(&logical_key(source.workspace_id(), target_session_id))
        .map_err(ManagedCreateAdmissionError::Ledger)?;
    Ok(source_index == target_index)
}

fn shard_index(record_key: &str) -> Result<usize, String> {
    let prefix = record_key
        .get(..2)
        .ok_or_else(|| "hmux_managed_create_ledger_invalid: record key is malformed".to_string())?;
    let index = usize::from_str_radix(prefix, 16)
        .map_err(|_| "hmux_managed_create_ledger_invalid: record key is malformed".to_string())?;
    if index >= LEDGER_SHARDS {
        return Err("hmux_managed_create_ledger_invalid: shard is out of range".to_string());
    }
    Ok(index)
}

fn shard_paths(directory: &Path, record_key: &str) -> Result<(PathBuf, PathBuf), String> {
    let index = shard_index(record_key)?;
    Ok((
        directory.join(format!("shard_{index:02x}.lock")),
        directory.join(format!("shard_{index:02x}.json")),
    ))
}

fn provider_release_guard_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("provider_release_guard_{index:02x}.json"))
}

fn acquire_shard_lock(path: &Path) -> Result<RecoveryLock, String> {
    RecoveryLock::acquire_admission(open_private_lock(path)?)
        .map_err(|_| "hmux_managed_create_ledger_failed: shard lock acquisition failed".to_string())
}

fn validate_identity(
    workspace_id: &str,
    session_id: &str,
    idempotency_key: &str,
    request_digest: &str,
) -> Result<(), String> {
    let bounded = |value: &str| {
        !value.is_empty() && value.len() <= 4_096 && !value.chars().any(char::is_control)
    };
    if !bounded(workspace_id)
        || !bounded(session_id)
        || !bounded(idempotency_key)
        || request_digest.len() != 64
        || !request_digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("hmux_managed_create_ledger_invalid: identity is malformed".to_string());
    }
    Ok(())
}

fn validate_digest(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "hmux_managed_create_ledger_invalid: {label} is malformed"
        ));
    }
    Ok(())
}

fn validate_successor_identity(
    identity: &ManagedCreateSuccessorIdentity,
) -> Result<(), ManagedCreateAdmissionError> {
    let bounded = |value: &str| {
        !value.is_empty() && value.len() <= 4_096 && !value.chars().any(char::is_control)
    };
    let valid_digest =
        |digest: &str| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit());
    if identity.schema_version != SUCCESSOR_LEDGER_SCHEMA_VERSION
        || !bounded(&identity.session_id)
        || !bounded(&identity.idempotency_key)
        || !valid_digest(&identity.request_digest)
        || identity.policy_digests.as_ref().is_some_and(|policy| {
            !valid_digest(&policy.canonical_request_digest)
                || policy
                    .rehost_recipe_digest
                    .as_deref()
                    .is_some_and(|digest| !valid_digest(digest))
        })
    {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: successor identity is malformed".to_string(),
        ));
    }
    Ok(())
}

fn validate_successor_record(
    record: &ManagedCreateSuccessorRecord,
    source: &ManagedCreateReconcileRequest,
    record_key: &str,
    expected_index: usize,
) -> Result<(), ManagedCreateAdmissionError> {
    match (&record.successor, record.cleanup_closed_unix_ms) {
        (Some(successor), None) => {
            validate_successor_identity(successor)?;
            if successor.session_id == record.source_session_id
                || successor.idempotency_key == record.source_idempotency_key
            {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "hmux_managed_create_successor_invalid: successor reused its source identity"
                        .to_string(),
                ));
            }
        }
        (None, Some(closed_unix_ms)) if closed_unix_ms != 0 => {}
        _ => {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: record must contain exactly one edge or cleanup closure"
                    .to_string(),
            ));
        }
    }
    if record.schema_version != SUCCESSOR_LEDGER_SCHEMA_VERSION
        || record.workspace_id != source.workspace_id()
        || record.source_session_id != source.session_id()
        || record.source_idempotency_key != source.idempotency_key()
        || logical_key(&record.workspace_id, &record.source_session_id) != record_key
        || shard_index(record_key)? != expected_index
        || record.created_unix_ms == 0
    {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: successor record identity changed".to_string(),
        ));
    }
    Ok(())
}

fn validate_successor_shard(
    shard: &ManagedCreateSuccessorShard,
    expected_index: usize,
) -> Result<(), ManagedCreateAdmissionError> {
    if shard.schema_version != SUCCESSOR_LEDGER_SCHEMA_VERSION
        || shard.records.len() > MAX_SHARD_RECORDS
    {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: shard schema or capacity changed".to_string(),
        ));
    }
    for (key, record) in &shard.records {
        let source = ManagedCreateReconcileRequest::new(
            &record.source_idempotency_key,
            &record.source_session_id,
            &record.workspace_id,
        )
        .map_err(|error| {
            ManagedCreateAdmissionError::Ledger(format!(
                "hmux_managed_create_successor_invalid: {error}"
            ))
        })?;
        validate_successor_record(record, &source, key, expected_index)?;
    }
    Ok(())
}

fn validate_successor_digest_shard(
    shard: &ManagedCreateSuccessorDigestShard,
    successors: &ManagedCreateSuccessorShard,
    expected_index: usize,
) -> Result<(), ManagedCreateAdmissionError> {
    if shard.schema_version != SUCCESSOR_DIGEST_LEDGER_SCHEMA_VERSION
        || shard.records.len() > MAX_SHARD_RECORDS
    {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: digest shard schema or capacity changed"
                .to_string(),
        ));
    }
    let valid_digest =
        |digest: &str| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit());
    for (key, record) in &shard.records {
        let edge_record = successors.records.get(key).ok_or_else(|| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: digest projection has no edge".to_string(),
            )
        })?;
        let successor = edge_record.successor.as_ref().ok_or_else(|| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: cleanup closure has a digest projection"
                    .to_string(),
            )
        })?;
        let source = ManagedCreateReconcileRequest::new(
            &edge_record.source_idempotency_key,
            &edge_record.source_session_id,
            &edge_record.workspace_id,
        )
        .map_err(|error| {
            ManagedCreateAdmissionError::Ledger(format!(
                "hmux_managed_create_successor_invalid: {error}"
            ))
        })?;
        if record.schema_version != SUCCESSOR_DIGEST_LEDGER_SCHEMA_VERSION
            || shard_index(key)? != expected_index
            || record.edge_fingerprint != successor_edge_fingerprint(&source, successor)?
            || !valid_digest(&record.canonical_request_digest)
            || record
                .raw_rehost_recipe_digest
                .as_deref()
                .is_some_and(|digest| !valid_digest(digest))
            || record.created_unix_ms == 0
        {
            return Err(ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: digest projection changed".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_successor_predecessor_record(
    record: &ManagedCreateSuccessorPredecessorRecord,
    target: &ManagedCreateReconcileRequest,
    record_key: &str,
    expected_index: usize,
) -> Result<(), ManagedCreateAdmissionError> {
    if record.schema_version != SUCCESSOR_PREDECESSOR_LEDGER_SCHEMA_VERSION
        || record.workspace_id != target.workspace_id()
        || record.target_session_id != target.session_id()
        || record.target_idempotency_key != target.idempotency_key()
        || logical_key(&record.workspace_id, &record.target_session_id) != record_key
        || shard_index(record_key).map_err(ManagedCreateAdmissionError::Ledger)? != expected_index
        || record.created_unix_ms == 0
    {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor projection changed".to_string(),
        ));
    }
    let valid_fingerprint = |fingerprint: &str| {
        fingerprint.len() == 64 && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    match &record.authority {
        ManagedCreateSuccessorPredecessorAuthority::Root {
            create_fingerprint, ..
        } => {
            if !valid_fingerprint(create_fingerprint) {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "hmux_managed_create_successor_invalid: root projection changed".to_string(),
                ));
            }
        }
        ManagedCreateSuccessorPredecessorAuthority::Predecessor {
            predecessor,
            edge_fingerprint,
        } => {
            predecessor.validate().map_err(|error| {
                ManagedCreateAdmissionError::Ledger(format!(
                    "hmux_managed_create_successor_invalid: {error}"
                ))
            })?;
            if predecessor.workspace_id() != target.workspace_id()
                || predecessor == target
                || !valid_fingerprint(edge_fingerprint)
            {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "hmux_managed_create_successor_invalid: predecessor projection changed"
                        .to_string(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_successor_predecessor_shard(
    shard: &ManagedCreateSuccessorPredecessorShard,
    expected_index: usize,
) -> Result<(), ManagedCreateAdmissionError> {
    if shard.schema_version != SUCCESSOR_PREDECESSOR_LEDGER_SCHEMA_VERSION
        || shard.records.len() > MAX_SHARD_RECORDS
    {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: predecessor shard schema or capacity changed"
                .to_string(),
        ));
    }
    for (key, record) in &shard.records {
        let target = ManagedCreateReconcileRequest::new(
            &record.target_idempotency_key,
            &record.target_session_id,
            &record.workspace_id,
        )
        .map_err(|error| {
            ManagedCreateAdmissionError::Ledger(format!(
                "hmux_managed_create_successor_invalid: {error}"
            ))
        })?;
        validate_successor_predecessor_record(record, &target, key, expected_index)?;
    }
    Ok(())
}

fn validate_process(process: &ProcessDescriptor) -> Result<(), String> {
    if process.process_id <= 1
        || process.start_marker.is_empty()
        || process.start_marker.len() > 4_096
    {
        return Err(
            "hmux_managed_create_ledger_invalid: Host process proof is malformed".to_string(),
        );
    }
    Ok(())
}

fn validate_starting_generation(generation: &ManagedStartingGeneration) -> Result<(), String> {
    if generation.idempotency_key.is_empty()
        || generation.idempotency_key.len() > 4_096
        || generation.idempotency_key.chars().any(char::is_control)
    {
        return Err(
            "hmux_managed_create_ledger_invalid: Starting create identity is malformed".to_string(),
        );
    }
    validate_process(&generation.host_process)?;
    validate_process(&generation.provider_process)?;
    if generation.host_process == generation.provider_process {
        return Err(
            "hmux_managed_create_ledger_invalid: Host and provider generations are identical"
                .to_string(),
        );
    }
    let fence = &generation.generation_fence;
    ManagedCreateGenerationFence::new(
        fence.runner_principal(),
        fence.runner_instance(),
        fence.channel_epoch(),
        fence.host_instance_id(),
        fence.terminal_epoch(),
    )
    .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let limits = hmux_host::local_discovery::ManifestLimits::default();
    if generation.endpoint.address.is_empty()
        || generation.endpoint.address.len() > limits.max_endpoint_bytes
        || generation.capability_token.is_empty()
        || generation.capability_token.len() > limits.max_capability_token_bytes
    {
        return Err(
            "hmux_managed_create_ledger_invalid: Starting transport identity is malformed"
                .to_string(),
        );
    }
    if let Some(identity) = &generation.conversation_identity {
        identity
            .validate()
            .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    }
    Ok(())
}

fn validate_record(
    record: &ManagedCreateLedgerRecord,
    workspace_id: &str,
    session_id: &str,
) -> Result<(), String> {
    validate_identity(
        &record.workspace_id,
        &record.session_id,
        &record.idempotency_key,
        &record.request_digest,
    )?;
    if !matches!(
        record.schema_version,
        LEDGER_RECORD_SCHEMA_VERSION_V2 | LEDGER_RECORD_SCHEMA_VERSION
    ) || record.workspace_id != workspace_id
        || record.session_id != session_id
        || record.created_unix_ms == 0
    {
        return Err("hmux_managed_create_ledger_invalid: record identity changed".to_string());
    }
    match (record.schema_version, record.authority.as_ref()) {
        (LEDGER_RECORD_SCHEMA_VERSION_V2, None) | (LEDGER_RECORD_SCHEMA_VERSION, Some(_)) => {}
        _ => {
            return Err(
                "hmux_managed_create_ledger_invalid: record authority version changed".to_string(),
            );
        }
    }
    if let Some(identity) = &record.conversation_identity {
        identity
            .validate()
            .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    }
    if let Some(serialized) = record.canonical_rehost_recipe.as_deref() {
        decode_canonical_rehost_recipe(serialized, workspace_id, session_id)?;
    }
    if record.conversation_writer_released
        && (record.conversation_identity.is_none()
            || !matches!(
                record.state,
                ManagedCreateLedgerRecordState::Completed { .. }
                    | ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion
            ))
    {
        return Err(
            "hmux_managed_create_ledger_invalid: conversation writer release is malformed"
                .to_string(),
        );
    }
    match &record.state {
        ManagedCreateLedgerRecordState::SpawnReserved { host_process } => {
            validate_process(host_process)?;
        }
        ManagedCreateLedgerRecordState::LaunchReleased {
            host_process,
            starting_generation,
        } => {
            validate_process(host_process)?;
            if let Some(starting) = starting_generation {
                validate_starting_generation(starting)?;
                if record
                    .conversation_identity
                    .as_ref()
                    .zip(starting.conversation_identity())
                    .is_some_and(|(recorded, starting)| recorded != starting)
                {
                    return Err(
                        "hmux_managed_create_ledger_invalid: Starting conversation identity changed"
                            .to_string(),
                    );
                }
                if starting.host_process != *host_process {
                    return Err(
                        "hmux_managed_create_ledger_invalid: Starting Host generation changed"
                            .to_string(),
                    );
                }
            }
        }
        ManagedCreateLedgerRecordState::Completed {
            receipt,
            retired: _,
            retiring_stop_receipt,
        } => {
            validate_create_receipt(receipt)?;
            if let Some(stop) = retiring_stop_receipt {
                validate_stop_receipt(stop)?;
            }
        }
        ManagedCreateLedgerRecordState::RetiringBeforeCreateCompletion { stop_receipt }
        | ManagedCreateLedgerRecordState::RetiredBeforeCreateCompletion { stop_receipt } => {
            validate_stop_receipt(stop_receipt)?;
        }
        ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission => {
            let direct_unborn_successor = matches!(
                record
                    .authority
                    .as_ref()
                    .map(|authority| &authority.lineage),
                Some(ManagedCreateLineageAuthorityV3::Predecessor { .. })
            );
            if record.conversation_writer_released
                || (!direct_unborn_successor
                    && (record.conversation_identity.is_some()
                        || record.canonical_rehost_recipe.is_some()))
            {
                return Err(
                    "hmux_managed_create_ledger_invalid: cleanup-closed create has incompatible authority"
                        .to_string(),
                );
            }
        }
        ManagedCreateLedgerRecordState::SuccessorLineagePending
        | ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified
        | ManagedCreateLedgerRecordState::RootLineagePending
        | ManagedCreateLedgerRecordState::Prepared
        | ManagedCreateLedgerRecordState::PreSpawnAbsenceCheckpointed
        | ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion => {}
    }
    if let Some(authority) = &record.authority {
        match &authority.lineage {
            ManagedCreateLineageAuthorityV3::Root { .. }
            | ManagedCreateLineageAuthorityV3::LegacyV2 => {}
            ManagedCreateLineageAuthorityV3::Predecessor {
                source,
                edge_fingerprint,
            } => {
                source
                    .validate()
                    .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
                validate_digest(edge_fingerprint, "v3 successor edge fingerprint")?;
            }
        }
        match &authority.successor {
            ManagedCreateSuccessorSlotV3::Vacant => {}
            ManagedCreateSuccessorSlotV3::Intent {
                successor,
                policy_digests,
            } => {
                validate_successor_identity(successor).map_err(|error| error.to_string())?;
                let policy = policy_digests.as_ref().ok_or_else(|| {
                    "hmux_managed_create_ledger_invalid: v3 target policy authority is absent"
                        .to_string()
                })?;
                validate_digest(
                    &policy.canonical_request_digest,
                    "v3 canonical request digest",
                )?;
                if let Some(recipe) = &policy.rehost_recipe_digest {
                    validate_digest(recipe, "v3 rehost recipe digest")?;
                }
                if policy.rehost_recipe_digest.is_some() != policy.canonical_rehost_recipe.is_some()
                {
                    return Err(
                        "hmux_managed_create_ledger_invalid: v3 rehost authority is incomplete"
                            .to_string(),
                    );
                }
                if let Some(identity) = &policy.conversation_identity {
                    identity
                        .validate()
                        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
                }
            }
            ManagedCreateSuccessorSlotV3::Closed { closed_unix_ms } => {
                if *closed_unix_ms == 0 {
                    return Err(
                        "hmux_managed_create_ledger_invalid: v3 successor closure changed"
                            .to_string(),
                    );
                }
            }
        }
    }
    if matches!(
        record.state,
        ManagedCreateLedgerRecordState::SuccessorLineagePending
    ) && !matches!(
        record
            .authority
            .as_ref()
            .map(|authority| &authority.lineage),
        Some(ManagedCreateLineageAuthorityV3::Predecessor { .. })
    ) {
        return Err(
            "hmux_managed_create_ledger_invalid: pending successor has no predecessor".to_string(),
        );
    }
    Ok(())
}

fn validate_create_receipt(receipt: &str) -> Result<(), String> {
    if receipt.is_empty()
        || receipt.len() > usize::try_from(MAX_RECORD_BYTES / 2).unwrap_or(usize::MAX)
        || serde_json::from_str::<serde_json::Value>(receipt).is_err()
    {
        return Err("hmux_managed_create_ledger_invalid: receipt is not bounded JSON".to_string());
    }
    Ok(())
}

fn validate_stop_receipt(receipt: &str) -> Result<(), String> {
    decode_persisted_stop_receipt(
        receipt,
        "hmux_managed_create_ledger_invalid: stop receipt is malformed",
    )
    .map(|_| ())
}

fn decode_persisted_stop_receipt(
    serialized: &str,
    malformed_error: &str,
) -> Result<ManagedStopReceipt, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(serialized).map_err(|_| malformed_error.to_string())?;
    if value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        == Some(ARCHIVED_UNTOUCHED_STOP_RECEIPT_VERSION)
    {
        let object = value
            .as_object_mut()
            .ok_or_else(|| malformed_error.to_string())?;
        let is_archived_untouched_receipt =
            object.get("schema").and_then(serde_json::Value::as_str) == Some(MANAGED_STOP_SCHEMA)
                && object
                    .get("requireUntouchedAgent")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true);
        if !is_archived_untouched_receipt {
            return Err(
                "hmux_managed_create_ledger_invalid: managed stop receipt has an unsupported schema"
                    .to_string(),
            );
        }
        object.insert(
            "schemaVersion".to_string(),
            serde_json::Value::from(CURRENT_STOP_RECEIPT_VERSION),
        );
        object.remove("requireUntouchedAgent");
    }
    let receipt: ManagedStopReceipt =
        serde_json::from_value(value).map_err(|_| malformed_error.to_string())?;
    receipt
        .validate()
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    Ok(receipt)
}

fn validate_shard(shard: &ManagedCreateLedgerShard, expected_index: usize) -> Result<(), String> {
    if !matches!(
        shard.schema_version,
        LEDGER_SHARD_SCHEMA_VERSION_V2 | LEDGER_SHARD_SCHEMA_VERSION
    ) || shard.records.len() > MAX_SHARD_RECORDS
    {
        return Err(
            "hmux_managed_create_ledger_invalid: shard schema or capacity changed".to_string(),
        );
    }
    for (key, record) in &shard.records {
        if shard.schema_version == LEDGER_SHARD_SCHEMA_VERSION_V2
            && record.schema_version != LEDGER_RECORD_SCHEMA_VERSION_V2
        {
            return Err(
                "hmux_managed_create_ledger_invalid: v2 shard contains a newer record".to_string(),
            );
        }
        if logical_key(&record.workspace_id, &record.session_id) != *key
            || shard_index(key)? != expected_index
        {
            return Err(
                "hmux_managed_create_ledger_invalid: shard record identity changed".to_string(),
            );
        }
        validate_record(record, &record.workspace_id, &record.session_id)?;
    }
    for record in shard.records.values() {
        let Some(ManagedCreateLedgerAuthorityV3 {
            successor:
                ManagedCreateSuccessorSlotV3::Intent {
                    successor,
                    policy_digests,
                },
            ..
        }) = record.authority.as_ref()
        else {
            continue;
        };
        let target_key = logical_key(&record.workspace_id, successor.session_id());
        if shard_index(&target_key)? != expected_index {
            return Err(
                "hmux_managed_create_ledger_invalid: v3 successor changed create shard".to_string(),
            );
        }
        let target = shard.records.get(&target_key).ok_or_else(|| {
            "hmux_managed_create_ledger_invalid: v3 successor target is absent".to_string()
        })?;
        let Some(ManagedCreateLedgerAuthorityV3 {
            lineage:
                ManagedCreateLineageAuthorityV3::Predecessor {
                    source,
                    edge_fingerprint,
                },
            ..
        }) = target.authority.as_ref()
        else {
            return Err(
                "hmux_managed_create_ledger_invalid: v3 successor reverse lineage is absent"
                    .to_string(),
            );
        };
        if source.workspace_id() != record.workspace_id
            || source.session_id() != record.session_id
            || source.idempotency_key() != record.idempotency_key
        {
            return Err(
                "hmux_managed_create_ledger_invalid: v3 successor predecessor changed".to_string(),
            );
        }
        let mut successor = successor.as_ref().clone();
        successor.policy_digests = policy_digests.clone();
        let target_request_digest = successor_canonical_request_digest(&successor);
        if successor_edge_fingerprint(source, &successor).map_err(|error| error.to_string())?
            != *edge_fingerprint
            || target.idempotency_key != successor.idempotency_key
            || target.request_digest != target_request_digest
        {
            return Err(
                "hmux_managed_create_ledger_invalid: v3 successor policy changed".to_string(),
            );
        }
        let (canonical_rehost_recipe, conversation_identity, rehost_recipe_digest) = policy_digests
            .as_ref()
            .map_or((None, None, None), |policy| {
                (
                    policy.canonical_rehost_recipe.as_ref(),
                    policy.conversation_identity.as_ref(),
                    policy.rehost_recipe_digest.as_deref(),
                )
            });
        if target.canonical_rehost_recipe.as_ref() != canonical_rehost_recipe
            || target.conversation_identity.as_ref() != conversation_identity
            || admitted_rehost_recipe_digest(target)
                .map_err(|error| error.to_string())?
                .as_deref()
                != rehost_recipe_digest
        {
            return Err(
                "hmux_managed_create_ledger_invalid: v3 successor full policy changed".to_string(),
            );
        }
    }
    for target in shard.records.values() {
        let Some(ManagedCreateLedgerAuthorityV3 {
            lineage:
                ManagedCreateLineageAuthorityV3::Predecessor {
                    source,
                    edge_fingerprint,
                },
            ..
        }) = target.authority.as_ref()
        else {
            continue;
        };
        let source_key = logical_key(source.workspace_id(), source.session_id());
        let source_record = shard.records.get(&source_key).ok_or_else(|| {
            "hmux_managed_create_ledger_invalid: v3 predecessor source is absent".to_string()
        })?;
        let Some(ManagedCreateLedgerAuthorityV3 {
            successor:
                ManagedCreateSuccessorSlotV3::Intent {
                    successor,
                    policy_digests,
                },
            ..
        }) = source_record.authority.as_ref()
        else {
            return Err(
                "hmux_managed_create_ledger_invalid: v3 predecessor has no forward intent"
                    .to_string(),
            );
        };
        let mut successor = successor.as_ref().clone();
        successor.policy_digests = policy_digests.clone();
        if source.idempotency_key() != source_record.idempotency_key
            || source.workspace_id() != target.workspace_id
            || successor.session_id() != target.session_id
            || successor.idempotency_key() != target.idempotency_key
            || successor_edge_fingerprint(source, &successor).map_err(|error| error.to_string())?
                != *edge_fingerprint
        {
            return Err(
                "hmux_managed_create_ledger_invalid: v3 predecessor lineage changed".to_string(),
            );
        }
    }
    Ok(())
}

fn validate_provider_release_guard_shard(
    shard: &ManagedProviderReleaseGuardShard,
    expected_index: usize,
) -> Result<(), String> {
    if shard.schema_version != PROVIDER_RELEASE_GUARD_SCHEMA_VERSION
        || shard.records.len() > MAX_SHARD_RECORDS
    {
        return Err(
            "hmux_managed_provider_release_guard_invalid: shard schema or capacity changed"
                .to_string(),
        );
    }
    for (key, guard) in &shard.records {
        if shard_index(key)? != expected_index
            || guard.schema_version != PROVIDER_RELEASE_GUARD_SCHEMA_VERSION
            || guard.launch_fingerprint.len() != 64
            || !guard
                .launch_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(
                "hmux_managed_provider_release_guard_invalid: shard record changed".to_string(),
            );
        }
    }
    Ok(())
}

fn read_shard_or_default(path: &Path) -> Result<ManagedCreateLedgerShard, String> {
    if !private_path_exists(path)? {
        return Ok(ManagedCreateLedgerShard::default());
    }
    let file = open_private_existing(path, "managed create ledger shard")?;
    let metadata = file
        .metadata()
        .map_err(|_| "hmux_managed_create_ledger_invalid: shard is unreadable".to_string())?;
    if metadata.len() > MAX_SHARD_BYTES {
        return Err("hmux_managed_create_ledger_capacity: shard is too large".to_string());
    }
    let mut payload = Vec::new();
    file.take(MAX_SHARD_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|_| "hmux_managed_create_ledger_invalid: shard is unreadable".to_string())?;
    if payload.len() as u64 > MAX_SHARD_BYTES {
        return Err("hmux_managed_create_ledger_capacity: shard is too large".to_string());
    }
    serde_json::from_slice(&payload)
        .map_err(|_| "hmux_managed_create_ledger_invalid: shard is malformed".to_string())
}

fn read_provider_release_guard_shard_or_default(
    path: &Path,
) -> Result<ManagedProviderReleaseGuardShard, String> {
    if !private_path_exists(path)? {
        return Ok(ManagedProviderReleaseGuardShard::default());
    }
    let file = open_private_existing(path, "managed provider release guard shard")?;
    let metadata = file.metadata().map_err(|_| {
        "hmux_managed_provider_release_guard_invalid: shard is unreadable".to_string()
    })?;
    if metadata.len() > MAX_SHARD_BYTES {
        return Err("hmux_managed_provider_release_guard_capacity: shard is too large".to_string());
    }
    let mut payload = Vec::new();
    file.take(MAX_SHARD_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|_| {
            "hmux_managed_provider_release_guard_invalid: shard is unreadable".to_string()
        })?;
    if payload.len() as u64 > MAX_SHARD_BYTES {
        return Err("hmux_managed_provider_release_guard_capacity: shard is too large".to_string());
    }
    serde_json::from_slice(&payload)
        .map_err(|_| "hmux_managed_provider_release_guard_invalid: shard is malformed".to_string())
}

fn read_successor_shard_or_default(
    path: &Path,
) -> Result<ManagedCreateSuccessorShard, ManagedCreateAdmissionError> {
    read_successor_state_or_default(path)
}

fn read_successor_digest_shard_or_default(
    path: &Path,
) -> Result<ManagedCreateSuccessorDigestShard, ManagedCreateAdmissionError> {
    read_successor_state_or_default(path)
}

fn read_successor_state_or_default<T>(path: &Path) -> Result<T, ManagedCreateAdmissionError>
where
    T: Default + DeserializeOwned,
{
    if !private_path_exists(path)? {
        return Ok(T::default());
    }
    let mut file = open_private_existing(path, "managed create successor shard")?;
    let metadata = file.metadata().map_err(|_| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: shard is unreadable".to_string(),
        )
    })?;
    if metadata.len() > MAX_SHARD_BYTES {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_capacity: shard is too large".to_string(),
        ));
    }
    let mut payload = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_SHARD_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|_| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: shard is unreadable".to_string(),
            )
        })?;
    if payload.len() as u64 > MAX_SHARD_BYTES {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_capacity: shard is too large".to_string(),
        ));
    }
    let state = serde_json::from_slice(&payload).map_err(|_| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: shard is malformed".to_string(),
        )
    })?;
    ensure_same_open_file(path, &file)?;
    Ok(state)
}

fn write_successor_shard<T: Serialize>(
    directory: &Path,
    path: &Path,
    shard: &T,
) -> Result<(), ManagedCreateAdmissionError> {
    write_bounded_successor_shard(directory, path, serialize_successor_shard(shard)?)
}

fn serialize_successor_shard<T: Serialize>(
    shard: &T,
) -> Result<BoundedSuccessorShardPayload, ManagedCreateAdmissionError> {
    let payload = serde_json::to_vec(shard).map_err(|_| {
        ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_failed: shard serialization failed".to_string(),
        )
    })?;
    if payload.len() as u64 > MAX_SHARD_BYTES {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_capacity: shard is too large".to_string(),
        ));
    }
    Ok(BoundedSuccessorShardPayload(payload))
}

fn write_bounded_successor_shard(
    directory: &Path,
    path: &Path,
    payload: BoundedSuccessorShardPayload,
) -> Result<(), ManagedCreateAdmissionError> {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_invalid: shard path is malformed".to_string(),
            )
        })?;
    let temporary = directory.join(format!(".{stem}.tmp"));
    if private_path_exists(&temporary)? {
        let stale = open_private_existing(&temporary, "managed create successor temporary shard")?;
        ensure_same_open_file(&temporary, &stale)?;
        fs::remove_file(&temporary).map_err(|_| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_failed: stale temporary removal failed".to_string(),
            )
        })?;
        sync_private_directory(directory)?;
    }
    let write_result = (|| -> Result<(), ManagedCreateAdmissionError> {
        let mut file = open_private_new(&temporary)?;
        file.write_all(&payload.0).map_err(|_| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_failed: shard write failed".to_string(),
            )
        })?;
        file.sync_all().map_err(|_| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_failed: shard sync failed".to_string(),
            )
        })?;
        ensure_same_open_file(&temporary, &file)?;
        if private_path_exists(path)? {
            let existing = open_private_existing(path, "managed create successor shard")?;
            ensure_same_open_file(path, &existing)?;
        }
        drop(file);
        replace_private_file(&temporary, path).map_err(|_| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_successor_failed: shard publish failed".to_string(),
            )
        })?;
        sync_private_directory(directory)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn write_provider_release_guard_shard(
    directory: &Path,
    path: &Path,
    shard: &ManagedProviderReleaseGuardShard,
) -> Result<(), String> {
    let payload = serde_json::to_vec(shard).map_err(|_| {
        "hmux_managed_provider_release_guard_failed: shard serialization failed".to_string()
    })?;
    if payload.len() as u64 > MAX_SHARD_BYTES {
        return Err("hmux_managed_provider_release_guard_capacity: shard is too large".to_string());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            "hmux_managed_provider_release_guard_invalid: shard path is malformed".to_string()
        })?;
    let temporary = directory.join(format!(".{stem}.tmp"));
    if private_path_exists(&temporary)? {
        let stale =
            open_private_existing(&temporary, "managed provider release guard temporary shard")?;
        ensure_same_open_file(&temporary, &stale)?;
        fs::remove_file(&temporary).map_err(|_| {
            "hmux_managed_provider_release_guard_failed: stale temporary removal failed".to_string()
        })?;
        sync_private_directory(directory)?;
    }
    let write_result = (|| -> Result<(), String> {
        let mut file = open_private_new(&temporary)?;
        file.write_all(&payload).map_err(|_| {
            "hmux_managed_provider_release_guard_failed: shard write failed".to_string()
        })?;
        file.sync_all().map_err(|_| {
            "hmux_managed_provider_release_guard_failed: shard sync failed".to_string()
        })?;
        ensure_same_open_file(&temporary, &file)?;
        if private_path_exists(path)? {
            let existing = open_private_existing(path, "managed provider release guard shard")?;
            ensure_same_open_file(path, &existing)?;
        }
        drop(file);
        replace_private_file(&temporary, path).map_err(|_| {
            "hmux_managed_provider_release_guard_failed: shard publish failed".to_string()
        })?;
        sync_private_directory(directory)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn write_shard(
    directory: &Path,
    path: &Path,
    shard: &ManagedCreateLedgerShard,
) -> Result<(), String> {
    let payload = serde_json::to_vec(shard)
        .map_err(|_| "hmux_managed_create_ledger_failed: shard serialization failed".to_string())?;
    if payload.len() as u64 > MAX_SHARD_BYTES {
        return Err("hmux_managed_create_ledger_capacity: shard is too large".to_string());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "hmux_managed_create_ledger_invalid: shard path is malformed".to_string())?;
    let temporary = directory.join(format!(".{stem}.tmp"));
    if private_path_exists(&temporary)? {
        let stale = open_private_existing(&temporary, "managed create ledger temporary shard")?;
        ensure_same_open_file(&temporary, &stale)?;
        fs::remove_file(&temporary).map_err(|_| {
            "hmux_managed_create_ledger_failed: stale temporary removal failed".to_string()
        })?;
        sync_private_directory(directory)?;
    }
    let write_result = (|| -> Result<(), String> {
        let mut file = open_private_new(&temporary)?;
        file.write_all(&payload)
            .map_err(|_| "hmux_managed_create_ledger_failed: shard write failed".to_string())?;
        file.sync_all()
            .map_err(|_| "hmux_managed_create_ledger_failed: shard sync failed".to_string())?;
        ensure_same_open_file(&temporary, &file)?;
        if private_path_exists(path)? {
            let existing = open_private_existing(path, "managed create ledger shard")?;
            ensure_same_open_file(path, &existing)?;
        }
        drop(file);
        replace_private_file(&temporary, path)
            .map_err(|_| "hmux_managed_create_ledger_failed: shard publish failed".to_string())?;
        sync_private_directory(directory)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(all(test, unix))]
mod tests {
    mod abandoned_cleanup;
    mod retired_cleanup;

    use super::*;
    use hmux_runtime_contract::{
        MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
        MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION, MANAGED_STOP_QUIESCENT_REQUEST_VERSION,
        ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateRequest,
        ManagedRehostRecipe, ManagedRehostSourceRecipe, ManagedStopOutcome, PermissionMode,
    };
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::sync::{
        Arc, Barrier,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    };
    use std::thread;
    use std::time::Duration;

    fn secure_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        root
    }

    fn request_digest(seed: u8) -> String {
        format!("{seed:02x}").repeat(32)
    }

    fn admission_error(
        result: Result<ManagedCreateLedgerState, ManagedCreateAdmissionError>,
    ) -> ManagedCreateAdmissionError {
        match result {
            Err(error) => error,
            Ok(_) => panic!("managed create admission unexpectedly succeeded"),
        }
    }

    fn process(id: u32) -> ProcessDescriptor {
        ProcessDescriptor {
            process_id: id,
            start_marker: format!("exact-{id}"),
        }
    }

    fn successor_chain(
        identities: Vec<ManagedCreateReconcileRequest>,
    ) -> ManagedCreateSuccessorChain {
        ManagedCreateSuccessorChain::new(identities, Vec::new())
    }

    fn ledger_record(
        root: &Path,
        identity: &ManagedCreateReconcileRequest,
    ) -> ManagedCreateLedgerRecord {
        let record_key = logical_key(identity.workspace_id(), identity.session_id());
        let index = shard_index(&record_key).unwrap();
        let shard = read_shard_or_default(
            &root
                .join(LEDGER_DIRECTORY)
                .join(format!("shard_{index:02x}.json")),
        )
        .unwrap();
        shard.records.get(&record_key).unwrap().clone()
    }

    fn legacy_v2_writer_accepts_shard(payload: &[u8]) -> bool {
        const LEGACY_STATES: &[&str] = &[
            "pre_spawn_absence_unverified",
            "prepared",
            "pre_spawn_absence_checkpointed",
            "spawn_reserved",
            "launch_released",
            "completed",
            "retiring_before_create_completion",
            "retired_before_create_completion",
            "abandoned_before_create_completion",
            "cleanup_closed_before_create_admission",
        ];
        serde_json::from_slice::<serde_json::Value>(payload).is_ok_and(|shard| {
            shard["schemaVersion"] == LEDGER_SHARD_SCHEMA_VERSION_V2
                && shard["records"].as_object().is_some_and(|records| {
                    records.values().all(|record| {
                        record["schemaVersion"] == LEDGER_RECORD_SCHEMA_VERSION_V2
                            && record["state"]
                                .as_str()
                                .is_some_and(|state| LEGACY_STATES.contains(&state))
                    })
                })
        })
    }

    fn abandon_generation(root: &Path, identity: &ManagedCreateReconcileRequest, digest: &str) {
        let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
            root,
            identity.workspace_id(),
            identity.session_id(),
            identity.idempotency_key(),
            digest,
        )
        .unwrap() else {
            panic!("generation must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.abandon_before_completion().unwrap();
    }

    fn downgrade_root_lineage_proof(root: &Path, identity: &ManagedCreateReconcileRequest) {
        let directory = root.join(LEDGER_DIRECTORY);
        let record_key = logical_key(identity.workspace_id(), identity.session_id());
        let (_, shard_path) = shard_paths(&directory, &record_key).unwrap();
        let mut shard = read_shard_or_default(&shard_path).unwrap();
        let Some(ManagedCreateLedgerAuthorityV3 {
            lineage:
                ManagedCreateLineageAuthorityV3::Root {
                    legacy_predecessor_absence_proven,
                },
            ..
        }) = shard
            .records
            .get_mut(&record_key)
            .and_then(|record| record.authority.as_mut())
        else {
            panic!("the generation must have direct Root authority")
        };
        *legacy_predecessor_absence_proven = false;
        write_shard(&directory, &shard_path, &shard).unwrap();
    }

    fn abandon_legacy_generation(
        root: &Path,
        identity: &ManagedCreateReconcileRequest,
        digest: &str,
    ) {
        write_retained_v2_generation(
            root,
            identity,
            digest,
            ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion,
        );
    }

    fn write_retained_v2_generation(
        root: &Path,
        identity: &ManagedCreateReconcileRequest,
        digest: &str,
        state: ManagedCreateLedgerRecordState,
    ) {
        let directory = root.join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        assert!(
            !directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists(),
            "a retained v2 fixture must precede predecessor coverage",
        );
        let record_key = logical_key(identity.workspace_id(), identity.session_id());
        let (_, shard_path) = shard_paths(&directory, &record_key).unwrap();
        let mut shard = read_shard_or_default(&shard_path).unwrap();
        assert!(
            shard
                .records
                .values()
                .all(|record| record.schema_version == LEDGER_RECORD_SCHEMA_VERSION_V2),
            "a retained v2 fixture cannot be mixed into a current shard",
        );
        shard.schema_version = LEDGER_SHARD_SCHEMA_VERSION_V2;
        shard.records.insert(
            record_key,
            ManagedCreateLedgerRecord {
                schema_version: LEDGER_RECORD_SCHEMA_VERSION_V2,
                workspace_id: identity.workspace_id().to_string(),
                session_id: identity.session_id().to_string(),
                idempotency_key: identity.idempotency_key().to_string(),
                request_digest: digest.to_string(),
                conversation_identity: None,
                conversation_writer_released: false,
                canonical_rehost_recipe: None,
                created_unix_ms: unix_time_ms(),
                authority: None,
                state,
            },
        );
        write_shard(&directory, &shard_path, &shard).unwrap();
    }

    fn write_precoverage_v3_root_generation(
        root: &Path,
        identity: &ManagedCreateReconcileRequest,
        digest: &str,
    ) {
        let directory = root.join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        assert!(!directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists());
        let record_key = logical_key(identity.workspace_id(), identity.session_id());
        let (_, shard_path) = shard_paths(&directory, &record_key).unwrap();
        let mut shard = read_shard_or_default(&shard_path).unwrap();
        shard.schema_version = LEDGER_SHARD_SCHEMA_VERSION;
        shard.records.insert(
            record_key,
            ManagedCreateLedgerRecord {
                schema_version: LEDGER_RECORD_SCHEMA_VERSION,
                workspace_id: identity.workspace_id().to_string(),
                session_id: identity.session_id().to_string(),
                idempotency_key: identity.idempotency_key().to_string(),
                request_digest: digest.to_string(),
                conversation_identity: None,
                conversation_writer_released: false,
                canonical_rehost_recipe: None,
                created_unix_ms: unix_time_ms(),
                authority: Some(ManagedCreateLedgerAuthorityV3 {
                    lineage: ManagedCreateLineageAuthorityV3::Root {
                        legacy_predecessor_absence_proven: true,
                    },
                    successor: ManagedCreateSuccessorSlotV3::Vacant,
                }),
                state: ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified,
            },
        );
        write_shard(&directory, &shard_path, &shard).unwrap();
    }

    fn write_precoverage_v3_predecessor_generation(
        root: &Path,
        source: &ManagedCreateReconcileRequest,
        target: &ManagedCreateReconcileRequest,
        digest: &str,
    ) {
        let directory = root.join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        assert!(!directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists());
        let source_key = logical_key(source.workspace_id(), source.session_id());
        let target_key = logical_key(target.workspace_id(), target.session_id());
        let source_index = shard_index(&source_key).unwrap();
        assert_eq!(source_index, shard_index(&target_key).unwrap());
        let (_, shard_path) = shard_paths(&directory, &source_key).unwrap();
        let mut shard = read_shard_or_default(&shard_path).unwrap();
        let successor = successor_for_target(target, digest);
        let edge_fingerprint = successor_edge_fingerprint(source, &successor).unwrap();
        shard.schema_version = LEDGER_SHARD_SCHEMA_VERSION;
        shard.records.insert(
            source_key,
            ManagedCreateLedgerRecord {
                schema_version: LEDGER_RECORD_SCHEMA_VERSION,
                workspace_id: source.workspace_id().to_string(),
                session_id: source.session_id().to_string(),
                idempotency_key: source.idempotency_key().to_string(),
                request_digest: digest.to_string(),
                conversation_identity: None,
                conversation_writer_released: false,
                canonical_rehost_recipe: None,
                created_unix_ms: unix_time_ms(),
                authority: Some(ManagedCreateLedgerAuthorityV3 {
                    lineage: ManagedCreateLineageAuthorityV3::Root {
                        legacy_predecessor_absence_proven: true,
                    },
                    successor: ManagedCreateSuccessorSlotV3::Intent {
                        successor: Box::new(successor.clone()),
                        policy_digests: successor.policy_digests.clone(),
                    },
                }),
                state: ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion,
            },
        );
        shard.records.insert(
            target_key,
            ManagedCreateLedgerRecord {
                schema_version: LEDGER_RECORD_SCHEMA_VERSION,
                workspace_id: target.workspace_id().to_string(),
                session_id: target.session_id().to_string(),
                idempotency_key: target.idempotency_key().to_string(),
                request_digest: digest.to_string(),
                conversation_identity: None,
                conversation_writer_released: false,
                canonical_rehost_recipe: None,
                created_unix_ms: unix_time_ms(),
                authority: Some(ManagedCreateLedgerAuthorityV3 {
                    lineage: ManagedCreateLineageAuthorityV3::Predecessor {
                        source: source.clone(),
                        edge_fingerprint,
                    },
                    successor: ManagedCreateSuccessorSlotV3::Vacant,
                }),
                state: ManagedCreateLedgerRecordState::SuccessorLineagePending,
            },
        );
        validate_shard(&shard, source_index).unwrap();
        write_shard(&directory, &shard_path, &shard).unwrap();
    }

    fn publish_legacy_successor_without_chain_bound(
        root: &Path,
        source: &ManagedCreateReconcileRequest,
        target: &ManagedCreateReconcileRequest,
        digest: &str,
    ) -> ManagedCreateSuccessorIdentity {
        let directory = root.join(LEDGER_DIRECTORY);
        let target_key = logical_key(target.workspace_id(), target.session_id());
        let (_, predecessor_path, _) = predecessor_shard_paths(&directory, &target_key).unwrap();
        let mut predecessors: ManagedCreateSuccessorPredecessorShard =
            read_successor_state_or_default(&predecessor_path).unwrap();
        if matches!(
            predecessors
                .records
                .get(&target_key)
                .map(|record| &record.authority),
            Some(ManagedCreateSuccessorPredecessorAuthority::Root { .. })
        ) {
            predecessors.records.remove(&target_key);
            write_successor_shard(&directory, &predecessor_path, &predecessors).unwrap();
        }
        let source_key = logical_key(source.workspace_id(), source.session_id());
        let source_index = shard_index(&source_key).unwrap();
        let successor_path = directory.join(format!("successor_{source_index:02x}.json"));
        let mut successors = read_successor_shard_or_default(&successor_path).unwrap();
        let successor = ManagedCreateSuccessorIdentity::new(
            target.session_id(),
            target.idempotency_key(),
            digest,
        )
        .unwrap();
        successors.records.insert(
            source_key,
            ManagedCreateSuccessorRecord {
                schema_version: SUCCESSOR_LEDGER_SCHEMA_VERSION,
                workspace_id: source.workspace_id().to_string(),
                source_session_id: source.session_id().to_string(),
                source_idempotency_key: source.idempotency_key().to_string(),
                successor: Some(successor.clone()),
                cleanup_closed_unix_ms: None,
                created_unix_ms: unix_time_ms(),
            },
        );
        write_successor_shard(&directory, &successor_path, &successors).unwrap();
        successor
    }

    fn project_predecessor(
        root: &Path,
        source: &ManagedCreateReconcileRequest,
        successor: &ManagedCreateSuccessorIdentity,
    ) {
        reserve_successor_predecessor_projection(&root.join(LEDGER_DIRECTORY), source, successor)
            .unwrap()
            .publish()
            .unwrap();
    }

    fn predecessor_projection_record(
        directory: &Path,
        target: &ManagedCreateReconcileRequest,
    ) -> Option<ManagedCreateSuccessorPredecessorAuthority> {
        let target_key = logical_key(target.workspace_id(), target.session_id());
        let (_, path, _) = predecessor_shard_paths(directory, &target_key).unwrap();
        read_successor_state_or_default::<ManagedCreateSuccessorPredecessorShard>(&path)
            .unwrap()
            .records
            .get(&target_key)
            .map(|record| record.authority.clone())
    }

    fn write_legacy_successor_shard_over_old_record_budget(
        directory: &Path,
        index: usize,
        workspace_id: &str,
    ) -> Vec<(ManagedCreateReconcileRequest, ManagedCreateReconcileRequest)> {
        const OLD_SCAN_RECORD_LIMIT: usize = 128;
        assert!(
            !directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists(),
            "a retained v2 fixture must be written before coverage is complete",
        );
        let mut successor_shard = ManagedCreateSuccessorShard::default();
        let mut create_shard = ManagedCreateLedgerShard {
            schema_version: LEDGER_SHARD_SCHEMA_VERSION_V2,
            records: BTreeMap::new(),
        };
        let mut edges = Vec::new();
        let mut candidate = 0_u32;
        while successor_shard.records.len() <= OLD_SCAN_RECORD_LIMIT {
            let source = ManagedCreateReconcileRequest::new(
                format!("i{candidate}"),
                format!("s{candidate}"),
                workspace_id,
            )
            .unwrap();
            let record_key = logical_key(source.workspace_id(), source.session_id());
            candidate += 1;
            if shard_index(&record_key).unwrap() != index {
                continue;
            }
            let target = ManagedCreateReconcileRequest::new(
                format!("j{candidate}"),
                format!("t{candidate}"),
                workspace_id,
            )
            .unwrap();
            let successor = ManagedCreateSuccessorIdentity::new(
                target.session_id(),
                target.idempotency_key(),
                request_digest(2),
            )
            .unwrap();
            successor_shard.records.insert(
                record_key.clone(),
                ManagedCreateSuccessorRecord {
                    schema_version: SUCCESSOR_LEDGER_SCHEMA_VERSION,
                    workspace_id: source.workspace_id().to_string(),
                    source_session_id: source.session_id().to_string(),
                    source_idempotency_key: source.idempotency_key().to_string(),
                    successor: Some(successor),
                    cleanup_closed_unix_ms: None,
                    created_unix_ms: unix_time_ms(),
                },
            );
            create_shard.records.insert(
                record_key,
                ManagedCreateLedgerRecord {
                    schema_version: LEDGER_RECORD_SCHEMA_VERSION_V2,
                    workspace_id: source.workspace_id().to_string(),
                    session_id: source.session_id().to_string(),
                    idempotency_key: source.idempotency_key().to_string(),
                    request_digest: request_digest(1),
                    conversation_identity: None,
                    conversation_writer_released: false,
                    canonical_rehost_recipe: None,
                    created_unix_ms: unix_time_ms(),
                    authority: None,
                    state: ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion,
                },
            );
            edges.push((source, target));
        }
        write_successor_shard(
            directory,
            &directory.join(format!("successor_{index:02x}.json")),
            &successor_shard,
        )
        .unwrap();
        write_shard(
            directory,
            &directory.join(format!("shard_{index:02x}.json")),
            &create_shard,
        )
        .unwrap();
        edges
    }

    fn write_legacy_target_bucket_over_reverse_capacity(
        directory: &Path,
        workspace_id: &str,
        target_index: usize,
    ) -> (ManagedCreateReconcileRequest, ManagedCreateReconcileRequest) {
        let source_indexes = [0, 1];
        let mut successor_shards = [
            ManagedCreateSuccessorShard::default(),
            ManagedCreateSuccessorShard::default(),
        ];
        let mut first = None;
        let mut source_candidate = 0_u64;
        let mut target_candidate = 0_u64;
        for edge_index in 0..=MAX_SHARD_RECORDS {
            let source_index = source_indexes[edge_index % source_indexes.len()];
            let source = loop {
                let source = ManagedCreateReconcileRequest::new(
                    format!("overflow-source-create-{source_candidate}"),
                    format!("overflow-source-session-{source_candidate}"),
                    workspace_id,
                )
                .unwrap();
                source_candidate += 1;
                if shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap()
                    == source_index
                {
                    break source;
                }
            };
            let target = loop {
                let target = ManagedCreateReconcileRequest::new(
                    format!("overflow-target-create-{target_candidate}"),
                    format!("overflow-target-session-{target_candidate}"),
                    workspace_id,
                )
                .unwrap();
                target_candidate += 1;
                if shard_index(&logical_key(target.workspace_id(), target.session_id())).unwrap()
                    == target_index
                {
                    break target;
                }
            };
            let successor = ManagedCreateSuccessorIdentity::new(
                target.session_id(),
                target.idempotency_key(),
                request_digest(2),
            )
            .unwrap();
            successor_shards[edge_index % source_indexes.len()]
                .records
                .insert(
                    logical_key(source.workspace_id(), source.session_id()),
                    ManagedCreateSuccessorRecord {
                        schema_version: SUCCESSOR_LEDGER_SCHEMA_VERSION,
                        workspace_id: source.workspace_id().to_string(),
                        source_session_id: source.session_id().to_string(),
                        source_idempotency_key: source.idempotency_key().to_string(),
                        successor: Some(successor),
                        cleanup_closed_unix_ms: None,
                        created_unix_ms: unix_time_ms(),
                    },
                );
            if first.is_none() {
                first = Some((source, target));
            }
        }
        for (slot, source_index) in source_indexes.into_iter().enumerate() {
            write_successor_shard(
                directory,
                &directory.join(format!("successor_{source_index:02x}.json")),
                &successor_shards[slot],
            )
            .unwrap();
        }
        first.unwrap()
    }

    fn write_legacy_edge_in_every_source_shard_for_one_target_bucket(
        directory: &Path,
        workspace_id: &str,
        target_index: usize,
        selected_source_index: usize,
    ) -> (ManagedCreateReconcileRequest, ManagedCreateReconcileRequest) {
        let mut selected = None;
        let mut source_candidate = 0_u64;
        let mut target_candidate = 0_u64;
        for source_index in 0..LEDGER_SHARDS {
            let source = loop {
                let source = ManagedCreateReconcileRequest::new(
                    format!("dense-source-create-{source_candidate}"),
                    format!("dense-source-session-{source_candidate}"),
                    workspace_id,
                )
                .unwrap();
                source_candidate += 1;
                if shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap()
                    == source_index
                {
                    break source;
                }
            };
            let target = loop {
                let target = ManagedCreateReconcileRequest::new(
                    format!("dense-target-create-{target_candidate}"),
                    format!("dense-target-session-{target_candidate}"),
                    workspace_id,
                )
                .unwrap();
                target_candidate += 1;
                if shard_index(&logical_key(target.workspace_id(), target.session_id())).unwrap()
                    == target_index
                {
                    break target;
                }
            };
            let successor = ManagedCreateSuccessorIdentity::new(
                target.session_id(),
                target.idempotency_key(),
                request_digest(2),
            )
            .unwrap();
            let mut shard = ManagedCreateSuccessorShard::default();
            shard.records.insert(
                logical_key(source.workspace_id(), source.session_id()),
                ManagedCreateSuccessorRecord {
                    schema_version: SUCCESSOR_LEDGER_SCHEMA_VERSION,
                    workspace_id: source.workspace_id().to_string(),
                    source_session_id: source.session_id().to_string(),
                    source_idempotency_key: source.idempotency_key().to_string(),
                    successor: Some(successor),
                    cleanup_closed_unix_ms: None,
                    created_unix_ms: unix_time_ms(),
                },
            );
            write_successor_shard(
                directory,
                &directory.join(format!("successor_{source_index:02x}.json")),
                &shard,
            )
            .unwrap();
            if source_index == selected_source_index {
                selected = Some((source, target));
            }
        }
        selected.unwrap()
    }

    fn write_successor_shard_one_slot_from_capacity(
        directory: &Path,
        index: usize,
        workspace_id: &str,
        excluded_session_ids: &[&str],
    ) {
        let mut shard = ManagedCreateSuccessorShard::default();
        let mut candidate = 0_u32;
        while shard.records.len() < MAX_SHARD_RECORDS - 1 {
            let source = ManagedCreateReconcileRequest::new(
                format!("capacity-create-{candidate}"),
                format!("capacity-session-{candidate}"),
                workspace_id,
            )
            .unwrap();
            candidate += 1;
            if excluded_session_ids.contains(&source.session_id()) {
                continue;
            }
            let record_key = logical_key(source.workspace_id(), source.session_id());
            if shard_index(&record_key).unwrap() != index {
                continue;
            }
            let successor = ManagedCreateSuccessorIdentity::new(
                format!("capacity-target-session-{candidate}"),
                format!("capacity-target-create-{candidate}"),
                request_digest(7),
            )
            .unwrap();
            shard.records.insert(
                record_key,
                ManagedCreateSuccessorRecord {
                    schema_version: SUCCESSOR_LEDGER_SCHEMA_VERSION,
                    workspace_id: source.workspace_id().to_string(),
                    source_session_id: source.session_id().to_string(),
                    source_idempotency_key: source.idempotency_key().to_string(),
                    successor: Some(successor),
                    cleanup_closed_unix_ms: None,
                    created_unix_ms: unix_time_ms(),
                },
            );
        }
        write_successor_shard(
            directory,
            &directory.join(format!("successor_{index:02x}.json")),
            &shard,
        )
        .unwrap();
    }

    fn identity_in_shard(
        workspace_id: &str,
        index: usize,
        prefix: &str,
    ) -> ManagedCreateReconcileRequest {
        (0_u32..)
            .map(|candidate| {
                ManagedCreateReconcileRequest::new(
                    format!("{prefix}-create-{candidate}"),
                    format!("{prefix}-session-{candidate}"),
                    workspace_id,
                )
                .unwrap()
            })
            .find(|identity| {
                shard_index(&logical_key(identity.workspace_id(), identity.session_id())).unwrap()
                    == index
            })
            .unwrap()
    }

    fn successor_in_source_shard(
        source: &ManagedCreateReconcileRequest,
        prefix: &str,
        digest: &str,
    ) -> ManagedCreateSuccessorIdentity {
        let index = shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap();
        let target = identity_in_shard(source.workspace_id(), index, prefix);
        successor_for_target(&target, digest)
    }

    fn successor_for_target(
        target: &ManagedCreateReconcileRequest,
        digest: &str,
    ) -> ManagedCreateSuccessorIdentity {
        ManagedCreateSuccessorIdentity::with_policy_digests(
            target.session_id(),
            target.idempotency_key(),
            digest,
            digest,
            None,
        )
        .unwrap()
    }

    struct ConversationSuccessorFixture {
        conversation: ProviderConversationIdentitySeed,
        source: ManagedCreateReconcileRequest,
        target: ManagedCreateSuccessorIdentity,
        source_index: usize,
    }

    fn abandoned_conversation_successor_fixture(
        root: &Path,
        workspace_id: &str,
        conversation_id: &str,
        target_prefix: &str,
    ) -> ConversationSuccessorFixture {
        let conversation =
            ProviderConversationIdentitySeed::new("fixture", conversation_id).unwrap();
        let source = ManagedCreateReconcileRequest::new(
            "create-conversation-source",
            "session-conversation-source",
            workspace_id,
        )
        .unwrap();
        let ManagedCreateLedgerState::Prepared(mut reservation) =
            reserve_with_rehost_recipe_and_conversation(
                root,
                source.workspace_id(),
                source.session_id(),
                source.idempotency_key(),
                &request_digest(1),
                None,
                Some(&conversation),
            )
            .unwrap()
        else {
            panic!("source must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.abandon_before_completion().unwrap();
        let source_index =
            shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap();
        let target_identity = identity_in_shard(workspace_id, source_index, target_prefix);
        let target = ManagedCreateSuccessorIdentity::with_target_policy(
            target_identity.session_id(),
            target_identity.idempotency_key(),
            request_digest(2),
            request_digest(2),
            None,
            None,
            Some(conversation.clone()),
        )
        .unwrap();
        ConversationSuccessorFixture {
            conversation,
            source,
            target,
            source_index,
        }
    }

    fn fill_create_shard_to_capacity(root: &Path, index: usize, workspace_id: &str) {
        let directory = root.join(LEDGER_DIRECTORY);
        let shard_path = directory.join(format!("shard_{index:02x}.json"));
        let mut shard = read_shard_or_default(&shard_path).unwrap();
        let mut candidate = 0_u32;
        while shard.records.len() < MAX_SHARD_RECORDS {
            let identity = ManagedCreateReconcileRequest::new(
                format!("full-create-{candidate}"),
                format!("full-session-{candidate}"),
                workspace_id,
            )
            .unwrap();
            candidate += 1;
            let record_key = logical_key(identity.workspace_id(), identity.session_id());
            if shard_index(&record_key).unwrap() != index || shard.records.contains_key(&record_key)
            {
                continue;
            }
            shard.records.insert(
                record_key,
                ManagedCreateLedgerRecord {
                    schema_version: LEDGER_RECORD_SCHEMA_VERSION_V2,
                    workspace_id: identity.workspace_id().to_string(),
                    session_id: identity.session_id().to_string(),
                    idempotency_key: identity.idempotency_key().to_string(),
                    request_digest: request_digest(0x7f),
                    conversation_identity: None,
                    conversation_writer_released: false,
                    canonical_rehost_recipe: None,
                    created_unix_ms: unix_time_ms(),
                    authority: None,
                    state: ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission,
                },
            );
        }
        write_shard(&directory, &shard_path, &shard).unwrap();
    }

    fn fill_predecessor_shard_one_slot_from_capacity(
        root: &Path,
        index: usize,
        workspace_id: &str,
    ) {
        let directory = root.join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        let shard_path = directory.join(format!("successor_predecessor_{index:02x}.json"));
        let mut shard = ManagedCreateSuccessorPredecessorShard::default();
        let mut candidate = 0_u32;
        while shard.records.len() < MAX_SHARD_RECORDS - 1 {
            let identity = ManagedCreateReconcileRequest::new(
                format!("predecessor-capacity-create-{candidate}"),
                format!("predecessor-capacity-session-{candidate}"),
                workspace_id,
            )
            .unwrap();
            candidate += 1;
            let record_key = logical_key(identity.workspace_id(), identity.session_id());
            if shard_index(&record_key).unwrap() != index {
                continue;
            }
            shard.records.insert(
                record_key,
                ManagedCreateSuccessorPredecessorRecord {
                    schema_version: SUCCESSOR_PREDECESSOR_LEDGER_SCHEMA_VERSION,
                    workspace_id: identity.workspace_id().to_string(),
                    target_session_id: identity.session_id().to_string(),
                    target_idempotency_key: identity.idempotency_key().to_string(),
                    authority: ManagedCreateSuccessorPredecessorAuthority::Root {
                        create_fingerprint: request_digest(0x6f),
                        legacy_predecessor_absence_proven: true,
                    },
                    created_unix_ms: unix_time_ms(),
                },
            );
        }
        write_successor_shard(&directory, &shard_path, &shard).unwrap();
    }

    fn complete_and_retire_generation(
        root: &Path,
        identity: &ManagedCreateReconcileRequest,
        digest: &str,
        seed: u32,
        lineage: ManagedCreateLineageAdmission,
    ) -> ManagedStopReceipt {
        let ManagedCreateLedgerState::Prepared(mut reservation) = reserve_with_lineage_admission(
            root,
            identity.workspace_id(),
            identity.session_id(),
            identity.idempotency_key(),
            digest,
            ManagedCreateLineageContext {
                canonical_rehost_recipe: None,
                conversation_identity: None,
                admission: lineage,
            },
        )
        .unwrap() else {
            panic!("generation must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation
            .mark_spawn_reserved(process(1_000 + seed))
            .unwrap();
        reservation.release_with_barrier_proof().unwrap();
        let runner_principal = format!("principal-{seed}");
        let runner_instance = format!("runner-{seed}");
        let host_instance = format!("host-{seed}");
        let terminal_epoch = format!("terminal-{seed}");
        let create = ManagedCreateReceipt::new(
            identity.idempotency_key(),
            identity.session_id(),
            identity.workspace_id(),
            "codex",
            PermissionMode::Default,
            root,
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new(
                &runner_principal,
                &runner_instance,
                u64::from(seed),
                &host_instance,
                &terminal_epoch,
            )
            .unwrap(),
        )
        .unwrap();
        reservation
            .complete(serde_json::to_string(&create).unwrap())
            .unwrap();
        let stop = hmux_runtime_contract::ManagedStopRequest::new(
            format!("stop-{seed}"),
            identity.session_id(),
            identity.workspace_id(),
        )
        .unwrap()
        .with_expected_fence(
            &runner_principal,
            &runner_instance,
            u64::from(seed),
            &host_instance,
            &terminal_epoch,
        )
        .unwrap();
        let receipt = ManagedStopReceipt::from_request(
            &stop,
            ManagedStopOutcome::Stopped,
            "managed_provider_stopped",
        )
        .unwrap();
        checkpoint_retirement_exact(root, &receipt).unwrap();
        finalize_retirement_exact(root, &receipt).unwrap();
        receipt
    }

    #[test]
    fn terminal_source_reserves_one_successor_across_concurrent_callers() {
        let root = secure_root();
        let ManagedCreateLedgerState::Prepared(mut source) = reserve(
            root.path(),
            "workspace-successor",
            "session-source",
            "create-source",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("source must be prepared")
        };
        source.checkpoint_pre_spawn_absence().unwrap();
        source.abandon_before_completion().unwrap();
        drop(source);

        let start = Arc::new(Barrier::new(9));
        let allocations = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        for index in 0..8 {
            let root = root.path().to_path_buf();
            let start = Arc::clone(&start);
            let allocations = Arc::clone(&allocations);
            workers.push(thread::spawn(move || {
                let source = ManagedCreateReconcileRequest::new(
                    "create-source",
                    "session-source",
                    "workspace-successor",
                )
                .unwrap();
                start.wait();
                reserve_terminal_successor(&root, &source, || {
                    allocations.fetch_add(1, Ordering::SeqCst);
                    Ok(successor_in_source_shard(
                        &source,
                        &format!("successor-{index}"),
                        &request_digest((index + 2) as u8),
                    ))
                })
                .unwrap()
            }));
        }
        start.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(allocations.load(Ordering::SeqCst), 1);
        let created = results
            .iter()
            .filter_map(|result| match result {
                ManagedCreateSuccessorLedgerState::Created(successor) => Some(successor),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(created.len(), 1);
        let successor = created[0];
        assert!(results.iter().all(|result| match result {
            ManagedCreateSuccessorLedgerState::Created(candidate)
            | ManagedCreateSuccessorLedgerState::Existing(candidate) => candidate == successor,
            ManagedCreateSuccessorLedgerState::ExistingUnavailable { .. }
            | ManagedCreateSuccessorLedgerState::NotFound
            | ManagedCreateSuccessorLedgerState::Pending
            | ManagedCreateSuccessorLedgerState::Closed => false,
        }));
        assert!(matches!(
            reserve(
                root.path(),
                "workspace-successor",
                "session-source",
                "create-source",
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::Retired
        ));
        let source = ManagedCreateReconcileRequest::new(
            "create-source",
            "session-source",
            "workspace-successor",
        )
        .unwrap();
        assert_eq!(
            reserve_terminal_successor(root.path(), &source, || {
                panic!("an ordinary legacy ledger retry must not erase the sibling successor")
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Existing(successor.clone())
        );
        assert!(matches!(
            successor
                .ensure_request_policy_digests(&request_digest(99), &request_digest(99), None,),
            Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict)
        ));
    }

    #[test]
    fn legacy_successor_v1_replays_after_digest_domain_upgrade() {
        let root = secure_root();
        let source = ManagedCreateReconcileRequest::new(
            "create-source",
            "session-source",
            "workspace-successor-legacy",
        )
        .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));

        let target = ManagedCreateReconcileRequest::new(
            "create-target",
            "session-target",
            source.workspace_id(),
        )
        .unwrap();
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target,
            &request_digest(2),
        );

        let directory = root.path().join(LEDGER_DIRECTORY);
        let key = logical_key(source.workspace_id(), source.session_id());
        let successor_path =
            directory.join(format!("successor_{:02x}.json", shard_index(&key).unwrap()));
        let shard: serde_json::Value =
            serde_json::from_slice(&fs::read(&successor_path).unwrap()).unwrap();
        let durable = shard["records"][&key]["successor"].as_object().unwrap();
        assert!(durable.contains_key("requestDigest"));
        assert!(!durable.contains_key("canonicalRequestDigest"));
        assert!(!durable.contains_key("rehostRecipeDigest"));

        let replayed = reserve_terminal_successor(root.path(), &source, || {
            panic!("a retained v1 edge must replay without allocating another successor")
        })
        .unwrap();
        let ManagedCreateSuccessorLedgerState::Existing(replayed) = replayed else {
            panic!("the retained v1 edge must remain the successor")
        };
        assert_eq!(replayed.session_id(), "session-target");
        assert_eq!(replayed.idempotency_key(), "create-target");
    }

    #[test]
    fn exact_retry_backfills_split_digests_for_a_retained_v1_edge() {
        let root = secure_root();
        let source = ManagedCreateReconcileRequest::new(
            "create-source",
            "session-source",
            "workspace-successor-backfill",
        )
        .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));

        let legacy = request_digest(2);
        let canonical = request_digest(3);
        let recipe = request_digest(4);
        let target = ManagedCreateReconcileRequest::new(
            "create-target",
            "session-target",
            source.workspace_id(),
        )
        .unwrap();
        let created =
            publish_legacy_successor_without_chain_bound(root.path(), &source, &target, &legacy);
        created
            .ensure_request_policy_digests(&legacy, &canonical, Some(&recipe))
            .unwrap();

        ensure_successor_digest_projection(
            root.path(),
            &source,
            &created,
            &canonical,
            Some(&recipe),
        )
        .unwrap();
        let ManagedCreateSuccessorLedgerState::Existing(projected) =
            reserve_terminal_successor(root.path(), &source, || {
                panic!("projection backfill must not allocate a new edge")
            })
            .unwrap()
        else {
            panic!("the projected edge must replay")
        };
        projected
            .ensure_request_policy_digests(&legacy, &canonical, Some(&recipe))
            .unwrap();
        assert!(matches!(
            projected.ensure_request_policy_digests(&legacy, &request_digest(5), Some(&recipe),),
            Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict)
        ));
        assert!(matches!(
            projected.ensure_request_policy_digests(&legacy, &canonical, Some(&request_digest(6)),),
            Err(ManagedCreateAdmissionError::SuccessorRequestDigestConflict)
        ));
    }

    #[test]
    fn reverse_snapshot_accepts_edge_then_digest_writer_interleaving() {
        let root = secure_root();
        let source = ManagedCreateReconcileRequest::new(
            "create-source",
            "session-source",
            "workspace-successor-snapshot",
        )
        .unwrap();
        let target = ManagedCreateReconcileRequest::new(
            "create-target",
            "session-target",
            source.workspace_id(),
        )
        .unwrap();
        abandon_generation(root.path(), &source, &request_digest(1));

        let directory = root.path().join(LEDGER_DIRECTORY);
        let record_key = logical_key(source.workspace_id(), source.session_id());
        let index = shard_index(&record_key).unwrap();
        let successor_path = directory.join(format!("successor_{index:02x}.json"));
        let successor_digest_path = directory.join(format!("successor_digest_{index:02x}.json"));
        let successor = ManagedCreateSuccessorIdentity::with_policy_digests(
            target.session_id(),
            target.idempotency_key(),
            request_digest(2),
            request_digest(3),
            None,
        )
        .unwrap();

        let (successors, digest_snapshot) =
            read_successor_topology_snapshot_with_interleave(&directory, index, || {
                let mut successors = ManagedCreateSuccessorShard::default();
                successors.records.insert(
                    record_key.clone(),
                    ManagedCreateSuccessorRecord {
                        schema_version: SUCCESSOR_LEDGER_SCHEMA_VERSION,
                        workspace_id: source.workspace_id().to_string(),
                        source_session_id: source.session_id().to_string(),
                        source_idempotency_key: source.idempotency_key().to_string(),
                        successor: Some(successor.clone()),
                        cleanup_closed_unix_ms: None,
                        created_unix_ms: unix_time_ms(),
                    },
                );
                write_successor_shard(&directory, &successor_path, &successors).unwrap();

                let mut digests = ManagedCreateSuccessorDigestShard::default();
                digests.records.insert(
                    record_key.clone(),
                    successor_digest_record(&source, &successor)
                        .unwrap()
                        .unwrap(),
                );
                write_successor_shard(&directory, &successor_digest_path, &digests).unwrap();
            })
            .unwrap();

        assert!(successors.records.contains_key(&record_key));
        assert!(
            digest_snapshot.records.is_empty(),
            "the unlocked snapshot must retain the older optional digest view",
        );
    }

    #[test]
    fn successor_chain_read_distinguishes_absent_pending_and_terminal_without_allocating() {
        let root = secure_root();
        let unknown = ManagedCreateReconcileRequest::new(
            "create-unknown",
            "session-unknown",
            "workspace-successor-read",
        )
        .unwrap();
        assert_eq!(
            resolve_successor_chain(root.path(), &unknown).unwrap(),
            ManagedCreateSuccessorChainResolution::NotFound,
        );

        let source = ManagedCreateReconcileRequest::new(
            "create-source",
            "session-source",
            "workspace-successor-read",
        )
        .unwrap();
        let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
            root.path(),
            source.workspace_id(),
            source.session_id(),
            source.idempotency_key(),
            &request_digest(1),
        )
        .unwrap() else {
            panic!("source must be prepared")
        };
        assert_eq!(
            resolve_successor_chain(root.path(), &source).unwrap(),
            ManagedCreateSuccessorChainResolution::Pending {
                chain: successor_chain(vec![source.clone()]),
            },
        );
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.abandon_before_completion().unwrap();
        assert_eq!(
            resolve_successor_chain(root.path(), &source).unwrap(),
            ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                chain: successor_chain(vec![source.clone()]),
                stop_receipt: None,
            },
        );

        let allocations = AtomicUsize::new(0);
        assert_eq!(allocations.load(Ordering::SeqCst), 0);
        let target = successor_in_source_shard(&source, "read-target", &request_digest(2));
        assert!(matches!(
            reserve_terminal_successor(root.path(), &source, || {
                allocations.fetch_add(1, Ordering::SeqCst);
                Ok(target.clone())
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Created(_),
        ));
        assert_eq!(allocations.load(Ordering::SeqCst), 1);
        assert!(matches!(
            resolve_successor_chain(root.path(), &source).unwrap(),
            ManagedCreateSuccessorChainResolution::Pending { chain }
                if chain.identities().len() == 2
                    && chain.identities()[0] == source
                    && chain.identities()[1].session_id() == target.session_id()
        ));
    }

    #[test]
    fn unborn_cleanup_is_one_authority_for_create_and_successor_admission() {
        let root = secure_root();
        let source = ManagedCreateReconcileRequest::new(
            "create-source",
            "session-source",
            "workspace-unborn-cleanup",
        )
        .unwrap();
        let ManagedCreateLedgerState::Prepared(mut source_reservation) = reserve(
            root.path(),
            source.workspace_id(),
            source.session_id(),
            source.idempotency_key(),
            &request_digest(1),
        )
        .unwrap() else {
            panic!("source must be prepared")
        };
        source_reservation.checkpoint_pre_spawn_absence().unwrap();
        source_reservation.abandon_before_completion().unwrap();

        let legacy_digest = request_digest(2);
        let canonical_digest = request_digest(3);
        let target_identity = identity_in_shard(
            source.workspace_id(),
            shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap(),
            "unborn-target",
        );
        let allocated = ManagedCreateSuccessorIdentity::with_policy_digests(
            target_identity.session_id(),
            target_identity.idempotency_key(),
            &legacy_digest,
            &canonical_digest,
            None,
        )
        .unwrap();
        let ManagedCreateSuccessorLedgerState::Created(expected) =
            reserve_terminal_successor(root.path(), &source, || Ok(allocated.clone())).unwrap()
        else {
            panic!("source must publish one unborn successor")
        };
        let target = ManagedCreateReconcileRequest::new(
            expected.idempotency_key(),
            expected.session_id(),
            source.workspace_id(),
        )
        .unwrap();
        assert!(matches!(
            resolve_successor_chain(root.path(), &source).unwrap(),
            ManagedCreateSuccessorChainResolution::Pending { .. }
        ));

        claim_unborn_successor_cleanup(root.path(), &target, &expected).unwrap();
        ensure_successor_digest_projection(
            root.path(),
            &source,
            &expected,
            &canonical_digest,
            None,
        )
        .unwrap();
        assert_eq!(
            resolve_successor_chain(root.path(), &source).unwrap(),
            ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                chain: successor_chain(vec![source.clone(), target.clone()]),
                stop_receipt: None,
            },
            "split-policy projection must not reopen a cleanup-closed target",
        );

        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &canonical_digest,
                None,
                None,
            )
            .unwrap(),
            ManagedCreateLedgerState::Retired
        ));
        let allocations = AtomicUsize::new(0);
        assert_eq!(
            reserve_terminal_successor(root.path(), &target, || {
                allocations.fetch_add(1, Ordering::SeqCst);
                ManagedCreateSuccessorIdentity::new(
                    "session-never",
                    "create-never",
                    request_digest(5),
                )
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Closed,
        );
        assert_eq!(allocations.load(Ordering::SeqCst), 0);

        let target_key = logical_key(target.workspace_id(), target.session_id());
        let target_index = shard_index(&target_key).unwrap();
        let target_successors = read_successor_shard_or_default(
            &root
                .path()
                .join(LEDGER_DIRECTORY)
                .join(format!("successor_{target_index:02x}.json")),
        )
        .unwrap();
        assert!(
            !target_successors.records.contains_key(&target_key),
            "the create tombstone itself must be the only unborn cleanup authority",
        );
    }

    #[test]
    fn pending_cleanup_fences_stale_launch_then_converges() {
        let root = secure_root();
        let request = ManagedCreateReconcileRequest::new(
            "create-pending",
            "session-pending",
            "workspace-pending-cleanup",
        )
        .unwrap();
        let ManagedCreateLedgerState::Prepared(mut stale_creator) = reserve(
            root.path(),
            request.workspace_id(),
            request.session_id(),
            request.idempotency_key(),
            &request_digest(1),
        )
        .unwrap() else {
            panic!("target must be prepared")
        };
        stale_creator.checkpoint_pre_spawn_absence().unwrap();

        assert_eq!(
            claim_successor_chain_cleanup(root.path(), &request).unwrap(),
            ManagedCreateSuccessorChainResolution::Pending {
                chain: successor_chain(vec![request.clone()]),
            },
        );
        let record_key = logical_key(request.workspace_id(), request.session_id());
        let index = shard_index(&record_key).unwrap();
        let shard_path = root
            .path()
            .join(LEDGER_DIRECTORY)
            .join(format!("shard_{index:02x}.json"));
        assert!(
            !legacy_v2_writer_accepts_shard(&fs::read(&shard_path).unwrap()),
            "a rolling v2 writer must reject the v3 cleanup authority",
        );
        let successor_path = root
            .path()
            .join(LEDGER_DIRECTORY)
            .join(format!("successor_{index:02x}.json"));
        assert!(
            !private_path_exists(&successor_path).unwrap(),
            "v3 cleanup must not publish a sibling successor authority",
        );
        assert!(matches!(
            ledger_record(root.path(), &request)
                .authority
                .unwrap()
                .successor,
            ManagedCreateSuccessorSlotV3::Closed { .. }
        ));
        assert!(matches!(
            reserve(
                root.path(),
                request.workspace_id(),
                request.session_id(),
                request.idempotency_key(),
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::Retired
        ));
        let allocations = AtomicUsize::new(0);
        assert_eq!(
            reserve_terminal_successor(root.path(), &request, || {
                allocations.fetch_add(1, Ordering::SeqCst);
                ManagedCreateSuccessorIdentity::new(
                    "session-never",
                    "create-never",
                    request_digest(2),
                )
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Closed,
        );
        assert_eq!(allocations.load(Ordering::SeqCst), 0);
        let launch_error = stale_creator.mark_spawn_reserved(process(101)).unwrap_err();
        assert!(
            launch_error.contains("hmux_managed_create_retired_exact"),
            "cleanup must fence the first launch effect: {launch_error}",
        );

        let ManagedCreateReconcileLedgerState::PreSpawnAbsenceCheckpointed(mut recovery) =
            reconcile_identity(root.path(), &request).unwrap()
        else {
            panic!("the cleanup-fenced reservation must remain recoverable")
        };
        recovery.abandon_before_completion().unwrap();
        assert_eq!(
            ledger_record(root.path(), &request).schema_version,
            LEDGER_RECORD_SCHEMA_VERSION,
        );
        assert_eq!(
            claim_successor_chain_cleanup(root.path(), &request).unwrap(),
            ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                chain: successor_chain(vec![request]),
                stop_receipt: None,
            },
        );
    }

    #[test]
    fn pending_cleanup_fences_a_rolling_v2_writer() {
        let root = secure_root();
        let request = ManagedCreateReconcileRequest::new(
            "create-pending",
            "session-pending",
            "workspace-pending-closure-upgrade",
        )
        .unwrap();
        assert!(matches!(
            reserve(
                root.path(),
                request.workspace_id(),
                request.session_id(),
                request.idempotency_key(),
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
        let ManagedCreateSuccessorInspection::Found {
            source: ManagedCreateSuccessorSourceState::Pending,
            slot: ManagedCreateSuccessorSlot::Vacant(reservation),
            ..
        } = inspect_successor_node(root.path(), &request, None).unwrap()
        else {
            panic!("the legacy pending source must expose a vacant successor slot")
        };
        close_successor_slot(*reservation, &request).unwrap();

        assert!(matches!(
            claim_successor_chain_cleanup(root.path(), &request).unwrap(),
            ManagedCreateSuccessorChainResolution::Pending { .. }
        ));
        let record = ledger_record(root.path(), &request);
        assert_eq!(record.schema_version, LEDGER_RECORD_SCHEMA_VERSION);
        let record_key = logical_key(request.workspace_id(), request.session_id());
        let index = shard_index(&record_key).unwrap();
        let shard_path = root
            .path()
            .join(LEDGER_DIRECTORY)
            .join(format!("shard_{index:02x}.json"));
        assert!(!legacy_v2_writer_accepts_shard(
            &fs::read(shard_path).unwrap()
        ));
    }

    #[test]
    fn successor_resolution_recovers_oldest_ancestor_and_prior_stop_receipts() {
        let root = secure_root();
        let workspace_id = "workspace-ancestor-chain";
        let ancestor =
            ManagedCreateReconcileRequest::new("create-a", "session-a", workspace_id).unwrap();
        let ancestor_index =
            shard_index(&logical_key(ancestor.workspace_id(), ancestor.session_id())).unwrap();
        let requested = identity_in_shard(workspace_id, ancestor_index, "ancestor-b");
        let effective = identity_in_shard(workspace_id, ancestor_index, "ancestor-c");
        let digest_a = request_digest(1);
        let digest_b = request_digest(2);
        let digest_c = request_digest(3);

        let stop_a = complete_and_retire_generation(
            root.path(),
            &ancestor,
            &digest_a,
            1,
            ManagedCreateLineageAdmission::Root,
        );
        assert!(matches!(
            reserve_terminal_successor(root.path(), &ancestor, || {
                Ok(successor_for_target(&requested, &digest_b))
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Created(_)
        ));
        let stop_b = complete_and_retire_generation(
            root.path(),
            &requested,
            &digest_b,
            2,
            ManagedCreateLineageAdmission::Successor,
        );
        assert!(matches!(
            reserve_terminal_successor(root.path(), &requested, || {
                Ok(successor_for_target(&effective, &digest_c))
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Created(_)
        ));
        assert!(matches!(
            reserve_successor_with_rehost_recipe_and_conversation(
                root.path(),
                effective.workspace_id(),
                effective.session_id(),
                effective.idempotency_key(),
                &digest_c,
                None,
                None,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));

        let ManagedCreateSuccessorChainResolution::Pending { chain } =
            claim_successor_chain_cleanup(root.path(), &requested).unwrap()
        else {
            panic!("the requested successor must resolve through its pending tail")
        };
        assert_eq!(
            chain.identities(),
            &[ancestor.clone(), requested, effective.clone()],
            "a stop requested at B must recover the immutable A -> B ancestry",
        );
        assert_eq!(chain.effective(), &effective);
        assert_eq!(chain.prior_stop_receipts(), &[stop_a, stop_b]);
    }

    #[test]
    fn predecessor_coverage_retries_after_a_partial_locator_scan() {
        let root = secure_root();
        let workspace_id = "workspace-predecessor-coverage-retry";
        let digest = request_digest(1);
        let first_source = identity_in_shard(workspace_id, 0, "coverage-source-a");
        let first_target =
            ManagedCreateReconcileRequest::new("create-b", "session-b", workspace_id).unwrap();
        abandon_legacy_generation(root.path(), &first_source, &digest);
        let second_source = identity_in_shard(workspace_id, 1, "coverage-source-b");
        let second_target =
            ManagedCreateReconcileRequest::new("create-d", "session-d", workspace_id).unwrap();
        abandon_legacy_generation(root.path(), &second_source, &digest);
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &first_source,
            &first_target,
            &digest,
        );
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &second_source,
            &second_target,
            &digest,
        );

        let directory = root.path().join(LEDGER_DIRECTORY);
        let error = ensure_successor_predecessor_coverage_with_interleave(&directory, |index| {
            if index == 0 {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "injected predecessor coverage crash".to_string(),
                ));
            }
            Ok(())
        })
        .unwrap_err()
        .to_string();
        assert_eq!(error, "injected predecessor coverage crash");
        assert!(!directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists());
        let first_target_index = shard_index(&logical_key(
            first_target.workspace_id(),
            first_target.session_id(),
        ))
        .unwrap();
        assert!(
            !predecessor_locator::shard_path(&directory, first_target_index).exists(),
            "an interrupted forward scan must not publish a partial locator shard",
        );
        assert!(predecessor_projection_record(&directory, &first_target).is_none());
        assert!(predecessor_projection_record(&directory, &second_target).is_none());

        ensure_successor_predecessor_coverage(&directory).unwrap();
        assert!(directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists());
        assert_eq!(
            oldest_successor_ancestor(root.path(), &first_target).unwrap(),
            (first_source, 2),
        );
        assert_eq!(
            oldest_successor_ancestor(root.path(), &second_target).unwrap(),
            (second_source.clone(), 2),
            "a retry must finish every retained forward shard before publishing coverage",
        );
        assert!(matches!(
            predecessor_projection(root.path(), &second_target).unwrap(),
            ManagedCreateSuccessorPredecessorProjection::Predecessor(predecessor)
                if predecessor == second_source
        ));
        assert!(predecessor_projection_record(&directory, &first_target).is_none());
        assert!(predecessor_projection_record(&directory, &second_target).is_none());
    }

    #[test]
    fn predecessor_coverage_accepts_a_retained_quiescent_rehost_recipe() {
        let root = secure_root();
        let identity = identity_in_shard("workspace-quiescent-recipe", 2, "quiescent-recipe");
        write_retained_v2_generation(
            root.path(),
            &identity,
            &request_digest(1),
            ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion,
        );
        let create = ManagedCreateRequest::new(
            identity.idempotency_key(),
            identity.session_id(),
            identity.workspace_id(),
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
        .unwrap()
        .with_managed_rehost_recipe(
            ManagedRehostRecipe::new(
                vec![
                    "codex".into(),
                    "resume".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                None,
            )
            .unwrap(),
        )
        .unwrap();
        let source = ManagedRehostSourceRecipe::from_create_request(&create)
            .unwrap()
            .unwrap();
        let mut persisted = serde_json::to_value(source).unwrap();
        persisted["requiredManagedStopRequestVersion"] =
            MANAGED_STOP_QUIESCENT_REQUEST_VERSION.into();

        let directory = root.path().join(LEDGER_DIRECTORY);
        let record_key = logical_key(identity.workspace_id(), identity.session_id());
        let (_, shard_path) = shard_paths(&directory, &record_key).unwrap();
        let mut shard = read_shard_or_default(&shard_path).unwrap();
        shard
            .records
            .get_mut(&record_key)
            .unwrap()
            .canonical_rehost_recipe = Some(serde_json::to_string(&persisted).unwrap());
        write_shard(&directory, &shard_path, &shard).unwrap();

        ensure_successor_predecessor_coverage(&directory).unwrap();

        let upgraded = read_shard_or_default(&shard_path).unwrap();
        assert_eq!(upgraded.schema_version, LEDGER_SHARD_SCHEMA_VERSION);
        assert!(directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists());
    }

    #[test]
    fn predecessor_coverage_retries_after_locator_publish_before_receipt() {
        let root = secure_root();
        let workspace_id = "workspace-predecessor-locator-publish-retry";
        let source = identity_in_shard(workspace_id, 7, "locator-publish-source");
        let target = ManagedCreateReconcileRequest::new(
            "locator-publish-target-create",
            "locator-publish-target-session",
            workspace_id,
        )
        .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target,
            &request_digest(2),
        );
        let directory = root.path().join(LEDGER_DIRECTORY);

        let error = ensure_successor_predecessor_coverage_with_interleave(&directory, |index| {
            if index == LEDGER_SHARDS {
                return Err(ManagedCreateAdmissionError::Ledger(
                    "injected crash after predecessor locator publish".to_string(),
                ));
            }
            Ok(())
        })
        .unwrap_err()
        .to_string();

        assert_eq!(error, "injected crash after predecessor locator publish");
        let target_index =
            shard_index(&logical_key(target.workspace_id(), target.session_id())).unwrap();
        let locator_path = predecessor_locator::shard_path(&directory, target_index);
        assert!(locator_path.exists());
        assert!(!directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists());
        let interrupted_locator = fs::read(&locator_path).unwrap();

        let coverage = ensure_successor_predecessor_coverage(&directory).unwrap();

        assert!(directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists());
        assert_eq!(fs::read(locator_path).unwrap(), interrupted_locator);
        assert_eq!(
            scan_frozen_legacy_predecessor(&directory, &coverage, &target).unwrap(),
            Some(source),
            "retry must converge on the same immutable locator before publishing coverage",
        );
    }

    #[test]
    fn unknown_predecessor_coverage_schema_blocks_create_without_mutation() {
        let root = secure_root();
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        write_successor_shard(
            &directory,
            &directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE),
            &ManagedCreateSuccessorPredecessorCoverageReceipt {
                schema_version: SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION + 1,
                legacy_source_shards_by_target: Vec::new(),
                locator_shards: Vec::new(),
            },
        )
        .unwrap();
        let identity = ManagedCreateReconcileRequest::new(
            "create-unknown-coverage",
            "session-unknown-coverage",
            "workspace-unknown-coverage",
        )
        .unwrap();

        let error = match reserve(
            root.path(),
            identity.workspace_id(),
            identity.session_id(),
            identity.idempotency_key(),
            &request_digest(1),
        ) {
            Err(error) => error,
            Ok(_) => panic!("an unknown coverage receipt must reject admission"),
        };
        assert!(error.contains("predecessor coverage schema changed"));
        assert!(
            read_lineage_create_record(root.path(), &identity)
                .unwrap()
                .is_none(),
            "an unknown coverage receipt must fail before create authority is written",
        );
    }

    #[test]
    fn legacy_coverage_receipt_keeps_its_materialized_reverse_semantics() {
        let root = secure_root();
        let workspace_id = "workspace-legacy-coverage-receipt";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let target =
            ManagedCreateReconcileRequest::new("create-target", "session-target", workspace_id)
                .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));
        let successor = publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target,
            &request_digest(2),
        );
        project_predecessor(root.path(), &source, &successor);
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_successor_predecessor_coverage(&directory).unwrap();
        write_successor_shard(
            &directory,
            &directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE),
            &ManagedCreateSuccessorPredecessorCoverageReceipt {
                schema_version: LEGACY_SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION,
                legacy_source_shards_by_target: Vec::new(),
                locator_shards: Vec::new(),
            },
        )
        .unwrap();

        assert!(matches!(
            read_successor_predecessor_coverage(&directory).unwrap(),
            Some(CompleteSuccessorPredecessorCoverage::LegacyReverseIndex)
        ));
        assert!(matches!(
            predecessor_projection(root.path(), &target).unwrap(),
            ManagedCreateSuccessorPredecessorProjection::Predecessor(predecessor)
                if predecessor == source
        ));
    }

    #[test]
    fn legacy_bitmap_coverage_receipt_upgrades_before_bounded_lookup() {
        let root = secure_root();
        let workspace_id = "workspace-legacy-bitmap-coverage";
        let source = identity_in_shard(workspace_id, 41, "legacy-bitmap-source");
        let target = ManagedCreateReconcileRequest::new(
            "legacy-bitmap-target-create",
            "legacy-bitmap-target-session",
            workspace_id,
        )
        .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target,
            &request_digest(2),
        );
        let directory = root.path().join(LEDGER_DIRECTORY);
        let source_index =
            shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap();
        let target_index =
            shard_index(&logical_key(target.workspace_id(), target.session_id())).unwrap();
        let mut legacy_source_shards_by_target =
            vec![[0; SUCCESSOR_PREDECESSOR_BITMAP_WORDS]; LEDGER_SHARDS];
        legacy_source_shards_by_target[target_index][source_index / 64] |=
            1_u64 << (source_index % 64);
        write_successor_shard(
            &directory,
            &directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE),
            &ManagedCreateSuccessorPredecessorCoverageReceipt {
                schema_version: LEGACY_BITMAP_SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION,
                legacy_source_shards_by_target,
                locator_shards: Vec::new(),
            },
        )
        .unwrap();
        assert!(matches!(
            read_successor_predecessor_coverage(&directory).unwrap(),
            Some(CompleteSuccessorPredecessorCoverage::LegacyBitmapRequiresUpgrade),
        ));

        let interrupted =
            ensure_successor_predecessor_coverage_with_interleave(&directory, |index| {
                if index == LEDGER_SHARDS {
                    return Err(ManagedCreateAdmissionError::Ledger(
                        "injected bitmap upgrade crash after locator publish".to_string(),
                    ));
                }
                Ok(())
            })
            .unwrap_err()
            .to_string();
        assert_eq!(
            interrupted,
            "injected bitmap upgrade crash after locator publish"
        );
        assert!(matches!(
            read_successor_predecessor_coverage(&directory).unwrap(),
            Some(CompleteSuccessorPredecessorCoverage::LegacyBitmapRequiresUpgrade),
        ));
        let locator_path = predecessor_locator::shard_path(&directory, target_index);
        let interrupted_locator = fs::read(&locator_path).unwrap();

        let coverage = ensure_successor_predecessor_coverage(&directory).unwrap();

        assert_eq!(fs::read(locator_path).unwrap(), interrupted_locator);
        assert!(matches!(
            coverage,
            CompleteSuccessorPredecessorCoverage::FrozenForwardLocator { .. }
        ));
        let receipt: ManagedCreateSuccessorPredecessorCoverageReceipt = serde_json::from_slice(
            &fs::read(directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            receipt.schema_version,
            SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION
        );
        assert!(receipt.legacy_source_shards_by_target.is_empty());
        assert_eq!(receipt.locator_shards.len(), LEDGER_SHARDS);
        assert_eq!(
            scan_frozen_legacy_predecessor(&directory, &coverage, &target).unwrap(),
            Some(source),
        );
    }

    #[test]
    fn frozen_forward_locator_fails_closed_when_a_covered_source_shard_disappears() {
        let root = secure_root();
        let workspace_id = "workspace-missing-covered-source";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let target =
            ManagedCreateReconcileRequest::new("create-target", "session-target", workspace_id)
                .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target,
            &request_digest(2),
        );
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_successor_predecessor_coverage(&directory).unwrap();
        let source_index =
            shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap();
        fs::remove_file(directory.join(format!("successor_{source_index:02x}.json"))).unwrap();

        let error = match predecessor_projection(root.path(), &target) {
            Err(error) => error.to_string(),
            Ok(_) => panic!("covered source shard disappearance must fail closed"),
        };
        assert!(error.contains("located forward edge disappeared"));
    }

    #[test]
    fn frozen_forward_locator_fails_closed_when_a_locator_shard_disappears() {
        let root = secure_root();
        let workspace_id = "workspace-missing-predecessor-locator";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let target =
            ManagedCreateReconcileRequest::new("create-target", "session-target", workspace_id)
                .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target,
            &request_digest(2),
        );
        let directory = root.path().join(LEDGER_DIRECTORY);
        let coverage = ensure_successor_predecessor_coverage(&directory).unwrap();
        let target_index =
            shard_index(&logical_key(target.workspace_id(), target.session_id())).unwrap();
        fs::remove_file(predecessor_locator::shard_path(&directory, target_index)).unwrap();

        let error = scan_frozen_legacy_predecessor(&directory, &coverage, &target)
            .unwrap_err()
            .to_string();

        assert!(error.contains("predecessor locator shard disappeared"));
    }

    #[test]
    fn frozen_forward_locator_fails_closed_when_a_locator_node_is_tampered() {
        let root = secure_root();
        let workspace_id = "workspace-tampered-predecessor-locator";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let target =
            ManagedCreateReconcileRequest::new("create-target", "session-target", workspace_id)
                .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target,
            &request_digest(2),
        );
        let directory = root.path().join(LEDGER_DIRECTORY);
        let coverage = ensure_successor_predecessor_coverage(&directory).unwrap();
        let target_index =
            shard_index(&logical_key(target.workspace_id(), target.session_id())).unwrap();
        let CompleteSuccessorPredecessorCoverage::FrozenForwardLocator {
            coverage: locator_coverage,
        } = &coverage
        else {
            panic!("current coverage must name the immutable locator shards")
        };
        let root_offset = predecessor_locator::root_offset(locator_coverage, target_index);
        let manifest_path = predecessor_locator::shard_path(&directory, target_index);
        let mut file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&manifest_path)
            .unwrap();
        file.seek(SeekFrom::Start(root_offset)).unwrap();
        let mut first = [0];
        file.read_exact(&mut first).unwrap();
        first[0] ^= 1;
        file.seek(SeekFrom::Start(root_offset)).unwrap();
        file.write_all(&first).unwrap();
        file.sync_all().unwrap();

        let error = scan_frozen_legacy_predecessor(&directory, &coverage, &target)
            .unwrap_err()
            .to_string();

        assert!(error.contains("predecessor locator node digest changed"));
    }

    #[test]
    fn frozen_forward_locator_records_duplicate_target_as_exact_conflict() {
        let root = secure_root();
        let workspace_id = "workspace-duplicate-predecessor-locator";
        let first_source = identity_in_shard(workspace_id, 3, "duplicate-source-a");
        let second_source = identity_in_shard(workspace_id, 197, "duplicate-source-b");
        let target = ManagedCreateReconcileRequest::new(
            "duplicate-target-create",
            "duplicate-target-session",
            workspace_id,
        )
        .unwrap();
        abandon_legacy_generation(root.path(), &first_source, &request_digest(1));
        abandon_legacy_generation(root.path(), &second_source, &request_digest(1));
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &first_source,
            &target,
            &request_digest(2),
        );
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &second_source,
            &target,
            &request_digest(2),
        );
        let directory = root.path().join(LEDGER_DIRECTORY);
        let coverage = ensure_successor_predecessor_coverage(&directory).unwrap();

        let (result, forward_reads) = measure_frozen_predecessor_forward_reads(|| {
            scan_frozen_legacy_predecessor(&directory, &coverage, &target)
        });

        assert!(matches!(
            result,
            Err(ManagedCreateAdmissionError::SuccessorLineageConflict)
        ));
        assert_eq!(
            forward_reads, 0,
            "cutover must persist the duplicate fact without reopening every competing shard",
        );
        let unrelated = ManagedCreateReconcileRequest::new(
            "unrelated-target-create",
            "unrelated-target-session",
            workspace_id,
        )
        .unwrap();
        assert_eq!(
            scan_frozen_legacy_predecessor(&directory, &coverage, &unrelated).unwrap(),
            None,
            "a duplicate target must not block unrelated exact locator absence",
        );
    }

    #[test]
    fn successor_admission_backfills_a_legacy_edge_before_target_create() {
        let root = secure_root();
        let workspace_id = "workspace-legacy-successor-admission";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let digest = request_digest(1);
        abandon_legacy_generation(root.path(), &source, &digest);
        let target =
            ManagedCreateReconcileRequest::new("create-target", "session-target", workspace_id)
                .unwrap();
        publish_legacy_successor_without_chain_bound(root.path(), &source, &target, &digest);

        assert!(matches!(
            reserve_successor_with_rehost_recipe_and_conversation(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &digest,
                None,
                None,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));
        assert!(matches!(
            predecessor_projection(root.path(), &target).unwrap(),
            ManagedCreateSuccessorPredecessorProjection::Predecessor(predecessor)
                if predecessor == source
        ));
    }

    #[test]
    fn fresh_root_admission_preserves_a_forward_only_legacy_predecessor() {
        let root = secure_root();
        let workspace_id = "workspace-legacy-root-conflict";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let digest = request_digest(1);
        abandon_legacy_generation(root.path(), &source, &digest);
        let source_index =
            shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap();
        let target = identity_in_shard(workspace_id, source_index, "legacy-root-target");
        publish_legacy_successor_without_chain_bound(root.path(), &source, &target, &digest);

        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &digest,
                None,
                None,
            ),
            Err(ManagedCreateAdmissionError::SuccessorLineageConflict),
        ));
        assert!(
            read_lineage_create_record(root.path(), &target)
                .unwrap()
                .is_none(),
            "a Root conflict must not consume the predecessor-owned target",
        );
        assert!(matches!(
            predecessor_projection(root.path(), &target).unwrap(),
            ManagedCreateSuccessorPredecessorProjection::Predecessor(predecessor)
                if predecessor == source
        ));
    }

    #[test]
    fn fresh_root_admission_preserves_a_live_indexed_legacy_predecessor() {
        let root = secure_root();
        let source =
            ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1").unwrap();
        let digest = request_digest(1);
        abandon_legacy_generation(root.path(), &source, &digest);
        let source_index =
            shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap();
        let target = identity_in_shard(
            source.workspace_id(),
            source_index,
            "live-legacy-root-target",
        );
        let successor =
            publish_legacy_successor_without_chain_bound(root.path(), &source, &target, &digest);
        project_predecessor(root.path(), &source, &successor);

        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &digest,
                None,
                None,
            ),
            Err(ManagedCreateAdmissionError::SuccessorLineageConflict),
        ));
        assert!(
            read_lineage_create_record(root.path(), &target)
                .unwrap()
                .is_none(),
            "a Root conflict must not consume a live predecessor-owned target",
        );
    }

    #[test]
    fn coverage_fences_an_indexed_v2_writer_that_crashes_before_reverse_publish() {
        let root = secure_root();
        let workspace_id = "workspace-indexed-v2-root-race";
        let digest = request_digest(1);
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        abandon_legacy_generation(root.path(), &source, &digest);
        let target =
            ManagedCreateReconcileRequest::new("create-target", "session-target", workspace_id)
                .unwrap();
        let successor = successor_for_target(&target, &digest);

        let (writer_locked_tx, writer_locked_rx) = mpsc::channel();
        let (publish_tx, publish_rx) = mpsc::channel();
        let writer_root = root.path().to_path_buf();
        let writer_source = source.clone();
        let writer_target = target.clone();
        let writer_successor = successor.clone();
        let writer = thread::spawn(move || {
            let ManagedCreateSuccessorInspection::Found {
                slot: ManagedCreateSuccessorSlot::Vacant(source_reservation),
                ..
            } = inspect_successor_node(&writer_root, &writer_source, None).unwrap()
            else {
                panic!("the retained writer must own the source create lock")
            };
            let reverse = reserve_successor_predecessor_projection(
                &writer_root.join(LEDGER_DIRECTORY),
                &writer_source,
                &writer_successor,
            )
            .unwrap();
            writer_locked_tx.send(()).unwrap();
            publish_rx.recv().unwrap();
            publish_legacy_successor_without_chain_bound(
                &writer_root,
                &writer_source,
                &writer_target,
                &digest,
            );
            drop(reverse);
            drop(source_reservation);
        });
        writer_locked_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the indexed v2 writer must own source and target locks");

        let (root_result_tx, root_result_rx) = mpsc::channel();
        let contender_root = root.path().to_path_buf();
        let contender_target = target.clone();
        let contender_digest = request_digest(1);
        let contender = thread::spawn(move || {
            root_result_tx
                .send(reserve_with_rehost_recipe_and_conversation(
                    &contender_root,
                    contender_target.workspace_id(),
                    contender_target.session_id(),
                    contender_target.idempotency_key(),
                    &contender_digest,
                    None,
                    None,
                ))
                .unwrap();
        });
        assert!(matches!(
            root_result_rx.recv_timeout(Duration::from_millis(250)),
            Err(mpsc::RecvTimeoutError::Timeout),
        ));
        publish_tx.send(()).unwrap();
        writer.join().unwrap();
        assert!(matches!(
            root_result_rx
                .recv_timeout(Duration::from_secs(15))
                .unwrap(),
            Err(ManagedCreateAdmissionError::SuccessorLineageConflict),
        ));
        contender.join().unwrap();
    }

    #[test]
    fn precoverage_v3_root_does_not_mask_a_retained_predecessor() {
        let root = secure_root();
        let workspace_id = "workspace-precoverage-v3-root";
        let digest = request_digest(1);
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let target =
            ManagedCreateReconcileRequest::new("create-target", "session-target", workspace_id)
                .unwrap();
        abandon_legacy_generation(root.path(), &source, &digest);
        write_precoverage_v3_root_generation(root.path(), &target, &digest);
        publish_legacy_successor_without_chain_bound(root.path(), &source, &target, &digest);

        assert!(matches!(
            predecessor_projection(root.path(), &target),
            Err(ManagedCreateAdmissionError::SuccessorLineageConflict),
        ));
        assert!(
            predecessor_projection_record(&root.path().join(LEDGER_DIRECTORY), &target).is_none()
        );
    }

    #[test]
    fn precoverage_v3_predecessor_does_not_mask_a_competing_retained_predecessor() {
        let root = secure_root();
        let workspace_id = "workspace-precoverage-v3-predecessor";
        let digest = request_digest(1);
        let direct_source =
            ManagedCreateReconcileRequest::new("create-direct", "session-direct", workspace_id)
                .unwrap();
        let direct_index = shard_index(&logical_key(
            direct_source.workspace_id(),
            direct_source.session_id(),
        ))
        .unwrap();
        let target = identity_in_shard(workspace_id, direct_index, "direct-target");
        let retained_source = identity_in_shard(
            workspace_id,
            (direct_index + 1) % LEDGER_SHARDS,
            "retained-source",
        );
        write_precoverage_v3_predecessor_generation(root.path(), &direct_source, &target, &digest);
        abandon_legacy_generation(root.path(), &retained_source, &digest);
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &retained_source,
            &target,
            &digest,
        );

        assert!(matches!(
            predecessor_projection(root.path(), &target),
            Err(ManagedCreateAdmissionError::SuccessorLineageConflict),
        ));
        assert!(
            predecessor_projection_record(&root.path().join(LEDGER_DIRECTORY), &target).is_none()
        );
    }

    #[test]
    fn present_predecessor_fingerprint_mismatch_fails_without_scan_fallback() {
        let root = secure_root();
        let workspace_id = "workspace-predecessor-fingerprint";
        let source =
            ManagedCreateReconcileRequest::new("create-a", "session-a", workspace_id).unwrap();
        let target =
            ManagedCreateReconcileRequest::new("create-b", "session-b", workspace_id).unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));
        let successor = publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target,
            &request_digest(2),
        );
        project_predecessor(root.path(), &source, &successor);
        assert_eq!(
            oldest_successor_ancestor(root.path(), &target).unwrap(),
            (source, 2),
        );

        let directory = root.path().join(LEDGER_DIRECTORY);
        let target_key = logical_key(target.workspace_id(), target.session_id());
        let (_, shard_path, index) = predecessor_shard_paths(&directory, &target_key).unwrap();
        let mut shard: ManagedCreateSuccessorPredecessorShard =
            read_successor_state_or_default(&shard_path).unwrap();
        let ManagedCreateSuccessorPredecessorAuthority::Predecessor {
            edge_fingerprint, ..
        } = &mut shard.records.get_mut(&target_key).unwrap().authority
        else {
            panic!("legacy edge must backfill a predecessor projection");
        };
        *edge_fingerprint = request_digest(99);
        write_successor_shard(&directory, &shard_path, &shard).unwrap();
        validate_successor_predecessor_shard(&shard, index).unwrap();
        let projection_before = fs::read(&shard_path).unwrap();

        let error = oldest_successor_ancestor(root.path(), &target)
            .unwrap_err()
            .to_string();
        assert!(error.contains("predecessor projection fingerprint mismatch"));
        assert_eq!(
            fs::read(shard_path).unwrap(),
            projection_before,
            "a present but invalid projection must fail closed without invoking legacy backfill",
        );
    }

    #[test]
    fn legacy_topology_over_the_old_record_budget_is_located_without_reverse_writes() {
        let root = secure_root();
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        let workspace_id = "w";
        let expected_index = 0;
        let edges = write_legacy_successor_shard_over_old_record_budget(
            &directory,
            expected_index,
            workspace_id,
        );
        let first_target = edges.first().unwrap().1.clone();

        let (_, ancestry_len) = oldest_successor_ancestor(root.path(), &first_target).unwrap();
        assert_eq!(ancestry_len, 2);
        for (source, target) in &edges {
            assert!(matches!(
                predecessor_projection(root.path(), target).unwrap(),
                ManagedCreateSuccessorPredecessorProjection::Predecessor(predecessor)
                    if predecessor == *source
            ));
            assert!(predecessor_projection_record(&directory, target).is_none());
        }
        assert!(directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists());
        for index in 0..LEDGER_SHARDS {
            let shard_path = directory.join(format!("shard_{index:02x}.json"));
            let payload = fs::read(&shard_path).unwrap();
            assert!(!legacy_v2_writer_accepts_shard(&payload));
        }
    }

    #[test]
    fn target_bucket_over_reverse_capacity_cuts_over_without_record_backfill() {
        let root = secure_root();
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        let (source, target) = write_legacy_target_bucket_over_reverse_capacity(
            &directory,
            "workspace-reverse-overflow",
            2,
        );
        abandon_legacy_generation(root.path(), &source, &request_digest(1));

        let coverage = ensure_successor_predecessor_coverage(&directory).unwrap();

        assert!(matches!(
            coverage,
            CompleteSuccessorPredecessorCoverage::FrozenForwardLocator { .. }
        ));
        assert!(matches!(
            predecessor_projection(root.path(), &target).unwrap(),
            ManagedCreateSuccessorPredecessorProjection::Predecessor(predecessor)
                if predecessor == source
        ));
        assert!(predecessor_projection_record(&directory, &target).is_none());
    }

    #[test]
    fn dense_target_bucket_opens_one_forward_shard_for_exact_predecessor_lookup() {
        let root = secure_root();
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        let (source, target) = write_legacy_edge_in_every_source_shard_for_one_target_bucket(
            &directory,
            "workspace-dense-target-bucket",
            2,
            173,
        );
        let coverage = ensure_successor_predecessor_coverage(&directory).unwrap();
        assert!(
            fs::metadata(directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE))
                .unwrap()
                .len()
                <= MAX_RECORD_BYTES,
            "coverage must remain a bounded marker instead of carrying target locators",
        );

        let ((predecessor, forward_reads), locator_reads) =
            predecessor_locator::measure_reads(|| {
                measure_frozen_predecessor_forward_reads(|| {
                    scan_frozen_legacy_predecessor(&directory, &coverage, &target).unwrap()
                })
            });

        assert_eq!(predecessor, Some(source));
        assert_eq!(locator_reads.shard_files, 1);
        assert!(
            (1..=32).contains(&locator_reads.nodes),
            "an exact lookup must stay within the authenticated balanced-tree depth",
        );
        assert_eq!(
            forward_reads, 1,
            "exact locator lookup must be independent of valid target-bucket density",
        );
    }

    #[test]
    fn fresh_coverage_batches_all_empty_shards_behind_one_synced_fence_inode() {
        let root = secure_root();
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();

        ensure_successor_predecessor_coverage(&directory).unwrap();

        let fence = fs::metadata(directory.join(EMPTY_V3_CREATE_SHARD_FENCE_FILE)).unwrap();
        for index in 0..LEDGER_SHARDS {
            let shard = fs::metadata(directory.join(format!("shard_{index:02x}.json"))).unwrap();
            assert_eq!(
                (shard.dev(), shard.ino()),
                (fence.dev(), fence.ino()),
                "a fresh cutover must link empty shard {index:02x} to the one synced template",
            );
        }
    }

    #[test]
    fn predecessor_coverage_falls_back_when_hard_links_are_unavailable() {
        let root = secure_root();
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        let legacy_index = 73;
        let legacy_path = directory.join(format!("shard_{legacy_index:02x}.json"));
        let legacy_empty_shard = ManagedCreateLedgerShard {
            schema_version: LEDGER_SHARD_SCHEMA_VERSION_V2,
            ..ManagedCreateLedgerShard::default()
        };
        write_shard(&directory, &legacy_path, &legacy_empty_shard).unwrap();

        let coverage = INJECT_EMPTY_V3_CREATE_SHARD_HARD_LINK_FAILURE.with(|injected| {
            injected.set(true);
            let result = ensure_successor_predecessor_coverage(&directory);
            injected.set(false);
            result
        });
        assert!(matches!(
            coverage.unwrap(),
            CompleteSuccessorPredecessorCoverage::FrozenForwardLocator { .. }
        ));

        let fence = fs::metadata(directory.join(EMPTY_V3_CREATE_SHARD_FENCE_FILE)).unwrap();
        for index in 0..LEDGER_SHARDS {
            let shard_path = directory.join(format!("shard_{index:02x}.json"));
            assert_eq!(
                read_shard_or_default(&shard_path).unwrap(),
                ManagedCreateLedgerShard::default(),
            );
            let shard = fs::metadata(shard_path).unwrap();
            assert_ne!(
                (shard.dev(), shard.ino()),
                (fence.dev(), fence.ino()),
                "fallback shard {index:02x} must be independently atomically published",
            );
        }
    }

    #[test]
    fn fresh_root_admission_migrates_oversized_legacy_topology() {
        let root = secure_root();
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        let workspace_id = "workspace-unindexed-root";
        drop(write_legacy_successor_shard_over_old_record_budget(
            &directory,
            0,
            workspace_id,
        ));
        let target = identity_in_shard(workspace_id, 1, "unindexed-root-target");

        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &request_digest(1),
                None,
                None,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));
        assert!(
            read_lineage_create_record(root.path(), &target)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn existing_root_retry_bypasses_an_oversized_legacy_scan() {
        let root = secure_root();
        let workspace_id = "workspace-projected-root";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let digest = request_digest(1);

        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        let source_key = logical_key(source.workspace_id(), source.session_id());
        let target = identity_in_shard(
            workspace_id,
            shard_index(&source_key).unwrap(),
            "fresh-root-target",
        );
        let unrelated_index = (shard_index(&source_key).unwrap() + 1) % LEDGER_SHARDS;
        drop(write_legacy_successor_shard_over_old_record_budget(
            &directory,
            unrelated_index,
            workspace_id,
        ));
        abandon_generation(root.path(), &source, &digest);

        assert!(matches!(
            reserve(
                root.path(),
                source.workspace_id(),
                source.session_id(),
                source.idempotency_key(),
                &digest,
            )
            .unwrap(),
            ManagedCreateLedgerState::Retired,
        ));
        assert!(matches!(
            predecessor_projection(root.path(), &source).unwrap(),
            ManagedCreateSuccessorPredecessorProjection::Root,
        ));
        assert!(matches!(
            reserve_terminal_successor(root.path(), &source, || {
                Ok(successor_for_target(&target, &digest))
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Created(_),
        ));

        assert_eq!(
            oldest_successor_ancestor(root.path(), &target).unwrap(),
            (source, 2),
            "an existing Root and its direct successor must reuse complete predecessor coverage",
        );
    }

    #[test]
    fn retained_v2_root_lineage_pending_migrates_once_then_replays_from_coverage() {
        let root = secure_root();
        let identity = ManagedCreateReconcileRequest::new(
            "create-retained-root",
            "session-retained-root",
            "workspace-retained-root",
        )
        .unwrap();
        let digest = request_digest(1);
        let directory = root.path().join(LEDGER_DIRECTORY);
        let record_key = logical_key(identity.workspace_id(), identity.session_id());
        let index = shard_index(&record_key).unwrap();
        let shard_path = directory.join(format!("shard_{index:02x}.json"));
        write_retained_v2_generation(
            root.path(),
            &identity,
            &digest,
            ManagedCreateLedgerRecordState::RootLineagePending,
        );
        assert!(
            !legacy_v2_writer_accepts_shard(&fs::read(&shard_path).unwrap()),
            "the retained pending state must fence a reader that predates Root recovery",
        );

        let crash = match reserve_with_lineage_admission_with_interleave(
            root.path(),
            identity.workspace_id(),
            identity.session_id(),
            identity.idempotency_key(),
            &digest,
            ManagedCreateLineageContext {
                canonical_rehost_recipe: None,
                conversation_identity: None,
                admission: ManagedCreateLineageAdmission::Root,
            },
            || {
                Err(ManagedCreateAdmissionError::Ledger(
                    "injected retained Root replay crash".to_string(),
                ))
            },
        ) {
            Err(error) => error.to_string(),
            Ok(_) => panic!("the retained Root replay fault must interrupt admission"),
        };
        assert_eq!(crash, "injected retained Root replay crash");
        assert!(matches!(
            ledger_record(root.path(), &identity).state,
            ManagedCreateLedgerRecordState::RootLineagePending,
        ));

        assert!(matches!(
            reserve(
                root.path(),
                identity.workspace_id(),
                identity.session_id(),
                identity.idempotency_key(),
                &digest,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));
        assert!(matches!(
            predecessor_projection(root.path(), &identity).unwrap(),
            ManagedCreateSuccessorPredecessorProjection::Root,
        ));
        assert!(!legacy_v2_writer_accepts_shard(
            &fs::read(&shard_path).unwrap()
        ));
        let (_, predecessor_path, _) = predecessor_shard_paths(&directory, &record_key).unwrap();
        assert!(
            !read_successor_state_or_default::<ManagedCreateSuccessorPredecessorShard>(
                &predecessor_path,
            )
            .unwrap()
            .records
            .contains_key(&record_key),
            "schema-v3 locator coverage must not materialize a reverse Root record",
        );
    }

    #[test]
    fn retained_v2_root_lineage_pending_preserves_a_forward_only_predecessor() {
        let root = secure_root();
        let workspace_id = "workspace-retained-root-conflict";
        let digest = request_digest(1);
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        abandon_legacy_generation(root.path(), &source, &digest);
        let target =
            ManagedCreateReconcileRequest::new("create-target", "session-target", workspace_id)
                .unwrap();
        write_retained_v2_generation(
            root.path(),
            &target,
            &digest,
            ManagedCreateLedgerRecordState::RootLineagePending,
        );
        publish_legacy_successor_without_chain_bound(root.path(), &source, &target, &digest);

        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &digest,
                None,
                None,
            ),
            Err(ManagedCreateAdmissionError::SuccessorLineageConflict),
        ));
        assert!(matches!(
            ledger_record(root.path(), &target).state,
            ManagedCreateLedgerRecordState::RootLineagePending,
        ));
    }

    #[test]
    fn root_authority_replays_after_crash_after_create_write() {
        let root = secure_root();
        let request_with_recipe = |colors, launch_reference: &str| {
            ManagedCreateRequest::new(
                "create-root",
                "session-root",
                "workspace-root-replay",
                "fixture",
                PermissionMode::Default,
                "/tmp",
                vec!["fixture".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_runtime_contract::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap()
            .with_managed_rehost_recipe(
                ManagedRehostRecipe::new(
                    vec![
                        "fixture".into(),
                        MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                    ],
                    Some(launch_reference.into()),
                )
                .unwrap(),
            )
            .unwrap()
            .with_terminal_default_colors(colors)
            .unwrap()
        };
        let original_request = request_with_recipe(
            TerminalDefaultColors::new(0x12_34_56, 0x65_43_21).unwrap(),
            "credential-reference-1",
        );
        let changed_request = request_with_recipe(
            TerminalDefaultColors::new(0xab_cd_ef, 0xfe_dc_ba).unwrap(),
            "credential-reference-2",
        );
        let canonical_identity = original_request.canonical_create_identity_json().unwrap();
        assert_eq!(
            changed_request.canonical_create_identity_json().unwrap(),
            canonical_identity,
            "terminal defaults and rehost authority are intentionally outside the create digest",
        );
        let digest = request_fingerprint(&[&canonical_identity]);
        let original_source_recipe =
            ManagedRehostSourceRecipe::from_create_request(&original_request)
                .unwrap()
                .unwrap();
        let changed_source_recipe =
            ManagedRehostSourceRecipe::from_create_request(&changed_request)
                .unwrap()
                .unwrap();
        let original_recipe = serde_json::to_string(&original_source_recipe).unwrap();
        let changed_recipe = serde_json::to_string(&changed_source_recipe).unwrap();
        assert_ne!(original_recipe, changed_recipe);
        let identity = ManagedCreateReconcileRequest::new(
            original_request.idempotency_key(),
            original_request.session_id(),
            original_request.workspace_id(),
        )
        .unwrap();
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        let target_key = logical_key(identity.workspace_id(), identity.session_id());
        let error = match reserve_with_lineage_admission_with_interleave(
            root.path(),
            identity.workspace_id(),
            identity.session_id(),
            identity.idempotency_key(),
            &digest,
            ManagedCreateLineageContext {
                canonical_rehost_recipe: Some(&original_recipe),
                conversation_identity: None,
                admission: ManagedCreateLineageAdmission::Root,
            },
            || {
                Err(ManagedCreateAdmissionError::Ledger(
                    "injected crash after Root create reservation".to_string(),
                ))
            },
        ) {
            Err(error) => error.to_string(),
            Ok(_) => panic!("the injected crash must stop before Root projection publication"),
        };
        assert_eq!(error, "injected crash after Root create reservation");
        let record = read_lineage_create_record(root.path(), &identity)
            .unwrap()
            .expect("the create reservation must be durable");
        assert!(matches!(
            &record.state,
            ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified
        ));
        assert!(matches!(
            record.authority.as_ref(),
            Some(ManagedCreateLedgerAuthorityV3 {
                lineage: ManagedCreateLineageAuthorityV3::Root {
                    legacy_predecessor_absence_proven: true,
                },
                successor: ManagedCreateSuccessorSlotV3::Vacant,
            })
        ));
        let (_, predecessor_path, _) = predecessor_shard_paths(&directory, &target_key).unwrap();
        assert!(
            !read_successor_state_or_default::<ManagedCreateSuccessorPredecessorShard>(
                &predecessor_path,
            )
            .unwrap()
            .records
            .contains_key(&target_key),
            "a v3 Root keeps its proof in the create record, not a sibling projection",
        );
        let (_, shard_path) = shard_paths(&directory, &target_key).unwrap();
        assert!(
            !legacy_v2_writer_accepts_shard(&fs::read(&shard_path).unwrap()),
            "a pre-index v2 writer must fail closed on the Root recovery marker",
        );

        let competing_source = identity_in_shard(
            identity.workspace_id(),
            shard_index(&target_key).unwrap(),
            "root-replay-competitor",
        );
        abandon_generation(root.path(), &competing_source, &request_digest(9));
        let successor_error = reserve_terminal_successor(root.path(), &competing_source, || {
            ManagedCreateSuccessorIdentity::new(
                identity.session_id(),
                identity.idempotency_key(),
                &digest,
            )
        })
        .unwrap_err()
        .to_string();
        assert!(successor_error.contains("target create authority is already claimed"));
        let competing_key = logical_key(
            competing_source.workspace_id(),
            competing_source.session_id(),
        );
        let competing_index = shard_index(&competing_key).unwrap();
        assert!(
            !read_successor_shard_or_default(
                &directory.join(format!("successor_{competing_index:02x}.json")),
            )
            .unwrap()
            .records
            .contains_key(&competing_key),
            "current successor admission must reject before its forward edge publication",
        );

        let changed_error = match reserve_with_rehost_recipe(
            root.path(),
            identity.workspace_id(),
            identity.session_id(),
            identity.idempotency_key(),
            &digest,
            Some(&changed_recipe),
        ) {
            Err(error) => error,
            Ok(_) => panic!("a changed Root recipe must not acquire create authority"),
        };
        assert!(changed_error.contains("canonical rehost recipe changed"));
        assert!(
            read_lineage_create_record(root.path(), &identity)
                .unwrap()
                .is_some_and(|persisted| persisted == record),
            "a changed recipe must not replace the v3 Root authority",
        );

        assert!(matches!(
            reserve_with_rehost_recipe(
                root.path(),
                identity.workspace_id(),
                identity.session_id(),
                identity.idempotency_key(),
                &digest,
                Some(&original_recipe),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));
        assert!(!legacy_v2_writer_accepts_shard(
            &fs::read(shard_path).unwrap()
        ));
        assert_eq!(
            managed_rehost_recipe(root.path(), identity.workspace_id(), identity.session_id())
                .unwrap(),
            Some(original_source_recipe),
            "the first Root reservation must retain its terminal-default recipe",
        );
        assert!(matches!(
            predecessor_projection(root.path(), &identity).unwrap(),
            ManagedCreateSuccessorPredecessorProjection::Root,
        ));
    }

    #[test]
    fn root_create_owns_lineage_capacity_across_the_create_publish_crash() {
        let root = secure_root();
        let workspace_id = "workspace-root-capacity-crash";
        let identity = ManagedCreateReconcileRequest::new(
            "create-root-capacity",
            "session-root-capacity",
            workspace_id,
        )
        .unwrap();
        let target_key = logical_key(identity.workspace_id(), identity.session_id());
        let index = shard_index(&target_key).unwrap();
        let digest = request_digest(1);
        fill_predecessor_shard_one_slot_from_capacity(root.path(), index, workspace_id);

        let error = match reserve_with_lineage_admission_with_interleave(
            root.path(),
            identity.workspace_id(),
            identity.session_id(),
            identity.idempotency_key(),
            &digest,
            ManagedCreateLineageContext {
                canonical_rehost_recipe: None,
                conversation_identity: None,
                admission: ManagedCreateLineageAdmission::Root,
            },
            || {
                Err(ManagedCreateAdmissionError::Ledger(
                    "injected crash after Root create reservation".to_string(),
                ))
            },
        ) {
            Err(error) => error,
            Ok(_) => panic!("the injected crash must interrupt Root admission"),
        };
        assert_eq!(
            error.to_string(),
            "injected crash after Root create reservation"
        );

        let competitor = identity_in_shard(workspace_id, index, "root-capacity-competitor");
        assert!(matches!(
            reserve(
                root.path(),
                competitor.workspace_id(),
                competitor.session_id(),
                competitor.idempotency_key(),
                &request_digest(2),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));

        assert!(matches!(
            reserve(
                root.path(),
                identity.workspace_id(),
                identity.session_id(),
                identity.idempotency_key(),
                &digest,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
    }

    #[test]
    fn exact_successor_retry_repairs_forward_before_target_create_after_cutover() {
        let root = secure_root();
        let workspace_id = "workspace-successor-replay";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let target =
            ManagedCreateReconcileRequest::new("create-target", "session-target", workspace_id)
                .unwrap();
        let digest = request_digest(1);
        abandon_legacy_generation(root.path(), &source, &digest);
        let expected =
            publish_legacy_successor_without_chain_bound(root.path(), &source, &target, &digest);

        let directory = root.path().join(LEDGER_DIRECTORY);
        let source_key = logical_key(source.workspace_id(), source.session_id());
        let unrelated_index = (shard_index(&source_key).unwrap() + 1) % LEDGER_SHARDS;
        drop(write_legacy_successor_shard_over_old_record_budget(
            &directory,
            unrelated_index,
            workspace_id,
        ));
        let target_key = logical_key(target.workspace_id(), target.session_id());
        let (_, predecessor_path, _) = predecessor_shard_paths(&directory, &target_key).unwrap();
        assert!(
            !read_successor_state_or_default::<ManagedCreateSuccessorPredecessorShard>(
                &predecessor_path,
            )
            .unwrap()
            .records
            .contains_key(&target_key),
            "the fault fixture must retain only the forward edge",
        );

        let ManagedCreateSuccessorLedgerState::Existing(replayed) =
            reserve_terminal_successor(root.path(), &source, || {
                panic!("an exact edge retry must not allocate another target")
            })
            .unwrap()
        else {
            panic!("the exact forward edge must replay")
        };
        assert_eq!(replayed, expected);
        assert!(matches!(
            predecessor_projection(root.path(), &target).unwrap(),
            ManagedCreateSuccessorPredecessorProjection::Predecessor(predecessor)
                if predecessor == source
        ));
        assert!(matches!(
            reserve_successor_with_rehost_recipe_and_conversation(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &digest,
                None,
                None,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));
    }

    #[test]
    fn legacy_root_is_projected_after_one_bounded_scan() {
        let root = secure_root();
        let identity = ManagedCreateReconcileRequest::new(
            "create-root",
            "session-root",
            "workspace-legacy-root",
        )
        .unwrap();
        abandon_legacy_generation(root.path(), &identity, &request_digest(1));

        let directory = root.path().join(LEDGER_DIRECTORY);
        let target_key = logical_key(identity.workspace_id(), identity.session_id());
        let (_, predecessor_path, _) = predecessor_shard_paths(&directory, &target_key).unwrap();
        let predecessors: ManagedCreateSuccessorPredecessorShard =
            read_successor_state_or_default(&predecessor_path).unwrap();
        assert!(!predecessors.records.contains_key(&target_key));

        assert_eq!(
            oldest_successor_ancestor(root.path(), &identity).unwrap(),
            (identity.clone(), 1),
        );
        assert!(matches!(
            predecessor_projection(root.path(), &identity).unwrap(),
            ManagedCreateSuccessorPredecessorProjection::Root,
        ));
    }

    #[test]
    fn root_conflict_is_rejected_before_forward_edge_publication() {
        let root = secure_root();
        let workspace_id = "workspace-predecessor-preflight";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        abandon_generation(root.path(), &source, &request_digest(1));
        let target = identity_in_shard(
            workspace_id,
            shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap(),
            "root-conflict-target",
        );
        assert!(matches!(
            reserve(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &request_digest(2),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));

        let error = reserve_terminal_successor(root.path(), &source, || {
            ManagedCreateSuccessorIdentity::new(
                target.session_id(),
                target.idempotency_key(),
                request_digest(3),
            )
        })
        .unwrap_err()
        .to_string();
        assert!(error.contains("target create authority is already claimed"));
        let directory = root.path().join(LEDGER_DIRECTORY);
        let source_key = logical_key(source.workspace_id(), source.session_id());
        let source_index = shard_index(&source_key).unwrap();
        assert!(
            !read_successor_shard_or_default(
                &directory.join(format!("successor_{source_index:02x}.json")),
            )
            .unwrap()
            .records
            .contains_key(&source_key),
            "reverse conflict preflight must reject before publishing the forward edge",
        );
    }

    #[test]
    fn successor_intent_replays_after_the_retirement_crash_boundary() {
        let root = secure_root();
        let workspace_id = "workspace-preflight-target-replay";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let first_target = successor_in_source_shard(&source, "first-target", &request_digest(2));
        let retry_target = ManagedCreateSuccessorIdentity::new(
            "session-retry-target",
            "create-retry-target",
            request_digest(2),
        )
        .unwrap();
        let ManagedCreateLedgerState::Prepared(reservation) = reserve(
            root.path(),
            source.workspace_id(),
            source.session_id(),
            source.idempotency_key(),
            &request_digest(1),
        )
        .unwrap() else {
            panic!("source must be prepared")
        };

        assert_eq!(
            reserve_successor_intent(root.path(), &source, || Ok(first_target.clone())).unwrap(),
            ManagedCreateSuccessorLedgerState::Created(first_target.clone()),
        );
        assert!(matches!(
            resolve_successor_chain(root.path(), &source).unwrap(),
            ManagedCreateSuccessorChainResolution::Pending { .. }
        ));
        let admission_error =
            admission_error(reserve_successor_with_rehost_recipe_and_conversation(
                root.path(),
                source.workspace_id(),
                first_target.session_id(),
                first_target.idempotency_key(),
                &request_digest(2),
                None,
                None,
            ))
            .to_string();
        assert!(admission_error.contains("predecessor source is not terminal"));
        drop(reservation);
        let ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(mut reservation) =
            reconcile_identity(root.path(), &source).unwrap()
        else {
            panic!("the direct intent must retain the source create lifecycle")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.abandon_before_completion().unwrap();

        let ManagedCreateSuccessorLedgerState::Existing(replayed) =
            reserve_terminal_successor(root.path(), &source, || Ok(retry_target)).unwrap()
        else {
            panic!("retired source must consume its durable successor intent")
        };
        assert_eq!(
            replayed, first_target,
            "a restart after source retirement must not allocate a different target",
        );
        assert!(matches!(
            reserve_successor_with_rehost_recipe_and_conversation(
                root.path(),
                source.workspace_id(),
                replayed.session_id(),
                replayed.idempotency_key(),
                &request_digest(2),
                None,
                None,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));
    }

    #[test]
    fn unproven_v3_root_successor_intent_recovers_before_source_lock() {
        let root = secure_root();
        let source = ManagedCreateReconcileRequest::new(
            "create-unproven-intent",
            "session-unproven-intent",
            "workspace-unproven-intent",
        )
        .unwrap();
        assert!(matches!(
            reserve(
                root.path(),
                source.workspace_id(),
                source.session_id(),
                source.idempotency_key(),
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));
        downgrade_root_lineage_proof(root.path(), &source);
        let target =
            successor_in_source_shard(&source, "unproven-intent-target", &request_digest(2));
        let worker_root = root.path().to_path_buf();
        let worker_source = source.clone();
        let worker_target = target.clone();
        let (result_tx, result_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            result_tx
                .send(reserve_successor_intent(
                    &worker_root,
                    &worker_source,
                    || Ok(worker_target),
                ))
                .unwrap();
        });

        assert_eq!(
            result_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("Root proof recovery must not reacquire the held source lock")
                .unwrap(),
            ManagedCreateSuccessorLedgerState::Created(target),
        );
        worker.join().unwrap();
    }

    #[test]
    fn unproven_v3_root_terminal_successor_recovers_before_source_lock() {
        let root = secure_root();
        let source = ManagedCreateReconcileRequest::new(
            "create-unproven-terminal",
            "session-unproven-terminal",
            "workspace-unproven-terminal",
        )
        .unwrap();
        abandon_generation(root.path(), &source, &request_digest(1));
        downgrade_root_lineage_proof(root.path(), &source);
        let target =
            successor_in_source_shard(&source, "unproven-terminal-target", &request_digest(2));
        let worker_root = root.path().to_path_buf();
        let worker_source = source.clone();
        let worker_target = target.clone();
        let (result_tx, result_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            result_tx
                .send(reserve_terminal_successor(
                    &worker_root,
                    &worker_source,
                    || Ok(worker_target),
                ))
                .unwrap();
        });

        assert_eq!(
            result_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("Root proof recovery must not reacquire the held source lock")
                .unwrap(),
            ManagedCreateSuccessorLedgerState::Created(target),
        );
        worker.join().unwrap();
    }

    #[test]
    fn successor_intent_owns_capacity_across_source_retirement() {
        let root = secure_root();
        let workspace_id = "workspace-preflight-capacity-race";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let source_key = logical_key(source.workspace_id(), source.session_id());
        let source_index = shard_index(&source_key).unwrap();
        let ManagedCreateLedgerState::Prepared(mut source_reservation) = reserve(
            root.path(),
            source.workspace_id(),
            source.session_id(),
            source.idempotency_key(),
            &request_digest(1),
        )
        .unwrap() else {
            panic!("source must be prepared")
        };
        let target_identity = identity_in_shard(workspace_id, source_index, "preflight-target");
        let expected = successor_for_target(&target_identity, &request_digest(2));

        source_reservation.checkpoint_pre_spawn_absence().unwrap();
        source_reservation.abandon_before_completion().unwrap();
        assert_eq!(
            reserve_successor_intent(root.path(), &source, || Ok(expected.clone())).unwrap(),
            ManagedCreateSuccessorLedgerState::Created(expected.clone()),
        );

        let ManagedCreateSuccessorLedgerState::Existing(replayed) =
            reserve_terminal_successor(root.path(), &source, || Ok(expected.clone())).unwrap()
        else {
            panic!("intent must own one successor slot before source retirement")
        };
        assert_eq!(replayed, expected);
    }

    #[test]
    fn successor_intent_owns_target_create_capacity_before_source_retirement() {
        let root = secure_root();
        let workspace_id = "workspace-target-create-capacity";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let source_key = logical_key(source.workspace_id(), source.session_id());
        let source_index = shard_index(&source_key).unwrap();
        let target = identity_in_shard(workspace_id, source_index, "same-shard-target");
        let target = ManagedCreateSuccessorIdentity::new(
            target.session_id(),
            target.idempotency_key(),
            request_digest(2),
        )
        .unwrap();
        assert!(matches!(
            reserve(
                root.path(),
                source.workspace_id(),
                source.session_id(),
                source.idempotency_key(),
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
        fill_create_shard_to_capacity(root.path(), source_index, workspace_id);

        let error = reserve_successor_intent(root.path(), &source, || Ok(target.clone()))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("hmux_managed_create_ledger_capacity"),
            "target create capacity must fail before source retirement: {error}"
        );
        assert!(matches!(
            reconcile_identity(root.path(), &source).unwrap(),
            ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(_)
        ));
    }

    #[test]
    fn successor_allocation_skips_an_occupied_same_shard_candidate() {
        let root = secure_root();
        let workspace_id = "workspace-successor-occupied-candidate";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        abandon_generation(root.path(), &source, &request_digest(1));
        let source_index =
            shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap();
        let occupied = identity_in_shard(workspace_id, source_index, "occupied-candidate");
        let available = identity_in_shard(workspace_id, source_index, "available-candidate");
        assert_ne!(occupied.session_id(), available.session_id());
        assert!(matches!(
            reserve(
                root.path(),
                occupied.workspace_id(),
                occupied.session_id(),
                occupied.idempotency_key(),
                &request_digest(2),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));

        let mut candidates = [
            successor_for_target(&occupied, &request_digest(3)),
            successor_for_target(&available, &request_digest(4)),
        ]
        .into_iter();
        assert_eq!(
            reserve_terminal_successor_with_conversation(root.path(), &source, None, || {
                Ok(candidates
                    .next()
                    .expect("bounded allocator must not request a third candidate"))
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Created(successor_for_target(
                &available,
                &request_digest(4),
            )),
        );
    }

    #[test]
    fn successor_intent_owns_forward_capacity_across_reverse_publish_crash() {
        let root = secure_root();
        let workspace_id = "workspace-successor-forward-capacity-crash";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let source_key = logical_key(source.workspace_id(), source.session_id());
        let source_index = shard_index(&source_key).unwrap();
        let target_identity = identity_in_shard(workspace_id, source_index, "forward-target");
        let target = successor_for_target(&target_identity, &request_digest(2));
        abandon_generation(root.path(), &source, &request_digest(1));
        let competing_source = identity_in_shard(workspace_id, source_index, "forward-competitor");
        abandon_generation(root.path(), &competing_source, &request_digest(3));
        let directory = root.path().join(LEDGER_DIRECTORY);
        write_successor_shard_one_slot_from_capacity(
            &directory,
            source_index,
            workspace_id,
            &[source.session_id(), competing_source.session_id()],
        );

        let error = reserve_terminal_successor_with_interleave(
            root.path(),
            &source,
            || Ok(target.clone()),
            || {
                Err(ManagedCreateAdmissionError::Ledger(
                    "injected crash after reverse publish".to_string(),
                ))
            },
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "injected crash after reverse publish");
        assert!(matches!(
            reserve_terminal_successor(root.path(), &competing_source, || {
                let competing_target =
                    identity_in_shard(workspace_id, source_index, "forward-competitor-target");
                Ok(successor_for_target(&competing_target, &request_digest(4)))
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Created(_)
        ));

        assert_eq!(
            reserve_terminal_successor(root.path(), &source, || Ok(target.clone())).unwrap(),
            ManagedCreateSuccessorLedgerState::Existing(target)
        );
    }

    #[test]
    fn successor_atomic_publish_survives_response_loss_and_refuses_racing_root() {
        let root = secure_root();
        let workspace_id = "workspace-successor-claim-crash";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        let source_digest = request_digest(1);
        let target_digest = request_digest(2);
        abandon_generation(root.path(), &source, &source_digest);
        let target = identity_in_shard(
            workspace_id,
            shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap(),
            "claim-crash-target",
        );

        let error = reserve_terminal_successor_with_interleave(
            root.path(),
            &source,
            || Ok(successor_for_target(&target, &target_digest)),
            || {
                Err(ManagedCreateAdmissionError::Ledger(
                    "injected crash after first lineage publication".to_string(),
                ))
            },
        )
        .unwrap_err()
        .to_string();
        assert_eq!(error, "injected crash after first lineage publication");

        let root_path = root.path().to_path_buf();
        let racing_target = target.clone();
        let racing_digest = target_digest.clone();
        let root_admission = thread::spawn(move || {
            reserve(
                &root_path,
                racing_target.workspace_id(),
                racing_target.session_id(),
                racing_target.idempotency_key(),
                &racing_digest,
            )
        })
        .join()
        .unwrap();
        let root_error = match root_admission {
            Err(error) => error,
            Ok(_) => panic!("the racing Root create must be rejected"),
        };
        assert!(
            root_error.contains("target lineage is already claimed"),
            "the durable successor claim must defeat a racing Root create: {root_error}",
        );

        assert!(matches!(
            reserve_terminal_successor(root.path(), &source, || {
                ManagedCreateSuccessorIdentity::new(
                    target.session_id(),
                    target.idempotency_key(),
                    &target_digest,
                )
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Existing(_),
        ));
        assert!(matches!(
            reserve_successor_with_rehost_recipe_and_conversation(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &target_digest,
                None,
                None,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));
    }

    #[test]
    fn ancestor_ambiguity_isolated_to_the_exact_target_after_coverage() {
        let root = secure_root();
        let workspace_id = "workspace-ancestor-ambiguity";
        let target =
            ManagedCreateReconcileRequest::new("create-target", "session-target", workspace_id)
                .unwrap();
        for index in 0..2 {
            let source = ManagedCreateReconcileRequest::new(
                format!("create-source-{index}"),
                format!("session-source-{index}"),
                workspace_id,
            )
            .unwrap();
            abandon_legacy_generation(root.path(), &source, &request_digest(1));
            publish_legacy_successor_without_chain_bound(
                root.path(),
                &source,
                &target,
                &request_digest(2),
            );
        }

        let unrelated = ManagedCreateReconcileRequest::new(
            "create-unrelated",
            "session-unrelated",
            workspace_id,
        )
        .unwrap();
        assert!(matches!(
            reserve(
                root.path(),
                unrelated.workspace_id(),
                unrelated.session_id(),
                unrelated.idempotency_key(),
                &request_digest(3),
            ),
            Ok(ManagedCreateLedgerState::Prepared(_))
        ));
        assert!(
            root.path()
                .join(LEDGER_DIRECTORY)
                .join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE)
                .exists(),
            "the locator can cover ambiguous topology without choosing an owner",
        );
        assert!(
            matches!(
                predecessor_projection(root.path(), &target),
                Err(ManagedCreateAdmissionError::SuccessorLineageConflict),
            ),
            "only the ambiguous target must fail closed",
        );
    }

    #[test]
    fn successor_admission_refuses_the_129th_identity_before_allocator() {
        let root = secure_root();
        let workspace_id = "workspace-successor-admission-bound";
        let digest = request_digest(1);
        let identities = (0..=MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES)
            .map(|index| {
                ManagedCreateReconcileRequest::new(
                    format!("create-{index}"),
                    format!("session-{index}"),
                    workspace_id,
                )
                .unwrap()
            })
            .collect::<Vec<_>>();

        for identity in identities
            .iter()
            .take(MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES)
        {
            abandon_legacy_generation(root.path(), identity, &digest);
        }
        for pair in identities[..MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES].windows(2) {
            let successor = publish_legacy_successor_without_chain_bound(
                root.path(),
                &pair[0],
                &pair[1],
                &digest,
            );
            project_predecessor(root.path(), &pair[0], &successor);
        }

        let source = &identities[MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES - 1];
        let target = &identities[MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES];
        let allocations = AtomicUsize::new(0);
        let error = reserve_terminal_successor(root.path(), source, || {
            allocations.fetch_add(1, Ordering::SeqCst);
            ManagedCreateSuccessorIdentity::new(
                target.session_id(),
                target.idempotency_key(),
                &digest,
            )
        })
        .unwrap_err();
        let error = error.to_string();
        assert!(
            error.contains("hmux_managed_create_successor_capacity"),
            "the protocol-size bound must reject successor admission: {error}",
        );
        assert_eq!(allocations.load(Ordering::SeqCst), 0);
        let record_key = logical_key(source.workspace_id(), source.session_id());
        let index = shard_index(&record_key).unwrap();
        assert!(
            !read_successor_shard_or_default(
                &root
                    .path()
                    .join(LEDGER_DIRECTORY)
                    .join(format!("successor_{index:02x}.json")),
            )
            .unwrap()
            .records
            .contains_key(&record_key),
            "the 129th successor edge must not be published",
        );
    }

    #[test]
    fn destructive_resolution_rejects_a_legacy_oversized_chain_before_claim() {
        let root = secure_root();
        let workspace_id = "workspace-legacy-chain-bound";
        let digest = request_digest(1);
        let identities = (0..=MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES)
            .map(|index| {
                ManagedCreateReconcileRequest::new(
                    format!("create-{index}"),
                    format!("session-{index}"),
                    workspace_id,
                )
                .unwrap()
            })
            .collect::<Vec<_>>();
        for identity in &identities {
            abandon_legacy_generation(root.path(), identity, &digest);
        }
        for pair in identities.windows(2) {
            let successor = publish_legacy_successor_without_chain_bound(
                root.path(),
                &pair[0],
                &pair[1],
                &digest,
            );
            project_predecessor(root.path(), &pair[0], &successor);
        }

        let effective = identities.last().unwrap();
        let error = claim_successor_chain_cleanup(root.path(), effective).unwrap_err();
        assert!(
            error.contains("hmux_managed_create_successor_capacity"),
            "the legacy protocol-size bound must fail before cleanup: {error}",
        );
        let effective_record = ledger_record(root.path(), effective);
        assert_eq!(
            effective_record.schema_version,
            LEDGER_RECORD_SCHEMA_VERSION_V2
        );
        let record_key = logical_key(effective.workspace_id(), effective.session_id());
        let index = shard_index(&record_key).unwrap();
        assert!(
            !read_successor_shard_or_default(
                &root
                    .path()
                    .join(LEDGER_DIRECTORY)
                    .join(format!("successor_{index:02x}.json")),
            )
            .unwrap()
            .records
            .contains_key(&record_key),
            "an oversized legacy chain must not publish a cleanup closure",
        );
    }

    #[test]
    fn cleanup_terminal_observation_cannot_be_followed_by_successor_allocation() {
        let root = secure_root();
        let source = ManagedCreateReconcileRequest::new(
            "create-source",
            "session-source",
            "workspace-successor-cleanup-race",
        )
        .unwrap();
        let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
            root.path(),
            source.workspace_id(),
            source.session_id(),
            source.idempotency_key(),
            &request_digest(1),
        )
        .unwrap() else {
            panic!("source must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.abandon_before_completion().unwrap();

        assert_eq!(
            claim_successor_chain_cleanup(root.path(), &source).unwrap(),
            ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                chain: successor_chain(vec![source.clone()]),
                stop_receipt: None,
            },
            "stop recovery must first observe the exact terminal source",
        );

        let allocations = AtomicUsize::new(0);
        let late_advance = reserve_terminal_successor(root.path(), &source, || {
            allocations.fetch_add(1, Ordering::SeqCst);
            ManagedCreateSuccessorIdentity::new(
                "session-late-successor",
                "create-late-successor",
                request_digest(2),
            )
        })
        .unwrap();
        assert!(
            !matches!(
                late_advance,
                ManagedCreateSuccessorLedgerState::Created(_)
                    | ManagedCreateSuccessorLedgerState::Existing(_)
            ),
            "a cleanup terminal decision must fence a late orphaned advance, got {late_advance:?}",
        );
        assert_eq!(
            allocations.load(Ordering::SeqCst),
            0,
            "the late advance allocator must remain outside the cleanup fence",
        );
    }

    #[test]
    fn pending_cleanup_closes_before_reconcile_can_enable_a_queued_advance() {
        let root = secure_root();
        let source = ManagedCreateReconcileRequest::new(
            "create-source",
            "session-source",
            "workspace-pending-cleanup-race",
        )
        .unwrap();
        let ManagedCreateLedgerState::Prepared(mut stale_creator) = reserve(
            root.path(),
            source.workspace_id(),
            source.session_id(),
            source.idempotency_key(),
            &request_digest(1),
        )
        .unwrap() else {
            panic!("source must be prepared")
        };
        stale_creator.checkpoint_pre_spawn_absence().unwrap();

        assert!(matches!(
            claim_successor_chain_cleanup(root.path(), &source).unwrap(),
            ManagedCreateSuccessorChainResolution::Pending { .. },
        ));

        // Reconciliation may now make the formerly pending create terminal,
        // but the destructive claim already owns the direct successor slot.
        stale_creator.abandon_before_completion().unwrap();
        let allocations = AtomicUsize::new(0);
        assert_eq!(
            reserve_terminal_successor(root.path(), &source, || {
                allocations.fetch_add(1, Ordering::SeqCst);
                ManagedCreateSuccessorIdentity::new(
                    "session-late-successor",
                    "create-late-successor",
                    request_digest(2),
                )
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Closed,
        );
        assert_eq!(allocations.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn cleanup_claim_and_successor_reservation_have_one_atomic_winner() {
        let root = secure_root();
        for index in 0..32 {
            let source = ManagedCreateReconcileRequest::new(
                format!("create-source-{index}"),
                format!("session-source-{index}"),
                "workspace-successor-cleanup-race",
            )
            .unwrap();
            let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
                root.path(),
                source.workspace_id(),
                source.session_id(),
                source.idempotency_key(),
                &request_digest(1),
            )
            .unwrap() else {
                panic!("source must be prepared")
            };
            reservation.checkpoint_pre_spawn_absence().unwrap();
            reservation.abandon_before_completion().unwrap();

            let start = Arc::new(Barrier::new(3));
            let allocations = Arc::new(AtomicUsize::new(0));
            let cleanup = {
                let root = root.path().to_path_buf();
                let source = source.clone();
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    claim_successor_chain_cleanup(&root, &source).unwrap()
                })
            };
            let advance = {
                let root = root.path().to_path_buf();
                let source = source.clone();
                let start = Arc::clone(&start);
                let allocations = Arc::clone(&allocations);
                thread::spawn(move || {
                    start.wait();
                    reserve_terminal_successor(&root, &source, || {
                        allocations.fetch_add(1, Ordering::SeqCst);
                        Ok(successor_in_source_shard(
                            &source,
                            &format!("race-target-{index}"),
                            &request_digest(2),
                        ))
                    })
                    .unwrap()
                })
            };
            start.wait();
            let cleanup = cleanup.join().unwrap();
            let advance = advance.join().unwrap();
            match (cleanup, advance) {
                (
                    ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor { .. },
                    ManagedCreateSuccessorLedgerState::Closed,
                ) => assert_eq!(allocations.load(Ordering::SeqCst), 0),
                (
                    ManagedCreateSuccessorChainResolution::Pending { .. },
                    ManagedCreateSuccessorLedgerState::Created(_),
                ) => assert_eq!(allocations.load(Ordering::SeqCst), 1),
                (cleanup, advance) => panic!(
                    "cleanup and advance must serialize to one durable winner, got {cleanup:?} and {advance:?}"
                ),
            }
        }
    }

    #[test]
    fn successor_chain_requires_edge_digest_to_match_target_admission() {
        let root = secure_root();
        let source = ManagedCreateReconcileRequest::new(
            "create-source",
            "session-source",
            "workspace-successor-digest",
        )
        .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));
        let target = ManagedCreateReconcileRequest::new(
            "create-target",
            "session-target",
            source.workspace_id(),
        )
        .unwrap();
        let successor = publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target,
            &request_digest(2),
        );
        ensure_successor_digest_projection(
            root.path(),
            &source,
            &successor,
            &request_digest(2),
            None,
        )
        .unwrap();
        assert!(matches!(
            reserve_successor_with_rehost_recipe_and_conversation(
                root.path(),
                source.workspace_id(),
                "session-target",
                "create-target",
                &request_digest(3),
                None,
                None,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));

        let error = resolve_successor_chain(root.path(), &source).unwrap_err();
        assert!(
            error.contains("hmux_managed_create_successor_digest_conflict"),
            "unexpected authority error: {error}",
        );
    }

    #[test]
    fn successor_chain_requires_raw_rehost_digest_to_match_target_admission() {
        let root = secure_root();
        let workspace_id = "workspace-successor-recipe-digest";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));
        let target_identity = ManagedCreateReconcileRequest::new(
            "create-target",
            "session-target",
            source.workspace_id(),
        )
        .unwrap();
        let successor = publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target_identity,
            &request_digest(2),
        );
        ensure_successor_digest_projection(
            root.path(),
            &source,
            &successor,
            &request_digest(3),
            Some(&request_digest(4)),
        )
        .unwrap();

        let target = ManagedCreateRequest::new(
            "create-target",
            "session-target",
            workspace_id,
            "fixture",
            PermissionMode::Default,
            "/tmp",
            vec!["fixture".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(
            hmux_runtime_contract::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
        )
        .unwrap()
        .with_managed_rehost_recipe(
            ManagedRehostRecipe::new(
                vec![
                    "changed".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                None,
            )
            .unwrap(),
        )
        .unwrap();
        let source_recipe = ManagedRehostSourceRecipe::from_create_request(&target)
            .unwrap()
            .unwrap();
        let source_recipe = serde_json::to_string(&source_recipe).unwrap();
        assert!(matches!(
            reserve_successor_with_rehost_recipe_and_conversation(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &request_digest(3),
                Some(&source_recipe),
                None,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));

        let error = resolve_successor_chain(root.path(), &source).unwrap_err();
        assert!(
            error.contains("hmux_managed_create_successor_digest_conflict"),
            "unexpected authority error: {error}",
        );
    }

    #[test]
    fn recipe_bearing_legacy_successor_replays_and_claims_after_target_admission() {
        let root = secure_root();
        let workspace_id = "workspace-successor-legacy-recipe";
        let source =
            ManagedCreateReconcileRequest::new("create-source", "session-source", workspace_id)
                .unwrap();
        abandon_legacy_generation(root.path(), &source, &request_digest(1));

        let target = ManagedCreateRequest::new(
            "create-target",
            "session-target",
            workspace_id,
            "fixture",
            PermissionMode::Default,
            "/tmp",
            vec!["fixture".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(
            hmux_runtime_contract::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
        )
        .unwrap()
        .with_managed_rehost_recipe(
            ManagedRehostRecipe::new(
                vec![
                    "fixture".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                None,
            )
            .unwrap(),
        )
        .unwrap();
        let legacy_request = target
            .clone()
            .with_terminal_default_colors_option(None)
            .unwrap();
        let legacy_digest =
            request_fingerprint(&[&serde_json::to_string(&legacy_request).unwrap()]);
        let canonical_digest =
            request_fingerprint(&[&target.canonical_create_identity_json().unwrap()]);
        assert_ne!(
            legacy_digest, canonical_digest,
            "a recipe-bearing v1 edge used the old combined digest domain"
        );
        let target_identity = ManagedCreateReconcileRequest::new(
            target.idempotency_key(),
            target.session_id(),
            target.workspace_id(),
        )
        .unwrap();
        publish_legacy_successor_without_chain_bound(
            root.path(),
            &source,
            &target_identity,
            &legacy_digest,
        );

        let source_recipe = ManagedRehostSourceRecipe::from_create_request(&target)
            .unwrap()
            .unwrap();
        let source_recipe = serde_json::to_string(&source_recipe).unwrap();
        let ManagedCreateLedgerState::Prepared(mut target_reservation) =
            reserve_successor_with_rehost_recipe_and_conversation(
                root.path(),
                target.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &canonical_digest,
                Some(&source_recipe),
                None,
            )
            .unwrap()
        else {
            panic!("target must be admitted")
        };
        target_reservation.checkpoint_pre_spawn_absence().unwrap();
        target_reservation.abandon_before_completion().unwrap();

        assert_eq!(
            resolve_successor_chain(root.path(), &source).unwrap(),
            ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                chain: successor_chain(vec![source.clone(), target_identity.clone()]),
                stop_receipt: None,
            },
        );
        assert_eq!(
            claim_successor_chain_cleanup(root.path(), &source).unwrap(),
            ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                chain: successor_chain(vec![source.clone(), target_identity.clone()]),
                stop_receipt: None,
            },
        );
        assert_eq!(
            reserve_terminal_successor(root.path(), &target_identity, || {
                panic!("cleanup claim must close the legacy target's successor slot")
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Closed,
        );
    }

    #[test]
    fn unknown_and_pending_sources_do_not_run_the_successor_allocator() {
        let root = secure_root();
        let pending = ManagedCreateReconcileRequest::new(
            "create-pending",
            "session-pending",
            "workspace-successor",
        )
        .unwrap();
        let unknown = ManagedCreateReconcileRequest::new(
            "create-unknown",
            "session-unknown",
            "workspace-successor",
        )
        .unwrap();
        let called = AtomicBool::new(false);
        assert!(matches!(
            reserve_terminal_successor(root.path(), &unknown, || {
                called.store(true, Ordering::SeqCst);
                ManagedCreateSuccessorIdentity::new(
                    "never-session",
                    "never-create",
                    request_digest(1),
                )
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::NotFound
        ));
        assert!(!called.load(Ordering::SeqCst));

        assert!(matches!(
            reserve(
                root.path(),
                pending.workspace_id(),
                pending.session_id(),
                pending.idempotency_key(),
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
        assert!(matches!(
            reserve_terminal_successor(root.path(), &pending, || {
                called.store(true, Ordering::SeqCst);
                ManagedCreateSuccessorIdentity::new(
                    "never-session",
                    "never-create",
                    request_digest(1),
                )
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Pending
        ));
        assert!(!called.load(Ordering::SeqCst));
    }

    #[test]
    fn unknown_source_bypasses_unrelated_legacy_predecessor_scan() {
        let root = secure_root();
        let unknown = ManagedCreateReconcileRequest::new(
            "create-unknown-scan",
            "session-unknown-scan",
            "workspace-unknown-scan",
        )
        .unwrap();
        let directory = root.path().join(LEDGER_DIRECTORY);
        ensure_private_directory(&directory).unwrap();
        drop(write_legacy_successor_shard_over_old_record_budget(
            &directory,
            0,
            unknown.workspace_id(),
        ));
        let called = AtomicBool::new(false);

        assert!(matches!(
            reserve_terminal_successor(root.path(), &unknown, || {
                called.store(true, Ordering::SeqCst);
                ManagedCreateSuccessorIdentity::new(
                    "never-session",
                    "never-create",
                    request_digest(1),
                )
            })
            .unwrap(),
            ManagedCreateSuccessorLedgerState::NotFound,
        ));
        assert!(!called.load(Ordering::SeqCst));
    }

    fn starting_generation_fixture(provider_process_id: u32) -> ManagedStartingGeneration {
        ManagedStartingGeneration::new(
            "create-1",
            process(101),
            process(provider_process_id),
            ManagedCreateGenerationFence::new("principal-1", "runner-1", 7, "host-1", "terminal-1")
                .unwrap(),
            LocalEndpoint {
                kind: hmux_host::local_discovery::LocalEndpointKind::UnixSocket,
                address: "/tmp/session-1.sock".into(),
            },
            "capability-1",
            Some(ProviderConversationIdentitySeed::new("codex", "conversation-1").unwrap()),
        )
        .unwrap()
    }

    fn create_receipt(root: &Path, terminal_epoch: &str) -> String {
        serde_json::to_string(
            &ManagedCreateReceipt::new(
                "create-1",
                "session-1",
                "workspace-1",
                "codex",
                PermissionMode::Default,
                root,
                ManagedCreateOutcome::Created,
            )
            .unwrap()
            .with_generation_fence(
                ManagedCreateGenerationFence::new(
                    "principal-1",
                    "runner-1",
                    7,
                    "host-1",
                    terminal_epoch,
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn exact_host_starting_checkpoint_is_idempotent_and_completes_once() {
        let root = secure_root();
        let ManagedCreateLedgerState::Prepared(mut broker) = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("first reservation must be prepared")
        };
        broker.checkpoint_pre_spawn_absence().unwrap();
        broker.mark_spawn_reserved(process(101)).unwrap();
        broker.release_with_barrier_proof().unwrap();
        let starting = starting_generation_fixture(202)
            .with_provider_containment(ManagedStartingProviderContainment::PosixSessionV1)
            .unwrap();

        checkpoint_starting_generation_exact(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            starting.clone(),
        )
        .unwrap();
        checkpoint_starting_generation_exact(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            starting.clone(),
        )
        .unwrap();
        assert_eq!(
            starting_generation(root.path(), "workspace-1", "session-1")
                .unwrap()
                .unwrap(),
            starting
        );

        let receipt = create_receipt(root.path(), "terminal-1");
        assert_eq!(broker.complete(receipt.clone()).unwrap(), receipt);
        assert!(matches!(
            reserve(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::Completed(_)
        ));
    }

    #[test]
    fn pending_cleanup_fences_host_starting_checkpoint_before_provider_release() {
        let root = secure_root();
        let request =
            ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1").unwrap();
        let ManagedCreateLedgerState::Prepared(mut broker) = reserve(
            root.path(),
            request.workspace_id(),
            request.session_id(),
            request.idempotency_key(),
            &request_digest(1),
        )
        .unwrap() else {
            panic!("first reservation must be prepared")
        };
        broker.checkpoint_pre_spawn_absence().unwrap();
        broker.mark_spawn_reserved(process(101)).unwrap();
        broker.release_with_barrier_proof().unwrap();

        assert_eq!(
            claim_successor_chain_cleanup(root.path(), &request).unwrap(),
            ManagedCreateSuccessorChainResolution::Pending {
                chain: successor_chain(vec![request.clone()]),
            },
        );

        let mut provider_effect_released = false;
        let checkpoint = checkpoint_starting_generation_exact(
            root.path(),
            request.workspace_id(),
            request.session_id(),
            request.idempotency_key(),
            starting_generation_fixture(202),
        );
        if checkpoint.is_ok() {
            provider_effect_released = true;
        }
        assert_eq!(
            checkpoint.unwrap_err(),
            "hmux_managed_create_retired_exact: cleanup closed this create generation",
        );
        assert!(!provider_effect_released);
        assert_eq!(
            starting_generation(root.path(), request.workspace_id(), request.session_id()).unwrap(),
            None,
        );
    }

    #[test]
    fn starting_checkpoint_and_completion_refuse_changed_generations() {
        let root = secure_root();
        let ManagedCreateLedgerState::Prepared(mut broker) = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("first reservation must be prepared")
        };
        broker.checkpoint_pre_spawn_absence().unwrap();
        broker.mark_spawn_reserved(process(101)).unwrap();
        broker.release_with_barrier_proof().unwrap();
        checkpoint_starting_generation_exact(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            starting_generation_fixture(202),
        )
        .unwrap();

        let checkpoint_error = checkpoint_starting_generation_exact(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            starting_generation_fixture(303),
        )
        .unwrap_err();
        assert!(checkpoint_error.contains("Starting generation changed"));
        let completion_error = broker
            .complete(create_receipt(root.path(), "terminal-changed"))
            .unwrap_err();
        assert!(completion_error.contains("completion changed Starting generation"));
    }

    fn rehost_source_recipe() -> (String, String) {
        let request = ManagedCreateRequest::new(
            "create-1",
            "session-1",
            "workspace-1",
            "codex",
            PermissionMode::BypassApprovals,
            "/tmp",
            vec![
                "/bin/sh".into(),
                "-lc".into(),
                "exec provider --token original-secret".into(),
            ],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(
            hmux_runtime_contract::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
        )
        .unwrap()
        .with_managed_rehost_recipe(
            ManagedRehostRecipe::new(
                vec![
                    "codex".into(),
                    "resume".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                Some("credential-reference-1".into()),
            )
            .unwrap(),
        )
        .unwrap();
        let request_json = serde_json::to_string(&request).unwrap();
        let recipe = ManagedRehostSourceRecipe::from_create_request(&request)
            .unwrap()
            .unwrap();
        (
            crate::recovery_journal::request_fingerprint(&[&request_json]),
            serde_json::to_string(&recipe).unwrap(),
        )
    }

    #[test]
    fn create_admission_persists_only_the_nonsecret_rehost_recipe() {
        let root = secure_root();
        let (digest, recipe) = rehost_source_recipe();

        assert!(matches!(
            reserve_with_rehost_recipe(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &digest,
                Some(&recipe),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
        let recovered = managed_rehost_recipe(root.path(), "workspace-1", "session-1")
            .unwrap()
            .unwrap();
        assert_eq!(recovered.provider_id(), "codex");
        assert_eq!(recovered.permission_mode(), PermissionMode::BypassApprovals);
        assert_eq!(
            recovered.rehost().launch_reference(),
            Some("credential-reference-1")
        );

        let directory = root.path().join(LEDGER_DIRECTORY);
        let ledger = fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| fs::read(entry.path()).ok())
            .flatten()
            .collect::<Vec<_>>();
        assert!(!String::from_utf8_lossy(&ledger).contains("original-secret"));
    }

    #[test]
    fn legacy_create_record_is_not_backfilled_or_guessed() {
        let root = secure_root();
        let digest = request_digest(1);
        assert!(matches!(
            reserve(root.path(), "workspace-1", "session-1", "create-1", &digest,).unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
        assert!(
            managed_rehost_recipe(root.path(), "workspace-1", "session-1")
                .unwrap()
                .is_none()
        );

        let (_, recipe) = rehost_source_recipe();
        assert!(matches!(
            reserve_with_rehost_recipe(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &digest,
                Some(&recipe),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
        assert!(
            managed_rehost_recipe(root.path(), "workspace-1", "session-1")
                .unwrap()
                .is_none(),
            "an exact create retry must not backfill rehost authority"
        );
    }

    #[test]
    fn schema_v2_pending_successor_without_predecessor_is_rejected_without_mutation() {
        let root = secure_root();
        let identity = ManagedCreateReconcileRequest::new(
            "create-impossible-pending",
            "session-impossible-pending",
            "workspace-impossible-pending",
        )
        .unwrap();
        let directory = root.path().join(LEDGER_DIRECTORY);
        let record_key = logical_key(identity.workspace_id(), identity.session_id());
        let index = shard_index(&record_key).unwrap();
        let shard_path = directory.join(format!("shard_{index:02x}.json"));
        write_retained_v2_generation(
            root.path(),
            &identity,
            &request_digest(1),
            ManagedCreateLedgerRecordState::SuccessorLineagePending,
        );
        let impossible = ledger_record(root.path(), &identity);

        let reconcile_error = match reconcile_identity(root.path(), &identity) {
            Err(error) => error,
            Ok(_) => panic!("public reconcile must reject predecessor-free pending state"),
        };
        assert!(reconcile_error.contains("pending successor has no predecessor"));
        assert_eq!(ledger_record(root.path(), &identity), impossible);

        let admission_error = match reserve(
            root.path(),
            identity.workspace_id(),
            identity.session_id(),
            identity.idempotency_key(),
            &request_digest(1),
        ) {
            Err(error) => error,
            Ok(_) => panic!("public admission must reject predecessor-free pending state"),
        };
        assert!(admission_error.contains("pending successor has no predecessor"));
        assert_eq!(ledger_record(root.path(), &identity), impossible);
        assert_eq!(
            read_shard_or_default(&shard_path).unwrap().schema_version,
            LEDGER_SHARD_SCHEMA_VERSION_V2,
            "an invalid retained record must be rejected before its shard is rewritten",
        );
        assert!(!directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists());
    }

    #[test]
    fn prepared_exact_conversation_recovers_its_claim_before_any_spawn() {
        let root = secure_root();
        let digest = request_digest(7);
        let identity =
            ProviderConversationIdentitySeed::new("codex", "conversation-claim").unwrap();
        assert!(matches!(
            reserve(root.path(), "workspace-1", "session-1", "create-1", &digest,).unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));

        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &digest,
                None,
                Some(&identity),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &digest,
                None,
                Some(&identity),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));

        let conflict = match reserve_with_rehost_recipe_and_conversation(
            root.path(),
            "workspace-2",
            "session-2",
            "create-2",
            &request_digest(8),
            None,
            Some(&identity),
        ) {
            Err(error) => error,
            Ok(_) => panic!("a second logical session must not acquire the same conversation"),
        };
        assert_eq!(
            conflict.code(),
            Some(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE)
        );

        let other_provider =
            ProviderConversationIdentitySeed::new("claude", "conversation-claim").unwrap();
        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                "workspace-3",
                "session-3",
                "create-3",
                &request_digest(9),
                None,
                Some(&other_provider),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
    }

    #[test]
    fn checkpointed_reconcile_tombstone_releases_the_exact_conversation_writer() {
        let root = secure_root();
        let digest = request_digest(7);
        let identity =
            ProviderConversationIdentitySeed::new("fixture", "conversation-claim").unwrap();
        let ManagedCreateLedgerState::Prepared(mut initial) =
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &digest,
                None,
                Some(&identity),
            )
            .unwrap()
        else {
            panic!("the exact writer must be prepared")
        };
        initial.checkpoint_pre_spawn_absence().unwrap();
        drop(initial);

        let mismatch_request =
            ManagedCreateReconcileRequest::new("another-create", "session-1", "workspace-1")
                .unwrap();
        let mismatch = match reconcile_identity(root.path(), &mismatch_request) {
            Err(error) => error,
            Ok(_) => panic!("a different idempotency identity must not observe the record"),
        };
        assert!(mismatch.contains("idempotency identity changed"));

        let exact =
            ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1").unwrap();
        let ManagedCreateReconcileLedgerState::PreSpawnAbsenceCheckpointed(mut reservation) =
            reconcile_identity(root.path(), &exact).unwrap()
        else {
            panic!("the exact prepared record must remain intact after a mismatched lookup")
        };
        reservation.abandon_before_completion().unwrap();
        assert!(matches!(
            reconcile_identity(root.path(), &exact).unwrap(),
            ManagedCreateReconcileLedgerState::AbandonedBeforeCompletion
        ));
        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &digest,
                None,
                Some(&identity),
            )
            .unwrap(),
            ManagedCreateLedgerState::Retired
        ));
        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                "workspace-2",
                "session-2",
                "create-2",
                &request_digest(8),
                None,
                Some(&identity),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
    }

    #[test]
    fn released_conversation_writer_is_reserved_for_the_exact_successor() {
        let root = secure_root();
        let workspace_id = "workspace-successor-conversation-handoff";
        let conversation =
            ProviderConversationIdentitySeed::new("fixture", "conversation-successor").unwrap();
        let source = ManagedCreateReconcileRequest::new(
            "create-conversation-source",
            "session-conversation-source",
            workspace_id,
        )
        .unwrap();
        let source_index =
            shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap();
        let target_identity = identity_in_shard(workspace_id, source_index, "conversation-target");
        let target = ManagedCreateSuccessorIdentity::with_target_policy(
            target_identity.session_id(),
            target_identity.idempotency_key(),
            request_digest(2),
            request_digest(2),
            None,
            None,
            Some(conversation.clone()),
        )
        .unwrap();
        let ManagedCreateLedgerState::Prepared(mut source_reservation) =
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                source.workspace_id(),
                source.session_id(),
                source.idempotency_key(),
                &request_digest(1),
                None,
                Some(&conversation),
            )
            .unwrap()
        else {
            panic!("source must be prepared")
        };
        source_reservation.checkpoint_pre_spawn_absence().unwrap();
        source_reservation.abandon_before_completion().unwrap();
        assert_eq!(
            reserve_successor_intent_with_conversation(
                root.path(),
                &source,
                Some(&conversation),
                || Ok(target.clone()),
            )
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Created(target.clone())
        );

        let competitor = ManagedCreateReconcileRequest::new(
            "create-conversation-competitor",
            "session-conversation-competitor",
            workspace_id,
        )
        .unwrap();
        let conflict = admission_error(reserve_with_rehost_recipe_and_conversation(
            root.path(),
            competitor.workspace_id(),
            competitor.session_id(),
            competitor.idempotency_key(),
            &request_digest(3),
            None,
            Some(&conversation),
        ));
        assert_eq!(
            conflict.code(),
            Some(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE)
        );

        assert!(matches!(
            reserve_successor_with_rehost_recipe_and_conversation(
                root.path(),
                source.workspace_id(),
                target.session_id(),
                target.idempotency_key(),
                &target.request_digest,
                None,
                Some(&conversation),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
    }

    #[test]
    fn successor_publish_holds_the_conversation_claim_against_a_racing_root() {
        let root = secure_root();
        let workspace_id = "workspace-successor-conversation-advance-first";
        let ConversationSuccessorFixture {
            conversation,
            source,
            target,
            source_index,
        } = abandoned_conversation_successor_fixture(
            root.path(),
            workspace_id,
            "conversation-advance-first",
            "advance-first-target",
        );
        let competing = identity_in_shard(
            workspace_id,
            (source_index + 1) % LEDGER_SHARDS,
            "advance-first-root",
        );

        let (allocation_started_tx, allocation_started_rx) = mpsc::channel();
        let (resume_advance_tx, resume_advance_rx) = mpsc::channel();
        let advance_root = root.path().to_path_buf();
        let advance_source = source.clone();
        let advance_target = target.clone();
        let advance_conversation = conversation.clone();
        let advance = thread::spawn(move || {
            reserve_successor_intent_with_conversation(
                &advance_root,
                &advance_source,
                Some(&advance_conversation),
                || {
                    allocation_started_tx.send(()).unwrap();
                    resume_advance_rx.recv().unwrap();
                    Ok(advance_target.clone())
                },
            )
        });
        allocation_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("advance must reach allocation while owning its admission locks");

        let (root_result_tx, root_result_rx) = mpsc::channel();
        let (root_lock_attempt_tx, root_lock_attempt_rx) = mpsc::channel();
        let competing_root = root.path().to_path_buf();
        let competing_conversation = conversation.clone();
        let competing_thread = thread::spawn(move || {
            let result = reserve_with_lineage_admission_with_hooks(
                &competing_root,
                (
                    competing.workspace_id(),
                    competing.session_id(),
                    competing.idempotency_key(),
                ),
                &request_digest(3),
                ManagedCreateLineageContext {
                    canonical_rehost_recipe: None,
                    conversation_identity: Some(&competing_conversation),
                    admission: ManagedCreateLineageAdmission::Root,
                },
                || root_lock_attempt_tx.send(()).unwrap(),
                || Ok(()),
            );
            root_result_tx.send(result).unwrap();
        });
        root_lock_attempt_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("Root contender must reach the conversation lock attempt");
        assert!(
            matches!(
                root_result_rx.recv_timeout(Duration::from_millis(250)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "a Root claim must wait while successor publication owns the conversation shard",
        );
        resume_advance_tx.send(()).unwrap();
        assert_eq!(
            advance.join().unwrap().unwrap(),
            ManagedCreateSuccessorLedgerState::Created(target),
        );
        let competing_result = root_result_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let conflict = admission_error(competing_result);
        assert_eq!(
            conflict.code(),
            Some(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE)
        );
        competing_thread.join().unwrap();
    }

    #[test]
    fn successor_publish_refuses_a_root_claim_that_won_the_conversation_shard() {
        let root = secure_root();
        let workspace_id = "workspace-successor-conversation-root-first";
        let ConversationSuccessorFixture {
            conversation,
            source,
            target,
            source_index,
        } = abandoned_conversation_successor_fixture(
            root.path(),
            workspace_id,
            "conversation-root-first",
            "root-first-target",
        );
        let competing = identity_in_shard(
            workspace_id,
            (source_index + 1) % LEDGER_SHARDS,
            "root-first-winner",
        );
        let competing_digest = request_digest(3);

        let (root_published_tx, root_published_rx) = mpsc::channel();
        let (resume_root_tx, resume_root_rx) = mpsc::channel();
        let competing_root = root.path().to_path_buf();
        let competing_conversation = conversation.clone();
        let competing_for_thread = competing.clone();
        let root_thread = thread::spawn(move || {
            reserve_with_lineage_admission_with_interleave(
                &competing_root,
                competing_for_thread.workspace_id(),
                competing_for_thread.session_id(),
                competing_for_thread.idempotency_key(),
                &competing_digest,
                ManagedCreateLineageContext {
                    canonical_rehost_recipe: None,
                    conversation_identity: Some(&competing_conversation),
                    admission: ManagedCreateLineageAdmission::Root,
                },
                || {
                    root_published_tx.send(()).unwrap();
                    resume_root_rx.recv().unwrap();
                    Ok(())
                },
            )
        });
        root_published_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("Root must pause after publishing while its claim lock remains held");

        let (conversation_lock_attempt_tx, conversation_lock_attempt_rx) = mpsc::channel();
        let (allocation_started_tx, allocation_started_rx) = mpsc::channel();
        let advance_root = root.path().to_path_buf();
        let advance_source = source.clone();
        let advance_target = target.clone();
        let advance_conversation = conversation.clone();
        let advance = thread::spawn(move || {
            reserve_successor_intent_with_conversation_and_lock_attempt(
                &advance_root,
                &advance_source,
                Some(&advance_conversation),
                || conversation_lock_attempt_tx.send(()).unwrap(),
                || {
                    allocation_started_tx.send(()).unwrap();
                    Ok(advance_target.clone())
                },
            )
        });
        conversation_lock_attempt_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("advance contender must reach the conversation lock attempt");
        let advanced_while_root_held = allocation_started_rx
            .recv_timeout(Duration::from_millis(250))
            .is_ok();
        resume_root_tx.send(()).unwrap();
        assert!(matches!(
            root_thread.join().unwrap().unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
        let advance_error = advance.join().unwrap().unwrap_err();
        assert!(
            !advanced_while_root_held,
            "successor allocation must wait for the conversation-first Root transaction",
        );
        assert_eq!(
            advance_error.code(),
            Some(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE)
        );
        assert!(matches!(
            ledger_record(root.path(), &source)
                .authority
                .expect("current source must retain v3 authority")
                .successor,
            ManagedCreateSuccessorSlotV3::Vacant,
        ));
    }

    #[test]
    fn existing_successor_replay_reports_durable_edge_with_unrelated_conversation_claim() {
        let root = secure_root();
        let workspace_id = "workspace-successor-conversation-existing-conflict";
        let ConversationSuccessorFixture {
            conversation,
            source,
            target,
            source_index,
        } = abandoned_conversation_successor_fixture(
            root.path(),
            workspace_id,
            "conversation-existing-conflict",
            "existing-conflict-target",
        );
        let competing = identity_in_shard(
            workspace_id,
            (source_index + 1) % LEDGER_SHARDS,
            "existing-conflict-root",
        );
        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                competing.workspace_id(),
                competing.session_id(),
                competing.idempotency_key(),
                &request_digest(3),
                None,
                Some(&conversation),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_),
        ));

        let ManagedCreateSuccessorInspection::Found {
            slot: ManagedCreateSuccessorSlot::Vacant(mut reservation),
            ..
        } = inspect_successor_node(root.path(), &source, None).unwrap()
        else {
            panic!("the released source must still expose its vacant successor slot")
        };
        publish_successor_candidate(&mut reservation, &source, &target, || Ok(())).unwrap();
        drop(reservation);

        let allocations = AtomicUsize::new(0);
        let replay = reserve_successor_intent_with_conversation(
            root.path(),
            &source,
            Some(&conversation),
            || {
                allocations.fetch_add(1, Ordering::SeqCst);
                Ok(target.clone())
            },
        )
        .unwrap();
        let ManagedCreateSuccessorLedgerState::ExistingUnavailable { successor, error } = replay
        else {
            panic!("an unavailable replay must retain the durable successor edge")
        };
        assert_eq!(successor, target);
        assert_eq!(
            error.code(),
            Some(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE)
        );
        assert_eq!(allocations.load(Ordering::SeqCst), 0);
        assert!(matches!(
            ledger_record(root.path(), &source)
                .authority
                .expect("source must retain direct lineage")
                .successor,
            ManagedCreateSuccessorSlotV3::Intent { .. },
        ));
    }

    #[test]
    fn only_same_idempotency_canonical_digest_conflict_has_the_reconcile_code() {
        let root = secure_root();
        let identity = ProviderConversationIdentitySeed::new("codex", "conversation-1").unwrap();
        let (_, recipe) = rehost_source_recipe();
        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &request_digest(1),
                Some(&recipe),
                Some(&identity),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));

        let digest_conflict = admission_error(reserve_with_rehost_recipe_and_conversation(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(2),
            Some(&recipe),
            Some(&identity),
        ));
        assert!(matches!(
            digest_conflict,
            ManagedCreateAdmissionError::CanonicalRequestDigestConflict
        ));
        assert_eq!(
            digest_conflict.code(),
            Some(hmux_runtime_contract::MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE)
        );

        let changed_conversation = admission_error(reserve_with_rehost_recipe_and_conversation(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(2),
            Some(&recipe),
            Some(&ProviderConversationIdentitySeed::new("codex", "conversation-2").unwrap()),
        ));
        assert_eq!(changed_conversation.code(), None);
        assert!(matches!(
            &changed_conversation,
            ManagedCreateAdmissionError::CanonicalConversationIdentityConflict
        ));
        assert!(changed_conversation.canonical_source_changed());
        assert!(
            changed_conversation
                .to_string()
                .contains("conversation identity changed")
        );

        let changed_recipe = recipe.replace("credential-reference-1", "credential-reference-2");
        let recipe_conflict = admission_error(reserve_with_rehost_recipe_and_conversation(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
            Some(&changed_recipe),
            Some(&identity),
        ));
        assert_eq!(recipe_conflict.code(), None);
        assert!(matches!(
            &recipe_conflict,
            ManagedCreateAdmissionError::CanonicalRehostRecipeConflict
        ));
        assert!(recipe_conflict.canonical_source_changed());
        assert!(
            recipe_conflict
                .to_string()
                .contains("rehost recipe changed")
        );

        let key_conflict = admission_error(reserve_with_rehost_recipe_and_conversation(
            root.path(),
            "workspace-1",
            "session-1",
            "create-2",
            &request_digest(2),
            Some(&recipe),
            Some(&identity),
        ));
        assert_eq!(key_conflict.code(), None);
    }

    #[test]
    fn starting_generation_reconcile_is_pending_and_preserves_the_record() {
        let root = secure_root();
        let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("the first reservation must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.mark_spawn_reserved(process(101)).unwrap();
        reservation.release_with_barrier_proof().unwrap();
        checkpoint_starting_generation_exact(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            starting_generation_fixture(202),
        )
        .unwrap();
        let request =
            ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1").unwrap();

        let ManagedCreateReconcileLedgerState::LaunchReleased {
            starting_generation: Some(reconciled),
            ..
        } = reconcile_identity(root.path(), &request).unwrap()
        else {
            panic!("Starting evidence must remain a typed launch-release state")
        };
        assert_eq!(reconciled.provider_process(), &process(202));
        assert_eq!(
            starting_generation(root.path(), "workspace-1", "session-1")
                .unwrap()
                .unwrap()
                .provider_process(),
            &process(202)
        );
    }

    #[test]
    fn exact_retry_refuses_a_changed_claim_owner_fingerprint() {
        let root = secure_root();
        let digest = request_digest(7);
        let identity =
            ProviderConversationIdentitySeed::new("codex", "conversation-claim").unwrap();
        assert!(matches!(
            reserve_with_rehost_recipe_and_conversation(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &digest,
                None,
                Some(&identity),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));

        let directory = root.path().join(LEDGER_DIRECTORY);
        let claim_key = conversation_writer_key(&identity);
        let shard_path = directory.join(format!(
            "conversation_writer_{:02x}.json",
            shard_index(&claim_key).unwrap()
        ));
        let mut shard = read_conversation_writer_shard_or_default(&shard_path).unwrap();
        shard
            .claims
            .get_mut(&claim_key)
            .unwrap()
            .owner
            .request_digest = request_digest(8);
        write_conversation_writer_shard(&directory, &shard_path, &shard).unwrap();

        let error = match reserve_with_rehost_recipe_and_conversation(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &digest,
            None,
            Some(&identity),
        ) {
            Err(error) => error,
            Ok(_) => panic!("a changed owner fingerprint must not be repaired or replaced"),
        };
        assert_eq!(error.code(), None);
        assert_eq!(
            error.to_string(),
            "hmux_managed_conversation_writer_invalid: claim owner changed"
        );
        assert_eq!(
            read_conversation_writer_shard_or_default(&shard_path)
                .unwrap()
                .claims
                .get(&claim_key)
                .unwrap()
                .owner
                .request_digest,
            request_digest(8),
            "admission must leave conflicting durable evidence untouched"
        );
    }

    fn complete_generation(root: &Path) -> ManagedStopReceipt {
        let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
            root,
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("first reservation must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.mark_spawn_reserved(process(101)).unwrap();
        reservation.release_with_barrier_proof().unwrap();
        let create = ManagedCreateReceipt::new(
            "create-1",
            "session-1",
            "workspace-1",
            "codex",
            PermissionMode::Default,
            root,
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new("principal-1", "runner-1", 7, "host-1", "terminal-1")
                .unwrap(),
        )
        .unwrap();
        reservation
            .complete(serde_json::to_string(&create).unwrap())
            .unwrap();
        let stop =
            hmux_runtime_contract::ManagedStopRequest::new("stop-1", "session-1", "workspace-1")
                .unwrap()
                .with_expected_fence("principal-1", "runner-1", 7, "host-1", "terminal-1")
                .unwrap();
        ManagedStopReceipt::from_request(
            &stop,
            ManagedStopOutcome::Stopped,
            "managed_provider_stopped",
        )
        .unwrap()
    }

    #[test]
    fn exact_completed_receipt_replay_does_not_mutate_covered_ledger() {
        let root = secure_root();
        complete_generation(root.path());
        let directory = root.path().join(LEDGER_DIRECTORY);
        let entries_before = fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| {
                let metadata = entry.metadata().unwrap();
                (
                    entry.file_name(),
                    (
                        metadata.dev(),
                        metadata.ino(),
                        metadata.size(),
                        metadata.mtime(),
                        metadata.mtime_nsec(),
                    ),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let ManagedCreateLedgerState::Completed(_) = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("completion must replay")
        };
        assert_eq!(
            fs::read_dir(&directory)
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| {
                    let metadata = entry.metadata().unwrap();
                    (
                        entry.file_name(),
                        (
                            metadata.dev(),
                            metadata.ino(),
                            metadata.size(),
                            metadata.mtime(),
                            metadata.mtime_nsec(),
                        ),
                    )
                })
                .collect::<BTreeMap<_, _>>(),
            entries_before,
            "an exact replay must not rewrite or allocate covered ledger files",
        );
        assert_eq!(
            (0..LEDGER_SHARDS)
                .filter(|index| directory.join(format!("shard_{index:02x}.json")).exists())
                .count(),
            LEDGER_SHARDS,
            "coverage permanently materializes every create shard as the v3 writer fence",
        );
        assert!(directory.join(SUCCESSOR_PREDECESSOR_COVERAGE_FILE).exists());
    }

    #[test]
    fn completed_create_receipt_reads_exact_live_authority_without_reserving() {
        let root = secure_root();
        complete_generation(root.path());

        let receipt = completed_create_receipt(root.path(), "workspace-1", "session-1")
            .unwrap()
            .expect("completed live create must be readable");

        assert_eq!(receipt.idempotency_key(), "create-1");
        assert_eq!(receipt.session_id(), "session-1");
        assert_eq!(receipt.workspace_id(), "workspace-1");
        assert_eq!(
            receipt
                .generation_fence()
                .expect("complete create requires its fence")
                .terminal_epoch(),
            "terminal-1"
        );
    }

    #[test]
    fn completed_create_receipt_hides_retired_generation() {
        let root = secure_root();
        let stop = complete_generation(root.path());
        checkpoint_retirement_exact(root.path(), &stop).unwrap();
        finalize_retirement_exact(root.path(), &stop).unwrap();

        assert!(
            completed_create_receipt(root.path(), "workspace-1", "session-1")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn historical_create_receipt_preserves_identity_across_retirement_without_live_authority() {
        let root = secure_root();
        let stop = complete_generation(root.path());
        let original = completed_create_receipt(root.path(), "workspace-1", "session-1")
            .unwrap()
            .unwrap();
        assert_eq!(
            historical_create_receipt(root.path(), "workspace-1", "session-1").unwrap(),
            Some(original.clone())
        );
        checkpoint_retirement_exact(root.path(), &stop).unwrap();
        assert!(
            completed_create_receipt(root.path(), "workspace-1", "session-1")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            historical_create_receipt(root.path(), "workspace-1", "session-1").unwrap(),
            Some(original.clone())
        );
        finalize_retirement_exact(root.path(), &stop).unwrap();
        assert!(
            completed_create_receipt(root.path(), "workspace-1", "session-1")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            historical_create_receipt(root.path(), "workspace-1", "session-1").unwrap(),
            Some(original)
        );
        assert!(
            historical_create_receipt(root.path(), "workspace-1", "another-session")
                .unwrap()
                .is_none()
        );
        assert!(
            historical_create_receipt(root.path(), "another-workspace", "session-1")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn session_retirement_observation_uses_the_permanent_owner_without_discovery() {
        use ManagedSessionRetirementObservation::{Finalized, NoLedger, NotFinalized};

        let root = secure_root();
        let observe = || observe_session_retirement(root.path(), "workspace-1", "session-1");
        assert_eq!(observe().unwrap(), NoLedger);
        assert!(!root.path().join(LEDGER_DIRECTORY).exists());
        let receipt = complete_generation(root.path());
        assert_eq!(observe().unwrap(), NotFinalized);
        checkpoint_retirement_exact(root.path(), &receipt).unwrap();
        assert_eq!(observe().unwrap(), NotFinalized);
        finalize_retirement_exact(root.path(), &receipt).unwrap();
        let expected = Finalized {
            receipt: Box::new(receipt.clone()),
        };
        let (_, shard_path) = shard_paths(
            &root.path().join(LEDGER_DIRECTORY),
            &logical_key("workspace-1", "session-1"),
        )
        .unwrap();
        let before = fs::read(&shard_path).unwrap();
        assert!(!root.path().join(".recovery").exists());
        assert!(
            !root
                .path()
                .join(
                    SessionLookupKey::new("workspace-1", "session-1")
                        .unwrap()
                        .relative_path()
                )
                .exists()
        );
        for _ in 0..2 {
            assert_eq!(
                crate::LocalSessionCatalog::new(root.path())
                    .read_managed_session_retirement("session-1", "workspace-1")
                    .unwrap(),
                expected
            );
        }
        assert_eq!(fs::read(&shard_path).unwrap(), before);
        assert_eq!(
            serde_json::to_value(&expected).unwrap(),
            serde_json::json!({"kind": "finalized", "receipt": receipt})
        );
        assert_eq!(
            closed_retired_chain(
                root.path(),
                &ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1")
                    .unwrap(),
            )
            .unwrap(),
            None,
            "observing exact retirement must not close a logical successor slot"
        );
        assert_eq!(
            observe_session_retirement(root.path(), "another-workspace", "session-1").unwrap(),
            NoLedger
        );
        assert_eq!(
            observe_session_retirement(root.path(), "workspace-1", "another-session").unwrap(),
            NoLedger
        );
    }

    #[test]
    fn session_retirement_observation_refuses_competing_final_and_unfinished_owners() {
        let canonical = secure_root();
        let compatibility = secure_root();
        let receipt = complete_generation(compatibility.path());
        checkpoint_retirement_exact(compatibility.path(), &receipt).unwrap();
        finalize_retirement_exact(compatibility.path(), &receipt).unwrap();
        let catalog = crate::LocalSessionCatalog::with_read_only_discovery_roots(
            canonical.path(),
            vec![compatibility.path().to_path_buf()],
        )
        .unwrap();
        assert_eq!(
            catalog
                .read_managed_session_retirement("session-1", "workspace-1")
                .unwrap(),
            ManagedSessionRetirementObservation::Finalized {
                receipt: Box::new(receipt),
            }
        );
        assert!(!canonical.path().join(LEDGER_DIRECTORY).exists());
        complete_generation(canonical.path());
        assert!(
            catalog
                .read_managed_session_retirement("session-1", "workspace-1")
                .unwrap_err()
                .to_string()
                .contains("competing discovery")
        );
    }

    #[test]
    fn session_retirement_observation_refuses_receipts_outside_the_recorded_generation() {
        for field in [
            "sessionId",
            "workspaceId",
            "runnerPrincipal",
            "runnerInstance",
            "channelEpoch",
            "hostInstanceId",
            "terminalEpoch",
        ] {
            let root = secure_root();
            let receipt = complete_generation(root.path());
            checkpoint_retirement_exact(root.path(), &receipt).unwrap();
            finalize_retirement_exact(root.path(), &receipt).unwrap();
            let (_, shard_path) = shard_paths(
                &root.path().join(LEDGER_DIRECTORY),
                &logical_key("workspace-1", "session-1"),
            )
            .unwrap();
            let mut shard = read_shard_or_default(&shard_path).unwrap();
            let record = shard
                .records
                .get_mut(&logical_key("workspace-1", "session-1"))
                .unwrap();
            let ManagedCreateLedgerRecordState::Completed {
                retiring_stop_receipt,
                ..
            } = &mut record.state
            else {
                panic!("fixture must retain its completed creation");
            };
            let mut corrupted = serde_json::to_value(receipt).unwrap();
            corrupted[field] = if field == "channelEpoch" {
                8.into()
            } else {
                format!("wrong-{field}").into()
            };
            *retiring_stop_receipt = Some(serde_json::to_string(&corrupted).unwrap());
            fs::write(&shard_path, serde_json::to_vec(&shard).unwrap()).unwrap();
            let before = fs::read(&shard_path).unwrap();
            assert!(
                observe_session_retirement(root.path(), "workspace-1", "session-1").is_err(),
                "changed {field} must not become authoritative retirement evidence"
            );
            assert_eq!(fs::read(&shard_path).unwrap(), before);
        }
    }

    #[test]
    fn retired_generation_keeps_its_final_exact_stop_receipt() {
        let root = secure_root();
        let stop = complete_generation(root.path());
        checkpoint_retirement_exact(root.path(), &stop).unwrap();
        finalize_retirement_exact(root.path(), &stop).unwrap();
        let reconcile = ManagedStopReconcileRequest::from_stop_request(
            &hmux_runtime_contract::ManagedStopRequest::new(
                stop.stop_id(),
                stop.session_id(),
                stop.workspace_id(),
            )
            .unwrap()
            .with_expected_fence(
                stop.runner_principal(),
                stop.runner_instance(),
                stop.channel_epoch(),
                stop.host_instance_id(),
                stop.terminal_epoch(),
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            final_stop_receipt(root.path(), &reconcile).unwrap(),
            Some(stop.clone())
        );
        assert_eq!(
            crate::recovery_journal::managed_stop::read_completed(root.path(), &reconcile).unwrap(),
            Some(stop)
        );

        let other_operation = ManagedStopReconcileRequest::from_stop_request(
            &hmux_runtime_contract::ManagedStopRequest::new(
                "another-stop-operation",
                "session-1",
                "workspace-1",
            )
            .unwrap()
            .with_expected_fence("principal-1", "runner-1", 7, "host-1", "terminal-1")
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            final_stop_receipt(root.path(), &other_operation).unwrap(),
            None,
            "a receipt owned by another stop operation is not a reconcile match"
        );
        assert_eq!(
            crate::recovery_journal::managed_stop::read_completed(root.path(), &other_operation)
                .unwrap(),
            None
        );
    }

    #[test]
    fn final_retirement_is_readable_before_stop_journal_completion() {
        use crate::recovery_journal::{RecoveryReservationState, managed_stop, reserve_prepared};

        let root = secure_root();
        let receipt = complete_generation(root.path());
        let request = hmux_runtime_contract::ManagedStopRequest::new(
            receipt.stop_id(),
            receipt.session_id(),
            receipt.workspace_id(),
        )
        .unwrap()
        .with_expected_fence(
            receipt.runner_principal(),
            receipt.runner_instance(),
            receipt.channel_epoch(),
            receipt.host_instance_id(),
            receipt.terminal_epoch(),
        )
        .unwrap();
        let identity = managed_stop::identity(
            receipt.stop_id(),
            receipt.session_id(),
            receipt.workspace_id(),
        );
        let RecoveryReservationState::Pending(mut reservation) = reserve_prepared(
            root.path(),
            identity,
            Some(serde_json::to_string(&request).unwrap()),
        )
        .unwrap() else {
            panic!("fixture must retain a pending stop journal");
        };
        reservation
            .checkpoint_source_stop_receipt(serde_json::to_string(&receipt).unwrap())
            .unwrap();
        checkpoint_retirement_exact(root.path(), &receipt).unwrap();
        let reconciliation = ManagedStopReconcileRequest::from_stop_request(&request).unwrap();
        assert_eq!(
            managed_stop::read_completed(root.path(), &reconciliation).unwrap(),
            None,
            "a checkpoint is not final retirement"
        );
        let journal_before = fs::read(reservation.record_path.as_ref()).unwrap();
        finalize_retirement_exact(root.path(), &receipt).unwrap();
        for _ in 0..2 {
            assert_eq!(
                managed_stop::read_completed(root.path(), &reconciliation).unwrap(),
                Some(receipt.clone()),
                "the final ledger receipt survives a crash before journal completion"
            );
        }
        assert_eq!(
            fs::read(reservation.record_path.as_ref()).unwrap(),
            journal_before,
            "completion observation must not advance the pending journal"
        );
    }

    #[test]
    fn archived_untouched_guard_receipt_does_not_block_gc_inventory() {
        let root = secure_root();
        let stop = complete_generation(root.path());
        checkpoint_retirement_exact(root.path(), &stop).unwrap();

        let directory = root.path().join(LEDGER_DIRECTORY);
        let record_key = logical_key("workspace-1", "session-1");
        let (_, shard_path) = shard_paths(&directory, &record_key).unwrap();
        let mut shard = read_shard_or_default(&shard_path).unwrap();
        let record = shard.records.get_mut(&record_key).unwrap();
        let ManagedCreateLedgerRecordState::Completed {
            retiring_stop_receipt: Some(serialized),
            ..
        } = &mut record.state
        else {
            panic!("checkpointed retirement must retain its exact stop receipt")
        };
        let mut archived = serde_json::from_str::<serde_json::Value>(serialized).unwrap();
        archived["schemaVersion"] = serde_json::json!(3);
        archived["requireUntouchedAgent"] = serde_json::json!(true);
        *serialized = serde_json::to_string(&archived).unwrap();
        write_shard(&directory, &shard_path, &shard).unwrap();

        let protected = pending_session_paths(root.path()).unwrap();
        assert_eq!(
            protected,
            BTreeSet::from([SessionLookupKey::new("workspace-1", "session-1")
                .unwrap()
                .relative_path(),]),
            "a retired protocol guard must not make the complete ledger unreadable",
        );
        assert_eq!(
            finalize_retirement_exact(root.path(), &stop).unwrap(),
            ManagedCreateRetirement::Exact,
        );
    }

    #[test]
    fn completed_unretired_gc_protection_requires_a_valid_full_fence() {
        let root = secure_root();
        complete_generation(root.path());
        let directory = root.path().join(LEDGER_DIRECTORY);
        let record_key = logical_key("workspace-1", "session-1");
        let (_, shard_path) = shard_paths(&directory, &record_key).unwrap();
        let original = read_shard_or_default(&shard_path).unwrap();

        let mut missing_fence = original.clone();
        let record = missing_fence.records.get_mut(&record_key).unwrap();
        let ManagedCreateLedgerRecordState::Completed { receipt, .. } = &mut record.state else {
            panic!("fixture must complete its create record")
        };
        let mut value: serde_json::Value = serde_json::from_str(receipt).unwrap();
        value.as_object_mut().unwrap().remove("generationFence");
        *receipt = serde_json::to_string(&value).unwrap();
        write_shard(&directory, &shard_path, &missing_fence).unwrap();
        let error = pending_session_paths(root.path()).unwrap_err();
        assert!(error.contains("has no generation fence"), "{error}");

        let mut malformed = original;
        let record = malformed.records.get_mut(&record_key).unwrap();
        let ManagedCreateLedgerRecordState::Completed { receipt, .. } = &mut record.state else {
            panic!("fixture must complete its create record")
        };
        *receipt = "{}".to_string();
        write_shard(&directory, &shard_path, &malformed).unwrap();
        let error = pending_session_paths(root.path()).unwrap_err();
        assert!(error.contains("receipt is malformed"), "{error}");
    }

    #[test]
    fn unsupported_archived_stop_receipt_stays_fail_closed() {
        let root = secure_root();
        let stop = complete_generation(root.path());
        let mut archived = serde_json::to_value(stop).unwrap();
        archived["schemaVersion"] = serde_json::json!(3);
        archived["requireUntouchedAgent"] = serde_json::json!(false);

        let error =
            decode_persisted_stop_receipt(&serde_json::to_string(&archived).unwrap(), "malformed")
                .unwrap_err();
        assert!(error.contains("unsupported schema"), "{error}");
    }

    #[test]
    fn exact_stop_retires_a_pre_ledger_generation_without_reopening_create() {
        let root = secure_root();
        let ManagedCreateLedgerState::Prepared(mut stale_creator) = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("pre-ledger adoption attempt must remain prepared")
        };
        let stop = ManagedStopReceipt::from_request(
            &hmux_runtime_contract::ManagedStopRequest::new(
                "stop-pre-ledger",
                "session-1",
                "workspace-1",
            )
            .unwrap()
            .with_expected_fence("principal-1", "runner-1", 7, "host-1", "terminal-1")
            .unwrap(),
            ManagedStopOutcome::Stopped,
            "managed_provider_stopped",
        )
        .unwrap();

        let direct_finalize = finalize_retirement_exact(root.path(), &stop)
            .expect_err("a prepared predecessor must checkpoint its exact stop first");
        assert!(
            direct_finalize.contains("retirement was not checkpointed"),
            "{direct_finalize}",
        );
        assert_eq!(
            checkpoint_retirement_exact(root.path(), &stop).unwrap(),
            ManagedCreateRetirement::Exact,
        );
        assert!(
            stale_creator.mark_spawn_reserved(process(101)).is_err(),
            "a concurrent prepared creator must lose once exact retirement is durable",
        );
        finalize_retirement_exact(root.path(), &stop).unwrap();
        assert!(matches!(
            reserve(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::Retired,
        ));

        let changed = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "changed-create",
            &request_digest(2),
        )
        .err()
        .expect("retired pre-ledger identity must never accept another launch");
        assert!(changed.contains("idempotency_conflict"), "{changed}");
    }

    #[test]
    fn logical_session_never_retargets_a_changed_request() {
        let root = secure_root();
        let stop = complete_generation(root.path());
        checkpoint_retirement_exact(root.path(), &stop).unwrap();
        finalize_retirement_exact(root.path(), &stop).unwrap();
        for digest in [request_digest(2), request_digest(3), request_digest(1)] {
            let key = if digest == request_digest(1) {
                "changed-idempotency"
            } else {
                "create-successor"
            };
            let error = match reserve(root.path(), "workspace-1", "session-1", key, &digest) {
                Err(error) => error,
                Ok(_) => panic!("retired logical session must never retarget"),
            };
            assert!(error.contains("idempotency_conflict"), "{error}");
        }
        assert!(matches!(
            reserve(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::Retired
        ));
    }

    #[test]
    fn spawn_reservation_and_launch_release_are_distinct_durable_states() {
        let root = secure_root();
        let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("first reservation must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.mark_spawn_reserved(process(101)).unwrap();
        drop(reservation);
        assert!(matches!(
            reserve(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::SpawnReserved { .. }
        ));
        let ManagedCreateLedgerState::SpawnReserved {
            mut reservation, ..
        } = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap()
        else {
            panic!("spawn reservation must replay")
        };
        reservation.release_with_barrier_proof().unwrap();
        drop(reservation);
        assert!(matches!(
            reconcile_identity(
                root.path(),
                &ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1",)
                    .unwrap(),
            )
            .unwrap(),
            ManagedCreateReconcileLedgerState::LaunchReleased {
                provider_release_guard: true,
                ..
            }
        ));
    }

    #[test]
    fn release_guard_is_durable_before_launch_release_record() {
        let root = secure_root();
        let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("first reservation must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.mark_spawn_reserved(process(101)).unwrap();

        let directory = root.path().join(LEDGER_DIRECTORY);
        let record_key = logical_key("workspace-1", "session-1");
        let index = shard_index(&record_key).unwrap();
        let ledger_temporary = directory.join(format!(".shard_{index:02x}.tmp"));
        fs::create_dir(&ledger_temporary).unwrap();

        assert!(reservation.release_with_barrier_proof().is_err());
        let record = ledger_record(
            root.path(),
            &ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1").unwrap(),
        );
        assert!(matches!(
            record.state,
            ManagedCreateLedgerRecordState::SpawnReserved { .. }
        ));
        let guards = read_provider_release_guard_shard_or_default(&provider_release_guard_path(
            &directory, index,
        ))
        .unwrap();
        assert!(guards.records.contains_key(&record_key));

        fs::remove_dir(&ledger_temporary).unwrap();
        reservation.release_with_barrier_proof().unwrap();
        assert!(matches!(
            reconcile_identity(
                root.path(),
                &ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1",)
                    .unwrap(),
            )
            .unwrap(),
            ManagedCreateReconcileLedgerState::LaunchReleased {
                provider_release_guard: true,
                ..
            }
        ));
    }

    #[test]
    fn guardless_legacy_launch_release_never_inherits_a_stale_guard() {
        let root = secure_root();
        let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("first reservation must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.mark_spawn_reserved(process(101)).unwrap();
        reservation.release_with_barrier_proof().unwrap();
        reservation
            .reset_after_definite_pre_ready_failure()
            .unwrap();
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.mark_spawn_reserved(process(102)).unwrap();
        let mut legacy_release = reservation.record.clone();
        legacy_release.state = ManagedCreateLedgerRecordState::LaunchReleased {
            host_process: process(102),
            starting_generation: None,
        };
        reservation.publish_forward(legacy_release).unwrap();
        assert!(matches!(
            reconcile_identity(
                root.path(),
                &ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1",)
                    .unwrap(),
            )
            .unwrap(),
            ManagedCreateReconcileLedgerState::LaunchReleased {
                provider_release_guard: false,
                ..
            }
        ));
    }

    #[test]
    fn unrelated_reservations_in_one_shard_do_not_hold_the_publish_lock() {
        let root = secure_root();
        let mut first_by_shard = BTreeMap::<usize, String>::new();
        let (first_session, second_session) = (0..=LEDGER_SHARDS)
            .find_map(|index| {
                let session = format!("colliding-session-{index}");
                let shard = shard_index(&logical_key("workspace-1", &session)).unwrap();
                first_by_shard
                    .insert(shard, session.clone())
                    .map(|first| (first, session))
            })
            .expect("pigeonhole principle must find one fixed-shard collision");
        let ManagedCreateLedgerState::Prepared(first) = reserve(
            root.path(),
            "workspace-1",
            &first_session,
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("first reservation must be prepared")
        };
        let ManagedCreateLedgerState::Prepared(second) = reserve(
            root.path(),
            "workspace-1",
            &second_session,
            "create-2",
            &request_digest(2),
        )
        .unwrap() else {
            panic!("same-shard reservation must not be blocked by unrelated provider startup")
        };
        drop((first, second));
    }

    #[test]
    fn concurrent_exact_completions_converge_on_the_first_canonical_receipt() {
        let root = secure_root();
        let ManagedCreateLedgerState::Prepared(mut creator) = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap() else {
            panic!("first reservation must be prepared")
        };
        creator.checkpoint_pre_spawn_absence().unwrap();
        creator.mark_spawn_reserved(process(101)).unwrap();
        creator.release_with_barrier_proof().unwrap();
        let ManagedCreateLedgerState::LaunchReleased {
            reservation: mut reuser,
            ..
        } = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .unwrap()
        else {
            panic!("concurrent retry must observe launch release")
        };
        let receipt = |outcome| {
            ManagedCreateReceipt::new(
                "create-1",
                "session-1",
                "workspace-1",
                "codex",
                PermissionMode::Default,
                root.path(),
                outcome,
            )
            .unwrap()
            .with_generation_fence(
                ManagedCreateGenerationFence::new(
                    "principal-1",
                    "runner-1",
                    7,
                    "host-1",
                    "terminal-1",
                )
                .unwrap(),
            )
            .unwrap()
        };
        let reused = serde_json::to_string(&receipt(ManagedCreateOutcome::Reused)).unwrap();
        let created = serde_json::to_string(&receipt(ManagedCreateOutcome::Created)).unwrap();

        assert_eq!(reuser.complete(reused.clone()).unwrap(), reused);
        assert_eq!(creator.complete(created).unwrap(), reused);
    }

    #[test]
    fn empty_legacy_directory_does_not_disable_the_fixed_shard_ledger() {
        let root = secure_root();
        fs::create_dir(root.path().join(LEGACY_LEDGER_DIRECTORY)).unwrap();

        assert!(matches!(
            reserve(
                root.path(),
                "workspace-1",
                "session-1",
                "create-1",
                &request_digest(1),
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
    }

    #[test]
    fn populated_legacy_directory_requires_explicit_reconciliation() {
        let root = secure_root();
        let legacy = root.path().join(LEGACY_LEDGER_DIRECTORY);
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("record"), b"legacy-state").unwrap();

        let error = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &request_digest(1),
        )
        .err()
        .expect("legacy state must never be ignored");
        assert!(error.contains("upgrade_required"), "{error}");
    }

    #[test]
    fn retirement_blocks_changed_request_before_and_after_completion() {
        let root = secure_root();
        let stop = complete_generation(root.path());
        checkpoint_retirement_exact(root.path(), &stop).unwrap();
        let conflict = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-2",
            &request_digest(2),
        )
        .err()
        .expect("retirement checkpoint must reject a changed create");
        assert!(conflict.contains("idempotency_conflict"));
        finalize_retirement_exact(root.path(), &stop).unwrap();
        let conflict = reserve(
            root.path(),
            "workspace-1",
            "session-1",
            "create-2",
            &request_digest(2),
        )
        .err()
        .expect("retired logical session must remain immutable");
        assert!(conflict.contains("idempotency_conflict"));
    }
}

#[cfg(test)]
mod launch_colour_resolution_tests {
    use super::{TerminalDefaultColors, resolved_launch_colors};

    fn colours(background: u32) -> TerminalDefaultColors {
        TerminalDefaultColors::new(0xe5_e5_e5, background).unwrap()
    }

    #[test]
    fn an_ordinary_create_uses_the_request() {
        let request = colours(0x24_27_3a);

        assert_eq!(resolved_launch_colors(None, Some(request)), Some(request));
    }

    #[test]
    fn a_recipe_that_carries_a_seed_keeps_owning_it() {
        let stored = colours(0x1f_24_30);
        let request = colours(0x24_27_3a);

        assert_eq!(
            resolved_launch_colors(Some(Some(stored)), Some(request)),
            Some(stored),
        );
    }

    #[test]
    fn a_recipe_without_a_seed_does_not_erase_the_request() {
        let request = colours(0x24_27_3a);

        // Erasing it left the session on TerminalDefaultColors::default() —
        // black — and every TUI that asks for the background before painting
        // picked its own dark surface (2026-09-01).
        assert_eq!(
            resolved_launch_colors(Some(None), Some(request)),
            Some(request),
        );
    }

    #[test]
    fn nothing_anywhere_stays_nothing() {
        assert_eq!(resolved_launch_colors(Some(None), None), None);
        assert_eq!(resolved_launch_colors(None, None), None);
    }
}
