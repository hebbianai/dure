#[cfg(feature = "local-runtime")]
use crate::discovery_roots::{
    discovery_root_plan_from_environment, validate_read_only_discovery_roots,
};
use crate::{ClientError, LocalSession, SessionDescriptor, SessionSelector};
#[cfg(feature = "local-runtime")]
use crate::{ProcessDescriptor, SessionClass};
use hmux_host::local_discovery::{
    DiscoveredSession, DiscoveryError, DiscoveryKey, DiscoveryRegistrationCapacity, DiscoveryRoot,
    ManifestLimits, SessionLookupKey,
};
#[cfg(feature = "local-runtime")]
use hmux_host::local_discovery::{
    DiscoveryManifest, LifetimeLock, ManifestGeneration, SessionClass as DiscoverySessionClass,
    SessionDiscovery, StaleDiscoveryReason,
};
#[cfg(feature = "local-runtime")]
use hmux_host::provider_epoch::process_session_cleanup_is_incomplete;
#[cfg(all(unix, feature = "local-runtime"))]
use hmux_local_platform::peer_attestation::ColocatedSameUserPeer;
#[cfg(feature = "local-runtime")]
use hmux_session_protocol::{ProcessProof, SessionFence};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

mod creation;
mod sources;

pub const DISCOVERY_ROOT_ENV: &str = "HMUX_DISCOVERY_ROOT";
pub(crate) const MAX_DISCOVERED_SESSIONS: usize = 1_024;
pub const SESSION_CATALOG_QUERY_SCHEMA_VERSION: u16 = 1;
const MAX_SESSION_CATALOG_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCatalogIdentity {
    workspace_id: String,
    session_id: String,
}

impl SessionCatalogIdentity {
    pub fn new(
        workspace_id: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Result<Self, ClientError> {
        let identity = Self {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
        };
        SessionLookupKey::new(&identity.workspace_id, &identity.session_id)
            .map_err(DiscoveryError::from)?;
        Ok(identity)
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }
}

impl<'de> Deserialize<'de> for SessionCatalogIdentity {
    fn deserialize<Deserializer>(deserializer: Deserializer) -> Result<Self, Deserializer::Error>
    where
        Deserializer: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct WireIdentity {
            workspace_id: String,
            session_id: String,
        }

        let wire = WireIdentity::deserialize(deserializer)?;
        SessionCatalogIdentity::new(wire.workspace_id, wire.session_id)
            .map_err(|error| serde::de::Error::custom(error.code()))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCatalogQuery {
    schema_version: u16,
    max_items: usize,
    max_output_bytes: usize,
    prioritized: Vec<SessionCatalogIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page: Option<SessionCatalogPage>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCatalogPage {
    pub after: Option<SessionCatalogIdentity>,
}

impl SessionCatalogQuery {
    pub fn new(
        max_items: usize,
        max_output_bytes: usize,
        prioritized: Vec<SessionCatalogIdentity>,
    ) -> Result<Self, ClientError> {
        let unique = prioritized.iter().collect::<BTreeSet<_>>();
        if max_items == 0
            || max_items > MAX_DISCOVERED_SESSIONS
            || max_output_bytes == 0
            || max_output_bytes > MAX_SESSION_CATALOG_OUTPUT_BYTES
            || prioritized.len() > max_items
            || unique.len() != prioritized.len()
        {
            return Err(ClientError::transport(
                "hmux_session_catalog_query_invalid",
                "session catalog query exceeds its typed item, byte, or priority bounds",
            ));
        }
        Ok(Self {
            schema_version: SESSION_CATALOG_QUERY_SCHEMA_VERSION,
            max_items,
            max_output_bytes,
            prioritized,
            page: None,
        })
    }

    pub fn with_page(mut self, page: SessionCatalogPage) -> Result<Self, ClientError> {
        if !self.prioritized.is_empty() {
            return Err(ClientError::transport(
                "hmux_session_catalog_query_invalid",
                "ordered catalog pages cannot prioritize client bindings",
            ));
        }
        self.page = Some(page);
        Ok(self)
    }

    #[must_use]
    pub fn max_items(&self) -> usize {
        self.max_items
    }

    #[must_use]
    pub fn max_output_bytes(&self) -> usize {
        self.max_output_bytes
    }

    #[must_use]
    pub fn prioritized(&self) -> &[SessionCatalogIdentity] {
        &self.prioritized
    }
}

impl<'de> Deserialize<'de> for SessionCatalogQuery {
    fn deserialize<Deserializer>(deserializer: Deserializer) -> Result<Self, Deserializer::Error>
    where
        Deserializer: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct WireQuery {
            schema_version: u16,
            max_items: usize,
            max_output_bytes: usize,
            #[serde(default)]
            prioritized: Vec<SessionCatalogIdentity>,
            #[serde(default)]
            page: Option<SessionCatalogPage>,
        }

        let wire = WireQuery::deserialize(deserializer)?;
        if wire.schema_version != SESSION_CATALOG_QUERY_SCHEMA_VERSION {
            return Err(serde::de::Error::custom(
                "unsupported session catalog query schema",
            ));
        }
        let query =
            SessionCatalogQuery::new(wire.max_items, wire.max_output_bytes, wire.prioritized)
                .map_err(|error| serde::de::Error::custom(error.code()))?;
        match wire.page {
            Some(page) => query
                .with_page(page)
                .map_err(|error| serde::de::Error::custom(error.code())),
            None => Ok(query),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCatalogTruncation {
    pub items: bool,
    pub omitted_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCatalogSnapshot {
    pub schema_version: u16,
    pub complete: bool,
    pub prioritized_items: usize,
    pub sessions: Vec<SessionDescriptor>,
    pub truncation: SessionCatalogTruncation,
}

#[derive(Clone)]
struct SeenCatalogGeneration {
    key: DiscoveryKey,
    manifest_digest: [u8; 32],
}

struct SessionCatalogAccumulator<'a> {
    query: &'a SessionCatalogQuery,
    maximum_census_items: usize,
    priorities: BTreeSet<SessionCatalogIdentity>,
    seen: BTreeMap<SessionCatalogIdentity, SeenCatalogGeneration>,
    prioritized: BTreeMap<SessionCatalogIdentity, DiscoveredSession>,
    remaining: BTreeMap<SessionCatalogIdentity, DiscoveredSession>,
    eligible_items: usize,
    error: Option<ClientError>,
}

impl<'a> SessionCatalogAccumulator<'a> {
    fn new(query: &'a SessionCatalogQuery, maximum_census_items: usize) -> Self {
        Self {
            query,
            maximum_census_items,
            priorities: query.prioritized.iter().cloned().collect(),
            seen: BTreeMap::new(),
            prioritized: BTreeMap::new(),
            remaining: BTreeMap::new(),
            eligible_items: 0,
            error: None,
        }
    }

    fn observe(&mut self, candidate: DiscoveredSession) {
        if self.error.is_some() {
            return;
        }
        let identity = SessionCatalogIdentity {
            workspace_id: candidate.key.workspace_id().to_string(),
            session_id: candidate.key.session_id().to_string(),
        };
        let manifest_digest = match serde_json::to_vec(&candidate.manifest) {
            Ok(manifest) => Sha256::digest(manifest).into(),
            Err(_) => {
                self.error = Some(ClientError::transport(
                    "hmux_session_catalog_query_failed",
                    "session catalog manifest could not be fingerprinted",
                ));
                return;
            }
        };
        if let Some(seen) = self.seen.get(&identity) {
            if seen.key != candidate.key || seen.manifest_digest != manifest_digest {
                self.error = Some(ClientError::AmbiguousDiscoveryGeneration {
                    session_id: identity.session_id,
                    workspace_id: identity.workspace_id,
                });
            }
            return;
        }
        if self.seen.len() >= self.maximum_census_items {
            self.error = Some(ClientError::Discovery(
                DiscoveryError::LookupLimitExceeded {
                    maximum: self.maximum_census_items,
                },
            ));
            return;
        }
        self.seen.insert(
            identity.clone(),
            SeenCatalogGeneration {
                key: candidate.key.clone(),
                manifest_digest,
            },
        );
        // Census and ambiguity checks still cover every manifest. Apply the
        // continuation boundary before item/byte selection, not afterward.
        if self
            .query
            .page
            .as_ref()
            .and_then(|page| page.after.as_ref())
            .is_some_and(|after| &identity <= after)
        {
            return;
        }
        self.eligible_items += 1;
        if self.priorities.contains(&identity) {
            self.prioritized.insert(identity, candidate);
            return;
        }
        self.remaining.insert(identity, candidate);
        if self.remaining.len() > self.query.max_items {
            self.remaining.pop_last();
        }
    }

    fn finish(mut self) -> Result<SessionCatalogSnapshot, ClientError> {
        if let Some(error) = self.error {
            return Err(error);
        }
        let prioritized_items = self.prioritized.len();
        let mut sessions = Vec::with_capacity(self.query.max_items);
        for identity in &self.query.prioritized {
            if let Some(session) = self.prioritized.remove(identity) {
                sessions.push(SessionDescriptor::from(session));
            }
        }
        sessions.extend(
            self.remaining
                .into_iter()
                .take(self.query.max_items.saturating_sub(sessions.len()))
                .map(|(_, session)| SessionDescriptor::from(session)),
        );
        let total_items = self.eligible_items;
        let mut snapshot = SessionCatalogSnapshot {
            schema_version: SESSION_CATALOG_QUERY_SCHEMA_VERSION,
            // Reaching this snapshot proves the filesystem census completed.
            // Projection truncation is a separate fact below.
            complete: true,
            prioritized_items,
            truncation: SessionCatalogTruncation {
                items: sessions.len() < total_items,
                omitted_count: total_items.saturating_sub(sessions.len()),
            },
            sessions,
        };
        while serialized_snapshot_bytes(&snapshot)? > self.query.max_output_bytes {
            if snapshot.sessions.len() <= prioritized_items {
                let (code, message) = if prioritized_items > 0 {
                    (
                        "hmux_session_catalog_priority_output_limit",
                        "prioritized session descriptors exceed the catalog byte budget",
                    )
                } else {
                    (
                        "hmux_session_catalog_output_limit",
                        "session catalog envelope exceeds the byte budget",
                    )
                };
                return Err(ClientError::transport(code, message));
            }
            snapshot.sessions.pop();
            snapshot.truncation.items = true;
            snapshot.truncation.omitted_count = total_items.saturating_sub(snapshot.sessions.len());
        }
        Ok(snapshot)
    }
}

fn serialized_snapshot_bytes(snapshot: &SessionCatalogSnapshot) -> Result<usize, ClientError> {
    serde_json::to_vec(snapshot)
        .map(|bytes| bytes.len().saturating_add(1))
        .map_err(|_| {
            ClientError::transport(
                "hmux_session_catalog_query_failed",
                "session catalog snapshot could not be serialized",
            )
        })
}

#[derive(Clone, Debug)]
pub struct LocalSessionCatalog {
    discovery_root: PathBuf,
    read_only_discovery_roots: Vec<PathBuf>,
}

#[cfg(feature = "local-runtime")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExactExitedRetirement {
    Retired,
    AlreadyRetired,
    NotFound,
}

#[cfg(feature = "local-runtime")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ArchivedExitedRetirementEvidence {
    pub(crate) session_class: SessionClass,
    pub(crate) provider_process: ProcessDescriptor,
    pub(crate) process_session_cleanup_incomplete: bool,
}

#[cfg(feature = "local-runtime")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CurrentExitedGeneration {
    Exact,
    SameGenerationNotExited,
    Different,
}

#[cfg(feature = "local-runtime")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExactSourceMutation {
    CanonicalOnly,
    ConfirmedRetirement,
    ManagedStop,
}

#[cfg(feature = "local-runtime")]
fn current_exited_generation(
    manifest: &DiscoveryManifest,
    expected_fence: &SessionFence,
    expected_generation: &ManifestGeneration,
) -> CurrentExitedGeneration {
    if manifest.generation() != *expected_generation {
        return CurrentExitedGeneration::Different;
    }
    match manifest {
        DiscoveryManifest::Exited(exited) if exited.tombstone.fence == *expected_fence => {
            CurrentExitedGeneration::Exact
        }
        DiscoveryManifest::Exited(_) => CurrentExitedGeneration::Different,
        DiscoveryManifest::Starting(_) | DiscoveryManifest::Ready(_) => {
            CurrentExitedGeneration::SameGenerationNotExited
        }
    }
}

#[cfg(feature = "local-runtime")]
fn manifest_lifecycle_name(manifest: &DiscoveryManifest) -> &'static str {
    match manifest {
        DiscoveryManifest::Starting(_) => "starting",
        DiscoveryManifest::Ready(_) => "ready",
        DiscoveryManifest::Exited(_) => "exited",
    }
}

#[cfg(feature = "local-runtime")]
#[derive(Debug)]
pub struct StaleSessionRetirement {
    session: SessionDiscovery,
    lock: LifetimeLock,
    expected_generation: ManifestGeneration,
}

#[cfg(feature = "local-runtime")]
impl StaleSessionRetirement {
    pub fn retire(self) -> Result<bool, ClientError> {
        self.session
            .cleanup_current(&self.lock, &self.expected_generation)
            .map_err(ClientError::from)
    }

    /// Remove a lock-proven stale generation only while it is still
    /// non-exited. Exited generations must use the archival retirement path
    /// so their tombstone is not discarded by a generic stale cleanup.
    pub fn retire_stale(self) -> Result<bool, ClientError> {
        self.verify_stale()?;
        self.session
            .cleanup_current(&self.lock, &self.expected_generation)
            .map_err(ClientError::from)
    }

    /// Revalidate the non-exited lifecycle while the exact generation's
    /// lifetime lock is held. This is the read-only half of stale cleanup.
    pub fn verify_stale(&self) -> Result<(), ClientError> {
        let current = self.session.read_manifest()?;
        if current.generation() != self.expected_generation {
            return Err(ClientError::Discovery(DiscoveryError::GenerationMismatch));
        }
        if matches!(current, DiscoveryManifest::Exited(_)) {
            return Err(ClientError::Discovery(
                DiscoveryError::InvalidManifestTransition {
                    from: "exited",
                    to: "stale_removed",
                },
            ));
        }
        Ok(())
    }

    /// Retire an *exited* generation, archiving the exit evidence into
    /// `retired/` before removing the active pointer
    /// ([`SessionDiscovery::retire_exited_current`]). A non-exited manifest
    /// fails closed with `InvalidManifestTransition` instead of being removed.
    pub fn retire_exited(self) -> Result<bool, ClientError> {
        self.session
            .retire_exited_current(&self.lock, &self.expected_generation)
            .map_err(ClientError::from)
    }
}

impl LocalSessionCatalog {
    #[must_use]
    pub fn new(discovery_root: impl Into<PathBuf>) -> Self {
        Self {
            discovery_root: discovery_root.into(),
            read_only_discovery_roots: Vec::new(),
        }
    }

    /// Build a catalog with one canonical creation/recovery root and a bounded
    /// set of compatibility roots used for discovery and attach.
    ///
    /// General mutation never reaches the extra roots. Exact user-confirmed
    /// retirement and managed stop may act only on the catalog-located fenced
    /// source; managed rehost may likewise stop only that exact source. Rehost
    /// journals and every replacement creation remain canonical-only.
    #[cfg(feature = "local-runtime")]
    pub fn with_read_only_discovery_roots(
        discovery_root: impl Into<PathBuf>,
        read_only_discovery_roots: Vec<PathBuf>,
    ) -> Result<Self, ClientError> {
        let discovery_root = discovery_root.into();
        let read_only_discovery_roots =
            validate_read_only_discovery_roots(&discovery_root, read_only_discovery_roots)?;
        Ok(Self {
            discovery_root,
            read_only_discovery_roots,
        })
    }

    /// Discovering the root from the environment means reading *this* OS's
    /// state directory, so it comes with the rest of the local-runtime surface.
    /// [`Self::new`] stays available: a relay client is handed a root by
    /// whoever performed the discovery on its behalf.
    #[cfg(feature = "local-runtime")]
    pub fn from_environment() -> Result<Self, ClientError> {
        let plan = discovery_root_plan_from_environment()?;
        Self::with_read_only_discovery_roots(plan.canonical, plan.read_only)
    }

    /// Capacity of the canonical mutable root. Read-only migration roots are
    /// attach compatibility inputs and never consume canonical registration
    /// authority.
    pub fn registration_capacity(&self) -> Result<DiscoveryRegistrationCapacity, ClientError> {
        let Some(root) = Self::open_path_if_present(&self.discovery_root)? else {
            return Ok(DiscoveryRegistrationCapacity::empty(
                ManifestLimits::default().max_session_catalog_entries,
            ));
        };
        root.registration_capacity().map_err(ClientError::from)
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn read_only_discovery_roots(&self) -> &[PathBuf] {
        &self.read_only_discovery_roots
    }

    pub fn list(&self) -> Result<Vec<SessionDescriptor>, ClientError> {
        let mut sessions: Vec<_> = self
            .list_discovered_sessions()?
            .into_iter()
            .map(SessionDescriptor::from)
            .collect();
        sessions.sort_by(|left, right| {
            (&left.session_id, &left.workspace_id).cmp(&(&right.session_id, &right.workspace_id))
        });
        Ok(sessions)
    }

    /// Scan every configured discovery root once while retaining only the
    /// caller's bounded, deterministic projection.
    ///
    /// Exact caller priorities are provider- and presentation-neutral session
    /// identities. Every matching priority is kept before lexicographic fill;
    /// omitted rows are reported instead of being presented as absent.
    pub fn query(
        &self,
        query: &SessionCatalogQuery,
    ) -> Result<SessionCatalogSnapshot, ClientError> {
        // Every configured root has its own bounded registration catalog.
        // Migration reads combine those independent authorities, so the
        // census bound must compose by root while the returned projection
        // remains capped by the caller's query.
        let maximum_census_items = MAX_DISCOVERED_SESSIONS
            .saturating_mul(1_usize.saturating_add(self.read_only_discovery_roots.len()));
        let mut accumulator = SessionCatalogAccumulator::new(query, maximum_census_items);
        for path in self.discovery_paths() {
            let Some(root) = Self::open_path_if_present(path)? else {
                continue;
            };
            root.visit_sessions(|session| accumulator.observe(session))?;
        }
        accumulator.finish()
    }

    /// Enumerate only sessions with one exact human-facing name.
    ///
    /// This is the bounded lookup surface for helper processes. It avoids
    /// materializing unrelated catalog entries while retaining ambiguity and
    /// generation checks in the caller.
    pub fn list_named(&self, name: &str) -> Result<Vec<SessionDescriptor>, ClientError> {
        Ok(self
            .list_discovered_sessions_named(name)?
            .into_iter()
            .map(SessionDescriptor::from)
            .collect())
    }

    /// Resolve only one opaque session id through the existing workspace path
    /// index. The census worker uses this before considering names or prefixes.
    #[cfg(feature = "local-runtime")]
    pub(crate) fn list_session_id(
        &self,
        session_id: &str,
    ) -> Result<Vec<SessionDescriptor>, ClientError> {
        Ok(self
            .list_discovered_sessions_by_id(session_id)?
            .into_iter()
            .map(SessionDescriptor::from)
            .collect())
    }

    /// Select the complete candidate set for one human-facing identifier.
    /// Exact opaque ids take precedence; only proven absence or an identifier
    /// that cannot be an opaque id admits the broader name/prefix census.
    #[cfg(feature = "local-runtime")]
    pub(crate) fn list_resolution_candidates(
        &self,
        identifier: &str,
    ) -> Result<Vec<SessionDescriptor>, ClientError> {
        Ok(self
            .list_discovered_resolution_candidates(identifier)?
            .into_iter()
            .map(SessionDescriptor::from)
            .collect())
    }

    /// Check one exact identity in compatibility roots without mutating them.
    ///
    /// Create admission needs only the existing workspace/session path index,
    /// not an inventory of unrelated identities. Only proven absence permits
    /// creation; unreadable or not-ready target paths still fail closed.
    #[doc(hidden)]
    #[cfg(feature = "local-runtime")]
    pub fn has_read_only_migration_session(
        &self,
        identity: &SessionCatalogIdentity,
    ) -> Result<bool, ClientError> {
        for path in &self.read_only_discovery_roots {
            let Some(root) = Self::open_path_if_present(path)? else {
                continue;
            };
            match root.find_manifest_by_session(identity.workspace_id(), identity.session_id()) {
                Ok(_) => return Ok(true),
                Err(DiscoveryError::SessionNotFound) => {}
                Err(error) => return Err(ClientError::Discovery(error)),
            }
        }
        Ok(false)
    }

    /// Enumerate one exact name only in compatibility roots.
    #[doc(hidden)]
    #[cfg(feature = "local-runtime")]
    pub fn list_read_only_migration_sessions_named(
        &self,
        name: &str,
    ) -> Result<Vec<SessionDescriptor>, ClientError> {
        let mut sessions = Vec::new();
        for path in &self.read_only_discovery_roots {
            let Some(root) = Self::open_path_if_present(path)? else {
                continue;
            };
            for discovered in root.list_sessions_named(name)? {
                merge_discovered_session(&mut sessions, discovered)?;
            }
        }
        Ok(sessions.into_iter().map(SessionDescriptor::from).collect())
    }

    pub fn find(&self, selector: &SessionSelector) -> Result<SessionDescriptor, ClientError> {
        self.resolve_discovered(selector)
            .map(SessionDescriptor::from)
    }

    pub fn find_kickoff_action_id(
        &self,
        selector: &SessionSelector,
    ) -> Result<Option<String>, ClientError> {
        Ok(self
            .resolve_discovered(selector)?
            .manifest
            .common()
            .claim_linkage
            .kickoff_action_id
            .clone())
    }

    pub fn open(&self, selector: &SessionSelector) -> Result<LocalSession, ClientError> {
        self.resolve_discovered(selector)
            .map(LocalSession::from_discovered)
    }

    /// Resolve the discovery root that owns one exact managed generation.
    ///
    /// Managed stop is the only runtime transaction, besides confirmed
    /// retirement, allowed to mutate a compatibility root. The complete Host
    /// fence prevents a stale catalog observation from selecting a replacement
    /// generation, while the stop broker revalidates the same fence at its
    /// destructive boundary.
    #[cfg(feature = "local-runtime")]
    pub fn resolve_managed_stop_discovery_root(
        &self,
        selector: &SessionSelector,
        expected: &SessionFence,
    ) -> Result<PathBuf, ClientError> {
        let session = self.open(selector)?;
        let descriptor = session.descriptor();
        if descriptor.session_class != crate::SessionClass::Managed {
            return Err(ClientError::transport(
                "hmux_managed_stop_refused",
                "requested session is not managed",
            ));
        }
        if !descriptor.matches_fence(expected) {
            return Err(ClientError::transport(
                "hmux_managed_stop_generation_changed",
                "managed session generation changed before provider stop",
            ));
        }
        self.mutation_source(&session, ExactSourceMutation::ManagedStop)
            .map(Path::to_path_buf)
    }

    /// Return the bounded set of existing roots that may own a durable managed
    /// stop intent. This is a broker-only reconciliation seam: callers must
    /// still validate the operation identity stored in each root and must
    /// refuse competing matches.
    #[doc(hidden)]
    #[cfg(feature = "local-runtime")]
    pub fn managed_stop_reconcile_roots(&self) -> Result<Vec<PathBuf>, ClientError> {
        let mut roots = Vec::new();
        for path in self.discovery_paths() {
            if Self::open_path_if_present(path)?.is_some() {
                roots.push(path.to_path_buf());
            }
        }
        Ok(roots)
    }

    pub(crate) fn resolve_discovered(
        &self,
        selector: &SessionSelector,
    ) -> Result<DiscoveredSession, ClientError> {
        if let Some(workspace_id) = &selector.workspace_id {
            let mut matches = Vec::new();
            for path in self.discovery_paths() {
                let Some(root) = Self::open_path_if_present(path)? else {
                    continue;
                };
                match root.find_manifest_by_session(workspace_id, &selector.session_id) {
                    Ok(discovered) => merge_discovered_session(&mut matches, discovered)?,
                    Err(DiscoveryError::SessionNotFound) => {}
                    Err(error) => return Err(ClientError::Discovery(error)),
                }
            }
            return matches.pop().ok_or_else(|| not_found(selector));
        }

        let mut matches = self.list_discovered_sessions_by_id(&selector.session_id)?;
        match matches.len() {
            0 => Err(not_found(selector)),
            1 => Ok(matches.remove(0)),
            _ => {
                let mut workspaces: Vec<_> = matches
                    .into_iter()
                    .map(|session| session.manifest.common().lifetime.workspace_id.clone())
                    .collect();
                workspaces.sort();
                workspaces.dedup();
                Err(ClientError::AmbiguousSession {
                    session_id: selector.session_id.clone(),
                    workspaces,
                })
            }
        }
    }

    /// Resolve a human-facing name, exact id, or unique id prefix.
    ///
    /// Exact ids always win. Prefixes are matched against both the complete id
    /// and the suffix after `standalone_`, so the eight-character value printed
    /// by the CLI is accepted on the next command.
    pub fn resolve(&self, identifier: &str) -> Result<LocalSession, ClientError> {
        let sessions = self.list_discovered_resolution_candidates(identifier)?;
        let descriptors = sessions
            .iter()
            .cloned()
            .map(SessionDescriptor::from)
            .collect::<Vec<_>>();
        let selected = resolve_session_descriptor(&descriptors, identifier)?;
        open_selected_session(sessions, &selected, identifier)
    }

    /// Remove only the exact manifest generation represented by `expected`.
    ///
    /// The lifetime lock and generation comparison prevent stale-session
    /// recovery from removing a replacement Host.
    /// Removes a stale discovery entry, flock-and-unlink, on the **local**
    /// filesystem. The witness is required for the same reason the terminate
    /// paths require one: the entry is identified from manifest data, and this
    /// operates on this machine's disk.
    #[cfg(all(unix, feature = "local-runtime"))]
    pub(crate) fn cleanup_exact(
        &self,
        _colocation: &ColocatedSameUserPeer,
        expected: &LocalSession,
    ) -> Result<bool, ClientError> {
        self.cleanup_exact_after_lifetime_lock(expected)
    }

    /// Remove one exact stale local discovery generation without signalling
    /// any process.
    ///
    /// This path is for reboot/crash recovery, where the Host endpoint cannot
    /// provide a peer-attestation witness. The non-blocking lifetime lock is
    /// the OS-released proof that no cooperative Host still owns this exact
    /// session path, and the manifest-generation comparison fences a
    /// concurrent replacement. A live Host therefore cannot be removed
    /// through this API, while an unrelated process reusing a recorded PID is
    /// neither signalled nor treated as ownership evidence.
    #[cfg(feature = "local-runtime")]
    pub fn cleanup_stale_exact(&self, expected: &LocalSession) -> Result<bool, ClientError> {
        match self.cleanup_exact_after_lifetime_lock(expected) {
            Err(ClientError::Discovery(DiscoveryError::StaleDiscovery {
                reason: StaleDiscoveryReason::MissingManifest,
                ..
            })) => Ok(false),
            result => result,
        }
    }

    /// Retire one exact *exited* session's active discovery pointer, keeping
    /// the exit evidence as a `retired/` tombstone.
    ///
    /// Same fences as [`Self::cleanup_stale_exact`]: the non-blocking lifetime
    /// lock proves no cooperative Host still owns the path, and the exact
    /// manifest-generation comparison (before and under the lock) fences a
    /// concurrent replacement. Unlike `cleanup_stale_exact` this refuses any
    /// non-exited manifest, so a session that came back to life between the
    /// caller's census and this call cannot lose its discovery pointer.
    #[cfg(feature = "local-runtime")]
    pub fn retire_exited_exact(&self, expected: &LocalSession) -> Result<bool, ClientError> {
        self.retire_exited_exact_from_source(expected, ExactSourceMutation::CanonicalOnly)
    }

    #[cfg(feature = "local-runtime")]
    fn retire_exited_exact_from_source(
        &self,
        expected: &LocalSession,
        mutation: ExactSourceMutation,
    ) -> Result<bool, ClientError> {
        let reserved = match self.reserve_exact_after_lifetime_lock(expected, mutation) {
            Err(ClientError::Discovery(DiscoveryError::StaleDiscovery {
                reason: StaleDiscoveryReason::MissingManifest,
                ..
            })) => return Ok(false),
            result => result?,
        };
        match reserved {
            Some(retirement) => retirement.retire_exited(),
            None => Ok(false),
        }
    }

    /// Archive, or idempotently verify, one complete exited Host generation.
    ///
    /// Unlike [`Self::retire_exited_exact`], this can authenticate a retry after
    /// the active pointer is already gone because the caller supplies the full
    /// session fence plus Host process proof needed to name the retired record.
    #[cfg(feature = "local-runtime")]
    pub(crate) fn retire_exited_generation_exact(
        &self,
        expected_fence: &SessionFence,
        expected_host_process: &ProcessDescriptor,
    ) -> Result<ExactExitedRetirement, ClientError> {
        self.retire_exited_generation_exact_from_source(
            &self.discovery_root,
            expected_fence,
            expected_host_process,
        )
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn retire_discovered_exited_generation_exact(
        &self,
        discovered: &LocalSession,
        expected_fence: &SessionFence,
        expected_host_process: &ProcessDescriptor,
    ) -> Result<ExactExitedRetirement, ClientError> {
        let source = self.mutation_source(discovered, ExactSourceMutation::ConfirmedRetirement)?;
        self.retire_exited_generation_exact_from_source(
            source,
            expected_fence,
            expected_host_process,
        )
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn discovered_exited_generation_is_retired_managed(
        &self,
        expected_fence: &SessionFence,
        expected_host_process: &ProcessDescriptor,
    ) -> Result<Option<bool>, ClientError> {
        Ok(self
            .archived_exited_retirement_evidence(expected_fence, expected_host_process)?
            .map(|evidence| evidence.session_class == SessionClass::Managed))
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn archived_exited_retirement_evidence(
        &self,
        expected_fence: &SessionFence,
        expected_host_process: &ProcessDescriptor,
    ) -> Result<Option<ArchivedExitedRetirementEvidence>, ClientError> {
        let key = DiscoveryKey::new(
            &expected_fence.workspace_id,
            &expected_fence.session_id,
            &expected_fence.runner_instance,
            expected_fence.channel_epoch,
        )
        .map_err(DiscoveryError::InvalidDiscoveryKey)?;
        let expected_generation = ManifestGeneration {
            host_instance_id: expected_fence.host_instance_id.clone(),
            host_process: ProcessProof {
                process_id: expected_host_process.process_id,
                start_marker: expected_host_process.start_marker.clone(),
            },
            terminal_epoch: Some(expected_fence.terminal_epoch.clone()),
        };
        let mut found = None;
        for path in self.discovery_paths() {
            let Some(root) = Self::open_path_if_present(path)? else {
                continue;
            };
            let Some(session) = root.open_session_if_present(key.clone())? else {
                continue;
            };
            let Some(exited) = session.find_retired_exited_generation(&expected_generation)? else {
                continue;
            };
            if exited.tombstone.fence != *expected_fence {
                return Err(ClientError::Discovery(DiscoveryError::GenerationMismatch));
            }
            let session_class = match exited.common.session_class {
                DiscoverySessionClass::Managed => SessionClass::Managed,
                DiscoverySessionClass::Standalone => SessionClass::Standalone,
            };
            let evidence = ArchivedExitedRetirementEvidence {
                session_class,
                provider_process: ProcessDescriptor {
                    process_id: exited.tombstone.provider_process.process_id,
                    start_marker: exited.tombstone.provider_process.start_marker.clone(),
                },
                process_session_cleanup_incomplete: process_session_cleanup_is_incomplete(
                    &exited.tombstone.exit.reason,
                ),
            };
            if found.as_ref().is_some_and(|prior| prior != &evidence) {
                return Err(ClientError::Discovery(DiscoveryError::GenerationMismatch));
            }
            found = Some(evidence);
        }
        Ok(found)
    }

    /// Confirm that an absent exact logical session is not a creator's
    /// pre-manifest window. Non-blocking root fences are held across the
    /// complete inspection without creating a registration.
    #[cfg(feature = "local-runtime")]
    pub(crate) fn exact_session_absence_is_quiescent(
        &self,
        expected_fence: &SessionFence,
    ) -> Result<bool, ClientError> {
        let key = DiscoveryKey::new(
            &expected_fence.workspace_id,
            &expected_fence.session_id,
            &expected_fence.runner_instance,
            expected_fence.channel_epoch,
        )
        .map_err(DiscoveryError::InvalidDiscoveryKey)?;
        let mut fenced_roots = Vec::new();
        for path in self.discovery_paths() {
            let Some(root) = Self::open_path_if_present(path)? else {
                continue;
            };
            let maintenance = match root.acquire_maintenance_exclusive() {
                Ok(maintenance) => maintenance,
                Err(DiscoveryError::AlreadyLocked { .. }) => return Ok(false),
                Err(error) => return Err(ClientError::Discovery(error)),
            };
            fenced_roots.push((root, maintenance));
        }
        for (root, maintenance) in &fenced_roots {
            match root.exact_session_absence_is_quiescent_locked(maintenance, &key) {
                Ok(true) => {}
                Ok(false) => return Ok(false),
                Err(error) => return Err(ClientError::Discovery(error)),
            }
        }
        // A missing primary does not invalidate an existing compatibility
        // namespace's proof. No existing namespace still provides no fence.
        Ok(!fenced_roots.is_empty())
    }

    #[cfg(feature = "local-runtime")]
    fn retire_exited_generation_exact_from_source(
        &self,
        source: &Path,
        expected_fence: &SessionFence,
        expected_host_process: &ProcessDescriptor,
    ) -> Result<ExactExitedRetirement, ClientError> {
        let Some(root) = Self::open_path_if_present(source)? else {
            return Ok(ExactExitedRetirement::NotFound);
        };
        let key = DiscoveryKey::new(
            &expected_fence.workspace_id,
            &expected_fence.session_id,
            &expected_fence.runner_instance,
            expected_fence.channel_epoch,
        )
        .map_err(DiscoveryError::InvalidDiscoveryKey)?;
        let Some(session) = root.open_session_if_present(key)? else {
            return Ok(ExactExitedRetirement::NotFound);
        };
        let expected_generation = ManifestGeneration {
            host_instance_id: expected_fence.host_instance_id.clone(),
            host_process: ProcessProof {
                process_id: expected_host_process.process_id,
                start_marker: expected_host_process.start_marker.clone(),
            },
            terminal_epoch: Some(expected_fence.terminal_epoch.clone()),
        };
        let archived = session
            .find_retired_exited_generation(&expected_generation)?
            .map(|exited| {
                if exited.tombstone.fence == *expected_fence {
                    Ok(())
                } else {
                    Err(ClientError::Discovery(DiscoveryError::GenerationMismatch))
                }
            })
            .transpose()?
            .is_some();
        let current = session.read_manifest_if_present()?;
        match current.as_ref() {
            None if archived => return Ok(ExactExitedRetirement::AlreadyRetired),
            None => return Ok(ExactExitedRetirement::NotFound),
            Some(current)
                if current_exited_generation(current, expected_fence, &expected_generation)
                    == CurrentExitedGeneration::Different =>
            {
                return if archived {
                    // An immutable exact archive proves A retired. A current
                    // different generation is its successor B, whose lifetime
                    // lock and discovery pointer are outside this retry.
                    Ok(ExactExitedRetirement::AlreadyRetired)
                } else {
                    Err(ClientError::Discovery(DiscoveryError::GenerationMismatch))
                };
            }
            Some(current)
                if current_exited_generation(current, expected_fence, &expected_generation)
                    == CurrentExitedGeneration::Exact => {}
            Some(current) => {
                return Err(ClientError::Discovery(
                    DiscoveryError::InvalidManifestTransition {
                        from: manifest_lifecycle_name(current),
                        to: "retired",
                    },
                ));
            }
        }

        let lock = match session.acquire_lifetime_lock() {
            Ok(lock) => lock,
            Err(error @ DiscoveryError::AlreadyLocked { .. }) if archived => {
                let current = session.read_manifest_if_present()?;
                if current.as_ref().is_some_and(|current| {
                    current_exited_generation(current, expected_fence, &expected_generation)
                        == CurrentExitedGeneration::Different
                }) {
                    return Ok(ExactExitedRetirement::AlreadyRetired);
                }
                return Err(ClientError::Discovery(error));
            }
            Err(error) => return Err(ClientError::Discovery(error)),
        };
        let current = session.read_manifest_if_present()?;
        match current.as_ref() {
            None if archived => Ok(ExactExitedRetirement::AlreadyRetired),
            None => Ok(ExactExitedRetirement::NotFound),
            Some(current)
                if current_exited_generation(current, expected_fence, &expected_generation)
                    == CurrentExitedGeneration::Different =>
            {
                if archived {
                    Ok(ExactExitedRetirement::AlreadyRetired)
                } else {
                    Err(ClientError::Discovery(DiscoveryError::GenerationMismatch))
                }
            }
            Some(current)
                if current_exited_generation(current, expected_fence, &expected_generation)
                    == CurrentExitedGeneration::Exact =>
            {
                match session.retire_exited_current(&lock, &expected_generation)? {
                    true => Ok(ExactExitedRetirement::Retired),
                    false if archived => Ok(ExactExitedRetirement::AlreadyRetired),
                    false => Ok(ExactExitedRetirement::NotFound),
                }
            }
            Some(current) => Err(ClientError::Discovery(
                DiscoveryError::InvalidManifestTransition {
                    from: manifest_lifecycle_name(current),
                    to: "retired",
                },
            )),
        }
    }

    /// Reserve the exact stale generation before creating a successor.
    ///
    /// Holding the returned guard proves that the prior Host no longer owns
    /// its lifetime lock and prevents another cooperative recovery from
    /// reclaiming that source path. Dropping the guard is non-destructive;
    /// [`StaleSessionRetirement::retire`] performs the generation-fenced
    /// manifest removal only after the caller has verified its replacement.
    #[cfg(feature = "local-runtime")]
    pub fn reserve_stale_exact(
        &self,
        expected: &LocalSession,
    ) -> Result<Option<StaleSessionRetirement>, ClientError> {
        self.reserve_stale_exact_from_source(expected, ExactSourceMutation::CanonicalOnly)
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn reserve_discovered_stale_exact(
        &self,
        expected: &LocalSession,
    ) -> Result<Option<StaleSessionRetirement>, ClientError> {
        self.reserve_stale_exact_from_source(expected, ExactSourceMutation::ConfirmedRetirement)
    }

    #[cfg(feature = "local-runtime")]
    fn reserve_stale_exact_from_source(
        &self,
        expected: &LocalSession,
        mutation: ExactSourceMutation,
    ) -> Result<Option<StaleSessionRetirement>, ClientError> {
        match self.reserve_exact_after_lifetime_lock(expected, mutation) {
            Err(ClientError::Discovery(DiscoveryError::StaleDiscovery {
                reason: StaleDiscoveryReason::MissingManifest,
                ..
            })) => Ok(None),
            result => result,
        }
    }

    #[cfg(feature = "local-runtime")]
    fn cleanup_exact_after_lifetime_lock(
        &self,
        expected: &LocalSession,
    ) -> Result<bool, ClientError> {
        let Some(retirement) =
            self.reserve_exact_after_lifetime_lock(expected, ExactSourceMutation::CanonicalOnly)?
        else {
            return Ok(false);
        };
        retirement.retire()
    }

    #[cfg(feature = "local-runtime")]
    fn reserve_exact_after_lifetime_lock(
        &self,
        expected: &LocalSession,
        mutation: ExactSourceMutation,
    ) -> Result<Option<StaleSessionRetirement>, ClientError> {
        let source = self.mutation_source(expected, mutation)?;
        let Some(root) = Self::open_path_if_present(source)? else {
            return Ok(None);
        };
        let descriptor = expected.descriptor();
        let discovered =
            match root.find_manifest_by_session(&descriptor.workspace_id, &descriptor.session_id) {
                Ok(discovered) => discovered,
                Err(DiscoveryError::SessionNotFound) => return Ok(None),
                Err(error) => return Err(ClientError::Discovery(error)),
            };
        let expected_generation = expected.manifest_generation();
        if discovered.manifest.generation() != expected_generation {
            return Err(ClientError::Discovery(DiscoveryError::GenerationMismatch));
        }
        let session = root.open_session(discovered.key)?;
        let lock = session.acquire_lifetime_lock()?;
        if session.read_manifest()?.generation() != expected_generation {
            return Err(ClientError::Discovery(DiscoveryError::GenerationMismatch));
        }
        Ok(Some(StaleSessionRetirement {
            session,
            lock,
            expected_generation,
        }))
    }

    /// Resolve one exact human-facing session name.
    ///
    /// Unlike [`Self::resolve`], this never interprets the value as a session
    /// id or prefix. Explicit `--name` and API fields therefore cannot attach
    /// to a different session merely because its opaque id happens to collide
    /// with a display name.
    pub fn resolve_name(&self, name: &str) -> Result<LocalSession, ClientError> {
        let sessions = self.list_discovered_sessions_named(name)?;
        let descriptors = sessions
            .iter()
            .cloned()
            .map(SessionDescriptor::from)
            .collect::<Vec<_>>();
        let selected = resolve_session_name_descriptor(&descriptors, name)?;
        open_selected_session(sessions, &selected, name)
    }

    fn list_discovered_sessions_named(
        &self,
        name: &str,
    ) -> Result<Vec<DiscoveredSession>, ClientError> {
        let mut sessions = Vec::new();
        for path in self.discovery_paths() {
            let Some(root) = Self::open_path_if_present(path)? else {
                continue;
            };
            for discovered in root.list_sessions_named(name)? {
                merge_discovered_session(&mut sessions, discovered)?;
            }
        }
        sort_discovered_sessions(&mut sessions);
        Ok(sessions)
    }

    fn list_discovered_sessions_by_id(
        &self,
        session_id: &str,
    ) -> Result<Vec<DiscoveredSession>, ClientError> {
        let mut sessions = Vec::new();
        for path in self.discovery_paths() {
            let Some(root) = Self::open_path_if_present(path)? else {
                continue;
            };
            for discovered in root.list_sessions_by_id(session_id)? {
                merge_discovered_session(&mut sessions, discovered)?;
            }
        }
        sort_discovered_sessions(&mut sessions);
        Ok(sessions)
    }

    fn list_discovered_resolution_candidates(
        &self,
        identifier: &str,
    ) -> Result<Vec<DiscoveredSession>, ClientError> {
        match self.list_discovered_sessions_by_id(identifier) {
            Ok(sessions) if !sessions.is_empty() => Ok(sessions),
            Ok(_) | Err(ClientError::Discovery(DiscoveryError::InvalidDiscoveryKey(_))) => {
                self.list_discovered_sessions()
            }
            Err(error) => Err(error),
        }
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn open_if_present(&self) -> Result<Option<DiscoveryRoot>, ClientError> {
        Self::open_path_if_present(&self.discovery_root)
    }

    fn list_discovered_sessions(&self) -> Result<Vec<DiscoveredSession>, ClientError> {
        let mut sessions = Vec::new();
        for path in self.discovery_paths() {
            let Some(root) = Self::open_path_if_present(path)? else {
                continue;
            };
            merge_root_discovered_sessions(&mut sessions, &root)?;
        }
        sort_discovered_sessions(&mut sessions);
        Ok(sessions)
    }
}

#[cfg(feature = "local-runtime")]
pub fn default_discovery_root() -> Result<PathBuf, ClientError> {
    Ok(discovery_root_plan_from_environment()?.canonical)
}

fn merge_discovered_session(
    sessions: &mut Vec<DiscoveredSession>,
    candidate: DiscoveredSession,
) -> Result<(), ClientError> {
    let lifetime = &candidate.manifest.common().lifetime;
    if let Some(existing) = sessions.iter().find(|existing| {
        let existing_lifetime = &existing.manifest.common().lifetime;
        existing_lifetime.workspace_id == lifetime.workspace_id
            && existing_lifetime.session_id == lifetime.session_id
    }) {
        if existing.key == candidate.key && existing.manifest == candidate.manifest {
            return Ok(());
        }
        return Err(ClientError::AmbiguousDiscoveryGeneration {
            session_id: lifetime.session_id.clone(),
            workspace_id: lifetime.workspace_id.clone(),
        });
    }
    if sessions.len() >= MAX_DISCOVERED_SESSIONS {
        return Err(ClientError::Discovery(
            DiscoveryError::LookupLimitExceeded {
                maximum: MAX_DISCOVERED_SESSIONS,
            },
        ));
    }
    sessions.push(candidate);
    Ok(())
}

fn merge_root_discovered_sessions(
    sessions: &mut Vec<DiscoveredSession>,
    root: &DiscoveryRoot,
) -> Result<(), ClientError> {
    for discovered in root.list_sessions_bounded(MAX_DISCOVERED_SESSIONS)? {
        merge_discovered_session(sessions, discovered)?;
    }
    Ok(())
}

fn sort_discovered_sessions(sessions: &mut [DiscoveredSession]) {
    sessions.sort_by(|left, right| {
        (
            left.key.session_id(),
            left.key.workspace_id(),
            left.key.runner_instance(),
            left.key.channel_epoch(),
        )
            .cmp(&(
                right.key.session_id(),
                right.key.workspace_id(),
                right.key.runner_instance(),
                right.key.channel_epoch(),
            ))
    });
}

fn not_found(selector: &SessionSelector) -> ClientError {
    ClientError::SessionNotFound {
        session_id: selector.session_id.clone(),
        workspace_id: selector.workspace_id.clone(),
    }
}

pub(crate) fn resolve_session_descriptor(
    sessions: &[SessionDescriptor],
    identifier: &str,
) -> Result<SessionDescriptor, ClientError> {
    let exact = sessions
        .iter()
        .filter(|session| session.session_id == identifier)
        .collect::<Vec<_>>();
    match exact.len() {
        0 => {}
        1 => return Ok(exact[0].clone()),
        _ => {
            let mut workspaces = exact
                .into_iter()
                .map(|session| session.workspace_id.clone())
                .collect::<Vec<_>>();
            workspaces.sort();
            workspaces.dedup();
            return Err(ClientError::AmbiguousSession {
                session_id: identifier.to_string(),
                workspaces,
            });
        }
    }
    let matches = sessions
        .iter()
        .filter(|session| descriptor_target_matches(session, identifier))
        .collect::<Vec<_>>();
    select_descriptor(identifier, matches)
}

pub(crate) fn resolve_session_name_descriptor(
    sessions: &[SessionDescriptor],
    name: &str,
) -> Result<SessionDescriptor, ClientError> {
    let matches = sessions
        .iter()
        .filter(|session| session.session_name.as_deref() == Some(name))
        .collect::<Vec<_>>();
    select_descriptor(name, matches)
}

fn descriptor_target_matches(session: &SessionDescriptor, identifier: &str) -> bool {
    let session_id = session.session_id.as_str();
    let short_id = session_id.strip_prefix("standalone_").unwrap_or(session_id);
    session.session_name.as_deref() == Some(identifier)
        || (!identifier.is_empty()
            && (session_id.starts_with(identifier) || short_id.starts_with(identifier)))
}

fn select_descriptor(
    identifier: &str,
    mut matches: Vec<&SessionDescriptor>,
) -> Result<SessionDescriptor, ClientError> {
    match matches.len() {
        0 => Err(ClientError::SessionNotFound {
            session_id: identifier.to_string(),
            workspace_id: None,
        }),
        1 => Ok(matches.remove(0).clone()),
        _ => Err(ambiguous_descriptor_target(identifier, &matches)),
    }
}

fn ambiguous_descriptor_target(identifier: &str, matches: &[&SessionDescriptor]) -> ClientError {
    let mut candidates = matches
        .iter()
        .map(|session| match session.session_name.as_deref() {
            Some(name) => format!(
                "{name} ({} in {})",
                session.session_id, session.workspace_id
            ),
            None => format!("{} (in {})", session.session_id, session.workspace_id),
        })
        .collect::<Vec<_>>();
    candidates.sort();
    ClientError::AmbiguousTarget {
        identifier: identifier.to_string(),
        candidates,
    }
}

fn open_selected_session(
    sessions: Vec<DiscoveredSession>,
    selected: &SessionDescriptor,
    identifier: &str,
) -> Result<LocalSession, ClientError> {
    sessions
        .into_iter()
        .find(|session| {
            session.key.session_id() == selected.session_id
                && session.key.workspace_id() == selected.workspace_id
        })
        .map(LocalSession::from_discovered)
        .ok_or_else(|| ClientError::SessionNotFound {
            session_id: identifier.to_string(),
            workspace_id: None,
        })
}

#[cfg(test)]
#[path = "catalog/bounded_query_tests.rs"]
mod bounded_query_tests;

#[cfg(test)]
mod tests {
    #[cfg(feature = "local-runtime")]
    mod absence;
    #[cfg(feature = "local-runtime")]
    mod migration_identity;
    use super::*;
    use hmux_host::local_discovery::{
        ClaimLinkage, DiscoveryKey, HostLifetimeIdentity, LocalEndpoint, LocalEndpointKind,
        ManifestCommon, ReadyManifest, SessionClass, StartingManifest,
    };
    use hmux_session_protocol::{ProcessProof, ProtocolVersion, RuntimeContext, VersionRange};
    use tempfile::TempDir;

    pub(super) fn publish_ready(
        root: &DiscoveryRoot,
        workspace_id: &str,
        session_id: &str,
        capability_token: &str,
    ) {
        publish_ready_with_class(
            root,
            workspace_id,
            session_id,
            capability_token,
            SessionClass::Standalone,
        );
    }

    #[cfg(all(feature = "local-runtime", feature = "terminal-state-stream"))]
    fn fixture_fence(workspace_id: &str, session_id: &str) -> SessionFence {
        SessionFence {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 4,
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        }
    }

    fn publish_ready_with_class(
        root: &DiscoveryRoot,
        workspace_id: &str,
        session_id: &str,
        capability_token: &str,
        session_class: SessionClass,
    ) {
        publish_ready_with_class_and_kickoff(
            root,
            workspace_id,
            session_id,
            capability_token,
            session_class,
            None,
        );
    }

    fn publish_ready_with_class_and_kickoff(
        root: &DiscoveryRoot,
        workspace_id: &str,
        session_id: &str,
        capability_token: &str,
        session_class: SessionClass,
        kickoff_action_id: Option<&str>,
    ) {
        publish_ready_with_generation(
            root,
            workspace_id,
            session_id,
            capability_token,
            session_class,
            kickoff_action_id,
            "runner-1",
            4,
            "host-1",
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn publish_ready_with_generation(
        root: &DiscoveryRoot,
        workspace_id: &str,
        session_id: &str,
        capability_token: &str,
        session_class: SessionClass,
        kickoff_action_id: Option<&str>,
        runner_instance: &str,
        channel_epoch: u64,
        host_instance_id: &str,
    ) {
        let key =
            DiscoveryKey::new(workspace_id, session_id, runner_instance, channel_epoch).unwrap();
        let session = root.session(key).unwrap();
        let common = ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "build-v1".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 1 },
            },
            capabilities: vec!["screen_snapshot".into()],
            lifetime: HostLifetimeIdentity {
                workspace_id: workspace_id.into(),
                session_id: session_id.into(),
                runner_principal: "runner".into(),
                runner_instance: runner_instance.into(),
                channel_epoch,
            },
            host_instance_id: host_instance_id.into(),
            provider_id: "fixture".into(),
            runtime_context: RuntimeContext {
                runtime_host: Some("fixture-host".into()),
                worktree_alias: Some("fixture-worktree".into()),
                branch: Some("main".into()),
            },
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: kickoff_action_id.map(str::to_string),
            },
            host_process: ProcessProof {
                process_id: 100,
                start_marker: "host-start-1".into(),
            },
            created_unix_ms: 1,
            session_class,
            session_name: Some("fixture-shell".into()),
            retirement_policy: None,
        };
        let lock = session.acquire_lifetime_lock().unwrap();
        session
            .publish_starting(
                &lock,
                StartingManifest {
                    common: common.clone(),
                    starting_unix_ms: 2,
                },
            )
            .unwrap();
        session
            .publish_ready(
                &lock,
                ReadyManifest {
                    common,
                    provider_process: ProcessProof {
                        process_id: 101,
                        start_marker: "provider-start-1".into(),
                    },
                    terminal_epoch: "terminal-1".into(),
                    ready_output_seq: 8,
                    endpoint: LocalEndpoint {
                        kind: LocalEndpointKind::UnixSocket,
                        address: "host.sock".into(),
                    },
                    capability_token: capability_token.into(),
                    ready_unix_ms: 3,
                },
            )
            .unwrap();
    }

    #[cfg(feature = "local-runtime")]
    fn publish_exited_for(
        root: &DiscoveryRoot,
        workspace_id: &str,
        session_id: &str,
        capability_token: &str,
    ) {
        use hmux_host::local_discovery::{DiscoveryManifest, ExitedManifest};
        use hmux_host::provider_epoch::{ExitTombstone, ProviderExitKind};
        use hmux_session_protocol::{Exit, SessionFence};
        publish_ready(root, workspace_id, session_id, capability_token);
        let key = DiscoveryKey::new(workspace_id, session_id, "runner-1", 4).unwrap();
        let session = root.open_session(key).unwrap();
        let lock = session.acquire_lifetime_lock().unwrap();
        let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
            panic!("fixture must be ready before exit");
        };
        session
            .publish_exited(
                &lock,
                ExitedManifest {
                    common: ready.common.clone(),
                    tombstone: Box::new(ExitTombstone {
                        provider_conversation_identity: None,
                        fence: SessionFence {
                            workspace_id: workspace_id.into(),
                            session_id: session_id.into(),
                            runner_principal: "runner".into(),
                            runner_instance: "runner-1".into(),
                            channel_epoch: 4,
                            host_instance_id: ready.common.host_instance_id.clone(),
                            terminal_epoch: ready.terminal_epoch.clone(),
                        },
                        provider_process: ready.provider_process.clone(),
                        exit: Exit {
                            final_output_seq: ready.ready_output_seq,
                            exit_code: Some(0),
                            platform_status: None,
                            reason: "provider_exit".into(),
                        },
                        exit_kind: ProviderExitKind::Normal,
                        created_unix_ms: 4,
                        failure: None,
                    }),
                    endpoint: ready.endpoint,
                    capability_token: ready.capability_token,
                    exited_unix_ms: 4,
                },
            )
            .unwrap();
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn retire_exited_exact_archives_pointer_and_hides_from_census() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_exited_for(&root, "workspace", "session-1", "token-1");
        let catalog = LocalSessionCatalog::new(temp.path().join("hmux"));
        let session = catalog
            .open(&SessionSelector::new("session-1", Some("workspace".into())))
            .unwrap();

        assert!(catalog.retire_exited_exact(&session).unwrap());
        // 활성 포인터가 사라졌으니 census에서도 사라진다.
        assert!(matches!(
            catalog.find(&SessionSelector::new("session-1", Some("workspace".into()))),
            Err(ClientError::SessionNotFound { .. })
        ));
        // 같은 authority로의 재시도는 파괴 없이 no-op.
        assert!(!catalog.retire_exited_exact(&session).unwrap());
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn retire_exited_exact_refuses_a_live_session() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_ready(&root, "workspace", "session-1", "token-1");
        let catalog = LocalSessionCatalog::new(temp.path().join("hmux"));
        let session = catalog
            .open(&SessionSelector::new("session-1", Some("workspace".into())))
            .unwrap();

        let error = catalog.retire_exited_exact(&session).unwrap_err();
        assert!(matches!(
            error,
            ClientError::Discovery(DiscoveryError::InvalidManifestTransition { .. })
        ));
        // 살아 있는 세션의 discovery 포인터는 그대로다.
        assert!(
            catalog
                .find(&SessionSelector::new("session-1", Some("workspace".into())))
                .is_ok()
        );
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn retire_exited_exact_fences_a_replacement_generation() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_exited_for(&root, "workspace", "session-1", "token-1");
        let catalog = LocalSessionCatalog::new(temp.path().join("hmux"));
        let stale = catalog
            .open(&SessionSelector::new("session-1", Some("workspace".into())))
            .unwrap();
        // 낡은 authority를 든 사이 세션이 은퇴되고 같은 정체성으로 재생성됐다.
        assert!(catalog.retire_exited_exact(&stale).unwrap());
        publish_ready_with_generation(
            &root,
            "workspace",
            "session-1",
            "token-2",
            SessionClass::Standalone,
            None,
            "runner-2",
            5,
            "host-2",
        );

        let error = catalog.retire_exited_exact(&stale).unwrap_err();
        assert!(
            matches!(
                error,
                ClientError::Discovery(DiscoveryError::GenerationMismatch)
            ),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn missing_discovery_root_lists_no_sessions_without_creating_it() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("missing");
        let catalog = LocalSessionCatalog::new(&root);

        assert!(catalog.list().unwrap().is_empty());
        assert!(!root.exists());
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn absent_read_only_root_is_ignored_without_creating_either_root() {
        let temp = TempDir::new().unwrap();
        let canonical = temp.path().join("canonical");
        let legacy = temp.path().join("legacy");
        let catalog =
            LocalSessionCatalog::with_read_only_discovery_roots(&canonical, vec![legacy.clone()])
                .unwrap();

        assert!(catalog.list().unwrap().is_empty());
        assert!(!canonical.exists());
        assert!(!legacy.exists());
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn read_only_root_preserves_generation_and_cannot_be_cleaned_up() {
        let temp = TempDir::new().unwrap();
        let canonical = temp.path().join("canonical");
        let legacy_path = temp.path().join("legacy");
        let legacy = DiscoveryRoot::create(&legacy_path).unwrap();
        publish_ready_with_generation(
            &legacy,
            "workspace",
            "session-1",
            "token",
            SessionClass::Standalone,
            None,
            "legacy-runner",
            19,
            "legacy-host-generation",
        );
        let manifest_path = legacy
            .path()
            .join(
                DiscoveryKey::new("workspace", "session-1", "legacy-runner", 19)
                    .unwrap()
                    .relative_path(),
            )
            .join("manifest.json");
        let before = std::fs::read(&manifest_path).unwrap();
        let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
            &canonical,
            vec![legacy_path.clone()],
        )
        .unwrap();

        let session = catalog
            .open(&SessionSelector::new("session-1", Some("workspace".into())))
            .unwrap();
        assert_eq!(session.descriptor().runner_instance, "legacy-runner");
        assert_eq!(session.descriptor().channel_epoch, "19");
        assert_eq!(
            session.descriptor().host_instance_id,
            "legacy-host-generation"
        );
        assert!(matches!(
            catalog.cleanup_stale_exact(&session),
            Err(ClientError::ReadOnlyDiscoveryRoot { .. })
        ));
        assert_eq!(std::fs::read(&manifest_path).unwrap(), before);
        assert!(!canonical.exists());
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn duplicate_exact_generation_across_roots_is_listed_once() {
        let temp = TempDir::new().unwrap();
        let canonical_path = temp.path().join("canonical");
        let legacy_path = temp.path().join("legacy");
        let canonical = DiscoveryRoot::create(&canonical_path).unwrap();
        let legacy = DiscoveryRoot::create(&legacy_path).unwrap();
        publish_ready(&canonical, "workspace", "session-1", "token");
        publish_ready(&legacy, "workspace", "session-1", "token");
        let catalog =
            LocalSessionCatalog::with_read_only_discovery_roots(canonical_path, vec![legacy_path])
                .unwrap();

        assert_eq!(catalog.list().unwrap().len(), 1);
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn same_generation_with_different_authority_is_not_deduplicated() {
        let temp = TempDir::new().unwrap();
        let canonical_path = temp.path().join("canonical");
        let legacy_path = temp.path().join("legacy");
        let canonical = DiscoveryRoot::create(&canonical_path).unwrap();
        let legacy = DiscoveryRoot::create(&legacy_path).unwrap();
        publish_ready(&canonical, "workspace", "session-1", "canonical-token");
        publish_ready(&legacy, "workspace", "session-1", "legacy-token");
        let catalog =
            LocalSessionCatalog::with_read_only_discovery_roots(canonical_path, vec![legacy_path])
                .unwrap();

        assert!(matches!(
            catalog.list(),
            Err(ClientError::AmbiguousDiscoveryGeneration { .. })
        ));
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn competing_generation_across_roots_fails_closed() {
        let temp = TempDir::new().unwrap();
        let canonical_path = temp.path().join("canonical");
        let legacy_path = temp.path().join("legacy");
        let canonical = DiscoveryRoot::create(&canonical_path).unwrap();
        let legacy = DiscoveryRoot::create(&legacy_path).unwrap();
        publish_ready(&canonical, "workspace", "session-1", "token-a");
        publish_ready_with_generation(
            &legacy,
            "workspace",
            "session-1",
            "token-b",
            SessionClass::Standalone,
            None,
            "runner-2",
            5,
            "host-2",
        );
        let catalog =
            LocalSessionCatalog::with_read_only_discovery_roots(canonical_path, vec![legacy_path])
                .unwrap();

        assert!(matches!(
            catalog.find(&SessionSelector::new("session-1", Some("workspace".into()))),
            Err(ClientError::AmbiguousDiscoveryGeneration { .. })
        ));
        assert!(matches!(
            catalog.list(),
            Err(ClientError::AmbiguousDiscoveryGeneration { .. })
        ));
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn malformed_read_only_root_fails_closed() {
        let temp = TempDir::new().unwrap();
        let legacy = temp.path().join("legacy-file");
        std::fs::write(&legacy, b"not a discovery directory").unwrap();
        let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
            temp.path().join("canonical"),
            vec![legacy],
        )
        .unwrap();

        assert!(matches!(
            catalog.list(),
            Err(ClientError::Discovery(DiscoveryError::Security { .. }))
        ));
    }

    #[cfg(all(unix, feature = "local-runtime"))]
    #[test]
    fn symlinked_read_only_root_is_never_followed() {
        let temp = TempDir::new().unwrap();
        let real_path = temp.path().join("real");
        DiscoveryRoot::create(&real_path).unwrap();
        let linked_path = temp.path().join("linked");
        std::os::unix::fs::symlink(&real_path, &linked_path).unwrap();
        let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
            temp.path().join("canonical"),
            vec![linked_path],
        )
        .unwrap();

        assert!(matches!(
            catalog.list(),
            Err(ClientError::Discovery(DiscoveryError::Security { .. }))
        ));
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn read_only_catalog_accepts_past_the_legacy_root_result_limit() {
        let legacy_result_limit = 128_usize;
        let temp = TempDir::new().unwrap();
        let legacy_path = temp.path().join("legacy");
        let legacy = DiscoveryRoot::create(&legacy_path).unwrap();
        for index in 0..=legacy_result_limit {
            publish_ready(
                &legacy,
                "workspace",
                &format!("session-{index:03}"),
                "token",
            );
        }
        let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
            temp.path().join("canonical"),
            vec![legacy_path],
        )
        .unwrap();

        let sessions = catalog.list().unwrap();
        assert_eq!(sessions.len(), legacy_result_limit + 1);
        assert_eq!(sessions.first().unwrap().session_id, "session-000");
        assert_eq!(
            sessions.last().unwrap().session_id,
            format!("session-{legacy_result_limit:03}")
        );
    }

    #[test]
    fn ready_manifest_projects_to_redacted_client_descriptor() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready(&root, "workspace-1", "session-1", "secret-token");

        let catalog = LocalSessionCatalog::new(root_path);
        let sessions = catalog.list().unwrap();
        assert_eq!(sessions.len(), 1);
        let session = &sessions[0];
        assert_eq!(session.session_id, "session-1");
        assert_eq!(session.session_name.as_deref(), Some("fixture-shell"));
        assert_eq!(session.output_seq, "8");
        assert_eq!(session.provider_process.process_id, 101);

        let json = serde_json::to_string(session).unwrap();
        assert!(!json.contains("secret-token"));
        assert!(!json.contains("capability_token"));
    }

    #[cfg(all(feature = "local-runtime", feature = "terminal-state-stream"))]
    #[test]
    fn agent_prompt_connector_refuses_a_standalone_session_before_attach() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready(&root, "workspace-1", "session-1", "secret-token");

        let error = crate::TerminalSurfaceAttachment::connect_local_agent_prompt(
            &LocalSessionCatalog::new(root_path),
            &fixture_fence("workspace-1", "session-1"),
        )
        .unwrap_err();

        assert_eq!(error.code(), "hmux_agent_prompt_requires_managed");
    }

    #[test]
    fn exact_session_projects_its_raw_kickoff_action_id() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready_with_class_and_kickoff(
            &root,
            "workspace-1",
            "session-1",
            "secret-token",
            SessionClass::Managed,
            Some("adoption-1_0"),
        );

        let catalog = LocalSessionCatalog::new(root_path);
        assert_eq!(
            catalog
                .find_kickoff_action_id(&SessionSelector::new(
                    "session-1",
                    Some("workspace-1".into()),
                ))
                .unwrap()
                .as_deref(),
            Some("adoption-1_0")
        );
    }

    #[test]
    fn session_id_without_workspace_refuses_ambiguous_match() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready(&root, "workspace-a", "session-1", "token-a");
        publish_ready(&root, "workspace-b", "session-1", "token-b");

        let catalog = LocalSessionCatalog::new(root_path);
        let error = catalog
            .find(&SessionSelector::new("session-1", None))
            .unwrap_err();
        assert!(matches!(
            error,
            ClientError::AmbiguousSession { workspaces, .. }
                if workspaces == vec!["workspace-a", "workspace-b"]
        ));
        assert!(matches!(
            catalog.resolve("session-1"),
            Err(ClientError::AmbiguousSession { workspaces, .. })
                if workspaces == vec!["workspace-a", "workspace-b"]
        ));
    }

    #[test]
    fn human_target_resolves_name_and_printed_id_prefix() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready(
            &root,
            "workspace-a",
            "standalone_99684cadcecb4353a8a81a0e4f1fc60a",
            "token-a",
        );

        let catalog = LocalSessionCatalog::new(root_path);
        assert_eq!(
            catalog
                .resolve("fixture-shell")
                .unwrap()
                .descriptor()
                .session_id,
            "standalone_99684cadcecb4353a8a81a0e4f1fc60a"
        );
        assert_eq!(
            catalog.resolve("99684cad").unwrap().descriptor().session_id,
            "standalone_99684cadcecb4353a8a81a0e4f1fc60a"
        );
    }

    #[test]
    fn exact_session_id_wins_over_another_sessions_name() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready(&root, "workspace-a", "fixture-shell", "token-a");
        publish_ready(&root, "workspace-b", "standalone-other", "token-b");

        let catalog = LocalSessionCatalog::new(root_path);
        assert_eq!(
            catalog
                .resolve("fixture-shell")
                .unwrap()
                .descriptor()
                .session_id,
            "fixture-shell"
        );
    }

    #[test]
    fn exact_name_resolution_refuses_duplicate_names_across_workspaces() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready(&root, "workspace-a", "standalone-a", "token-a");
        publish_ready(&root, "workspace-b", "standalone-b", "token-b");

        let catalog = LocalSessionCatalog::new(root_path);
        let error = catalog.resolve_name("fixture-shell").unwrap_err();
        assert!(matches!(
            error,
            ClientError::AmbiguousTarget {
                identifier,
                candidates,
            } if identifier == "fixture-shell"
                && candidates == vec![
                    "fixture-shell (standalone-a in workspace-a)",
                    "fixture-shell (standalone-b in workspace-b)",
                ]
        ));
    }

    #[test]
    fn local_termination_refuses_managed_sessions_before_attach() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready_with_class(
            &root,
            "workspace-a",
            "managed-session",
            "token-a",
            SessionClass::Managed,
        );

        let catalog = LocalSessionCatalog::new(root_path);
        let session = catalog
            .open(&SessionSelector::new(
                "managed-session",
                Some("workspace-a".into()),
            ))
            .unwrap();
        let error = session
            .terminate_standalone(&catalog, std::time::Duration::ZERO)
            .unwrap_err();

        assert_eq!(error.code(), "hmux_standalone_termination_refused");
    }

    #[cfg(all(unix, feature = "local-runtime"))]
    #[test]
    /// A Host that does not answer can no longer be terminated, and that is a
    /// deliberate loss rather than a bug.
    ///
    /// This path used to fall through to signalling pids that had only been
    /// checked against a manifest. Once a manifest can describe another
    /// machine — which is the whole point of the relay work — those ids name
    /// unrelated *local* processes, and ordinary network flakiness is enough
    /// to reach it. There is no witness available here by construction: the
    /// dial failed, so nothing proved the Host is on this kernel.
    ///
    /// The capability that goes away is "force-terminate a local session whose
    /// socket is broken". A replacement needs its own explicit, locally
    /// witnessed path; it is tracked rather than silently dropped.
    fn local_termination_requires_a_verified_old_standalone_host_endpoint() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready(&root, "workspace-a", "standalone-session", "token-a");

        let catalog = LocalSessionCatalog::new(root_path);
        let session = catalog
            .open(&SessionSelector::new(
                "standalone-session",
                Some("workspace-a".into()),
            ))
            .unwrap();
        let error = session
            .terminate_standalone(&catalog, std::time::Duration::ZERO)
            .unwrap_err();

        assert_eq!(error.code(), "hmux_termination_unwitnessed");
    }

    /// Mints a real colocation witness the only way one can be minted: by
    /// dialing an actual pathname socket and asking the kernel who answered.
    /// There is deliberately no shortcut — that is the point of the type.
    #[cfg(all(unix, feature = "local-runtime"))]
    fn local_witness(scope_session: &str) -> (TempDir, ColocatedSameUserPeer) {
        use hmux_local_platform::local_peer_identity::verify_pathname_socket_same_user;
        use hmux_local_platform::peer_attestation::SessionScope;
        use std::os::unix::net::{UnixListener, UnixStream};

        let directory = TempDir::new().unwrap();
        let path = directory.path().join("witness.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let dialed = UnixStream::connect(&path).unwrap();
        let _accepted = listener.accept().unwrap();
        let credential = verify_pathname_socket_same_user(&dialed).unwrap();
        let witness =
            credential.bind_to_session(SessionScope::new("workspace-a", scope_session, "host-1"));
        (directory, witness)
    }

    #[cfg(all(unix, feature = "local-runtime"))]
    #[test]
    fn cleanup_exact_removes_only_the_matching_stale_generation() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready(&root, "workspace-a", "standalone-session", "token-a");
        let catalog = LocalSessionCatalog::new(root_path);
        let session = catalog.resolve("fixture-shell").unwrap();

        let (_witness_dir, witness) = local_witness("standalone-session");
        assert!(catalog.cleanup_exact(&witness, &session).unwrap());
        assert!(catalog.list().unwrap().is_empty());
    }

    #[cfg(all(unix, feature = "local-runtime"))]
    #[test]
    fn stale_cleanup_uses_the_lifetime_lock_without_dialing_or_signalling() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready(&root, "workspace-a", "standalone-session", "token-a");
        let catalog = LocalSessionCatalog::new(root_path);
        let session = catalog.resolve("fixture-shell").unwrap();

        assert!(catalog.cleanup_stale_exact(&session).unwrap());
        assert!(catalog.list().unwrap().is_empty());
    }

    #[cfg(all(unix, feature = "local-runtime"))]
    #[test]
    fn stale_cleanup_refuses_a_generation_whose_host_still_owns_the_lock() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&root_path).unwrap();
        publish_ready(&root, "workspace-a", "standalone-session", "token-a");
        let owned = root
            .open_session(
                DiscoveryKey::new("workspace-a", "standalone-session", "runner-1", 4).unwrap(),
            )
            .unwrap();
        let _host_lock = owned.acquire_lifetime_lock().unwrap();
        let catalog = LocalSessionCatalog::new(root_path);
        let session = catalog.resolve("fixture-shell").unwrap();

        let error = catalog.cleanup_stale_exact(&session).unwrap_err();
        assert!(matches!(
            error,
            ClientError::Discovery(DiscoveryError::AlreadyLocked { .. })
        ));
        assert_eq!(catalog.list().unwrap().len(), 1);
    }
}
