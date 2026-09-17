use super::discovery_key::{SessionIdLookupKey, decode_workspace_directory};
use super::manifest_store::read_current_manifest_at;
use super::private_storage;
use super::{
    DiscoveryError, DiscoveryKey, DiscoveryManifest, DiscoveryRoot, SessionLookupKey,
    StaleDiscoveryReason,
};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveredSession {
    pub key: DiscoveryKey,
    pub manifest: DiscoveryManifest,
    pub discovery_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExitedSessionCensus {
    pub sessions: Vec<DiscoveredSession>,
    pub has_more: bool,
}

pub(super) fn find_unique(
    root: &DiscoveryRoot,
    lookup: &SessionLookupKey,
) -> Result<DiscoveredSession, DiscoveryError> {
    find_unique_with_starting(root, lookup, false)
}

pub(super) fn find_unique_current(
    root: &DiscoveryRoot,
    lookup: &SessionLookupKey,
) -> Result<DiscoveredSession, DiscoveryError> {
    find_unique_with_starting(root, lookup, true)
}

fn find_unique_with_starting(
    root: &DiscoveryRoot,
    lookup: &SessionLookupKey,
    include_starting: bool,
) -> Result<DiscoveredSession, DiscoveryError> {
    let base = root.session_base_path(lookup);
    if !private_storage::path_entry_exists(&base)? {
        return Err(DiscoveryError::SessionNotFound);
    }
    validate_lookup_ancestors(root.path(), &base)?;
    read_candidate(root, &base, lookup, include_starting)
}

/// Enumerate every discoverable session under this root as a read-only census.
///
/// Why: the standalone (tmux-like) `ls` verb has no daemon inventory to query,
/// so it must walk the per-user discovery tree directly. This applies the same
/// private_storage and manifest-validation guards that `find_unique` uses: the
/// root and every `w_*`/`s_*` ancestor must be a private (non-symlink,
/// owner-only) directory, each manifest is size-bounded and validated, and the
/// manifest's own lifetime must resolve back to the exact directory it was read
/// from (the path-identity fence). A same-user-writable relabel, a symlinked
/// entry, or a truncated manifest can therefore never surface as a session; such
/// debris is skipped rather than fabricated into a listing.
///
/// Tolerance vs. `find_unique`: a census must survive transient and partial
/// state, so a Starting, retired (missing manifest), stale, or per-entry
/// insecure directory is skipped instead of aborting the whole walk. The
/// returned census is hard-bounded by `max_session_lookup_entries`: debris does
/// not consume that result budget, while more valid sessions produce a typed
/// error rather than a silently truncated inventory. The walk uses bounded
/// per-manifest reads and bounded result memory, and StaleDiscovery semantics
/// are not weakened: a stale entry is simply excluded, never promoted to
/// attachable.
pub(super) fn list_sessions(
    root: &DiscoveryRoot,
) -> Result<Vec<DiscoveredSession>, DiscoveryError> {
    let mut discovered = Vec::new();
    let max_entries = root.limits().max_session_lookup_entries;
    scan_listed_sessions(root, |session| {
        discovered.push(session);
        if discovered.len() > max_entries {
            return Err(DiscoveryError::LookupLimitExceeded {
                maximum: max_entries,
            });
        }
        Ok(())
    })?;
    discovered.sort_by(compare_sessions);
    Ok(discovered)
}

/// Resolve one opaque session id without enumerating unrelated session paths.
///
/// Workspace directories are the existing injective discovery index. The
/// lookup scans that bounded first level, derives only the target `s_*` path
/// in each workspace, and then reuses [`find_unique`] for manifest, lifecycle,
/// and path-generation validation. No secondary index or fallback authority is
/// written, and a matching but unreadable/not-ready path fails closed instead
/// of allowing another workspace to be adopted as uniquely healthy.
pub(super) fn list_sessions_by_id(
    root: &DiscoveryRoot,
    lookup: &SessionIdLookupKey,
) -> Result<Vec<DiscoveredSession>, DiscoveryError> {
    let root_path = root.path();
    private_storage::validate_directory(root_path)?;
    let workspace_entries = match fs::read_dir(root_path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(DiscoveryError::io("read discovery root", root_path, error)),
    };
    let mut sessions = Vec::new();
    let mut scanned_entries = 0_usize;
    for workspace_entry in workspace_entries {
        scanned_entries = scanned_entries.saturating_add(1);
        if scanned_entries > root.limits().max_session_census_scan_entries {
            return Err(DiscoveryError::LookupScanLimitExceeded {
                maximum: root.limits().max_session_census_scan_entries,
            });
        }
        let workspace_entry = workspace_entry.map_err(|error| {
            DiscoveryError::io("read discovery workspace entry", root_path, error)
        })?;
        let workspace_path = workspace_entry.path();
        let Some(workspace_id) = decode_workspace_directory(&workspace_path) else {
            continue;
        };
        private_storage::validate_directory(&workspace_path)?;
        let exact = SessionLookupKey::new(workspace_id, lookup.session_id())?;
        match find_unique(root, &exact) {
            Ok(session) => sessions.push(session),
            Err(DiscoveryError::SessionNotFound) => continue,
            Err(error) => return Err(error),
        }
        if sessions.len() > root.limits().max_session_lookup_candidates {
            return Err(DiscoveryError::LookupLimitExceeded {
                maximum: root.limits().max_session_lookup_candidates,
            });
        }
    }
    sessions.sort_by(compare_sessions);
    Ok(sessions)
}

/// Return one complete, deterministic client catalog above the legacy lookup
/// result limit while preserving a separate hard memory bound.
///
/// The filesystem is scanned exactly once. This matters because cursor-based
/// rescans could skip a concurrently inserted identity and then falsely claim
/// that a human-facing name or prefix was unambiguous.
pub(super) fn list_sessions_bounded(
    root: &DiscoveryRoot,
    maximum: usize,
) -> Result<Vec<DiscoveredSession>, DiscoveryError> {
    if maximum > root.limits().max_session_catalog_entries {
        return Err(DiscoveryError::LookupLimitExceeded {
            maximum: root.limits().max_session_catalog_entries,
        });
    }
    let mut sessions = Vec::new();
    scan_listed_sessions(root, |session| {
        sessions.push(session);
        if sessions.len() > maximum {
            return Err(DiscoveryError::LookupLimitExceeded { maximum });
        }
        Ok(())
    })?;
    sessions.sort_by(compare_sessions);
    Ok(sessions)
}

/// Visit one complete discovery census without retaining every manifest.
///
/// The scan and path-security semantics are identical to [`list_sessions`].
/// Callers that only need a bounded projection can retain their selected rows
/// while this function continues the authoritative census to completion.
pub(super) fn visit_sessions(
    root: &DiscoveryRoot,
    mut observe: impl FnMut(DiscoveredSession),
) -> Result<(), DiscoveryError> {
    scan_listed_sessions(root, |session| {
        observe(session);
        Ok(())
    })
}

/// Find only sessions with one exact human-facing name.
///
/// The complete catalog result limit is intentionally unrelated to this
/// lookup. Unrelated valid sessions consume the bounded filesystem scan but
/// not result memory, so a large catalog cannot make a new unique name
/// unavailable merely because listing the whole catalog would overflow.
pub(super) fn list_sessions_named(
    root: &DiscoveryRoot,
    name: &str,
) -> Result<Vec<DiscoveredSession>, DiscoveryError> {
    let mut sessions = Vec::new();
    let maximum = root.limits().max_session_lookup_candidates;
    scan_listed_sessions(root, |session| {
        if session.manifest.common().session_name.as_deref() != Some(name) {
            return Ok(());
        }
        sessions.push(session);
        if sessions.len() > maximum {
            return Err(DiscoveryError::LookupLimitExceeded { maximum });
        }
        Ok(())
    })?;
    sessions.sort_by(compare_sessions);
    Ok(sessions)
}

/// Enumerate only exited active pointers with a separate candidate bound.
///
/// Ready sessions and malformed/retired debris still consume the raw scan
/// budget, but never the result budget. When more exited candidates exist, the
/// lexicographically smallest exact identities are retained so pagination by
/// repeated apply remains deterministic across filesystem enumeration orders.
pub(super) fn list_exited_sessions(
    root: &DiscoveryRoot,
    maximum: usize,
    after: Option<&DiscoveryKey>,
) -> Result<ExitedSessionCensus, DiscoveryError> {
    if maximum > root.limits().max_session_lookup_entries {
        return Err(DiscoveryError::LookupLimitExceeded {
            maximum: root.limits().max_session_lookup_entries,
        });
    }
    let mut sessions = Vec::with_capacity(maximum);
    let mut has_more = false;
    scan_listed_sessions(root, |session| {
        if !matches!(session.manifest, DiscoveryManifest::Exited(_)) {
            return Ok(());
        }
        if after.is_some_and(|cursor| compare_session_to_key(&session, cursor).is_le()) {
            return Ok(());
        }
        if sessions.len() < maximum {
            sessions.push(session);
            sessions.sort_by(compare_sessions);
        } else {
            has_more = true;
            if maximum > 0
                && compare_sessions(&session, sessions.last().expect("non-empty bounded census"))
                    .is_lt()
            {
                sessions.pop();
                sessions.push(session);
                sessions.sort_by(compare_sessions);
            }
        }
        Ok(())
    })?;
    Ok(ExitedSessionCensus { sessions, has_more })
}

fn scan_listed_sessions(
    root: &DiscoveryRoot,
    mut observe: impl FnMut(DiscoveredSession) -> Result<(), DiscoveryError>,
) -> Result<(), DiscoveryError> {
    let root_path = root.path();
    private_storage::validate_directory(root_path)?;
    let workspace_entries = match fs::read_dir(root_path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(DiscoveryError::io("read discovery root", root_path, error)),
    };
    let max_scan_entries = root.limits().max_session_census_scan_entries;
    let mut scanned_entries = 0_usize;
    for workspace_entry in workspace_entries {
        scanned_entries = scanned_entries.saturating_add(1);
        if scanned_entries > max_scan_entries {
            return Err(DiscoveryError::LookupScanLimitExceeded {
                maximum: max_scan_entries,
            });
        }
        let Ok(workspace_entry) = workspace_entry else {
            // A census cannot attribute an iterator error to a trustworthy
            // workspace identity. Treat it like other per-entry debris so one
            // damaged directory slot cannot blind unrelated valid sessions.
            continue;
        };
        let workspace_path = workspace_entry.path();
        if !has_component_prefix(&workspace_path, "w_") {
            continue;
        }
        // Refuse to descend into a symlinked or non-private workspace directory
        // before read_dir can follow it; a non-conforming entry is skipped, not
        // fatal, so one hostile directory cannot blind the whole census.
        if private_storage::validate_directory(&workspace_path).is_err() {
            continue;
        }
        let session_entries = match fs::read_dir(&workspace_path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for session_entry in session_entries {
            scanned_entries = scanned_entries.saturating_add(1);
            if scanned_entries > max_scan_entries {
                return Err(DiscoveryError::LookupScanLimitExceeded {
                    maximum: max_scan_entries,
                });
            }
            let Ok(session_entry) = session_entry else {
                continue;
            };
            let session_path = session_entry.path();
            if !has_component_prefix(&session_path, "s_") {
                continue;
            }
            // A stale, starting, missing, or per-entry insecure session is
            // tolerated (skipped) so the census stays truthful about the
            // sessions that are actually attachable.
            if let Ok(Some(session)) = read_listed_session(root, &session_path) {
                observe(session)?;
            }
        }
    }
    Ok(())
}

fn compare_sessions(left: &DiscoveredSession, right: &DiscoveredSession) -> std::cmp::Ordering {
    compare_session_to_key(left, &right.key)
}

fn compare_session_to_key(session: &DiscoveredSession, key: &DiscoveryKey) -> std::cmp::Ordering {
    (
        session.key.workspace_id(),
        session.key.session_id(),
        session.key.runner_instance(),
        session.key.channel_epoch(),
    )
        .cmp(&(
            key.workspace_id(),
            key.session_id(),
            key.runner_instance(),
            key.channel_epoch(),
        ))
}

fn read_listed_session(
    root: &DiscoveryRoot,
    session_path: &Path,
) -> Result<Option<DiscoveredSession>, DiscoveryError> {
    // Same ancestor validation find_unique performs before trusting the path.
    validate_lookup_ancestors(root.path(), session_path)?;
    let manifest_path = session_path.join("manifest.json");
    if !private_storage::path_entry_exists(&manifest_path)? {
        // A retired (archived tombstone) or not-yet-written session; nothing
        // attachable lives here, so exclude it from the census.
        return Ok(None);
    }
    let manifest = match read_current_manifest_at(&manifest_path, root.limits()) {
        Ok(manifest) => manifest,
        // A truncated, oversized, or relabeled manifest is stale debris in a
        // census context, not a hard failure.
        Err(_) => return Ok(None),
    };
    if matches!(manifest, DiscoveryManifest::Starting(_)) {
        return Ok(None);
    }
    // Path-identity fence: the manifest's own lifetime must resolve back to this
    // exact discovery path, exactly as read_candidate enforces, so a manifest
    // copied under a mismatched directory is never presented as a live session.
    let lifetime = &manifest.common().lifetime;
    let Ok(key) = DiscoveryKey::new(
        &lifetime.workspace_id,
        &lifetime.session_id,
        &lifetime.runner_instance,
        lifetime.channel_epoch,
    ) else {
        return Ok(None);
    };
    if root.path().join(key.relative_path()) != session_path {
        return Ok(None);
    }
    Ok(Some(DiscoveredSession {
        key,
        manifest,
        discovery_path: session_path.to_path_buf(),
    }))
}

fn has_component_prefix(path: &Path, prefix: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(prefix))
}

pub(super) fn validate_lookup_ancestors(root: &Path, base: &Path) -> Result<(), DiscoveryError> {
    private_storage::validate_directory(root)?;
    let relative = base
        .strip_prefix(root)
        .expect("session base is always constructed beneath discovery root");
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component);
        private_storage::validate_directory(&path)?;
    }
    Ok(())
}

fn read_candidate(
    root: &DiscoveryRoot,
    discovery_path: &Path,
    lookup: &SessionLookupKey,
    include_starting: bool,
) -> Result<DiscoveredSession, DiscoveryError> {
    let manifest_path = discovery_path.join("manifest.json");
    if !private_storage::path_entry_exists(&manifest_path)? {
        let key = super::DiscoveryKey::new(
            lookup.workspace_id(),
            lookup.session_id(),
            "retired-placeholder",
            1,
        )
        .map_err(|_| stale(discovery_path, StaleDiscoveryReason::PathIdentityMismatch))?;
        let session = root.open_session(key)?;
        if session.has_retired_exited()? {
            return Err(DiscoveryError::SessionNotFound);
        }
        return Err(stale(discovery_path, StaleDiscoveryReason::MissingManifest));
    }
    let manifest = read_current_manifest_at(&manifest_path, root.limits()).map_err(|error| {
        stale_or_security(error, discovery_path, StaleDiscoveryReason::InvalidManifest)
    })?;
    if !include_starting && matches!(manifest, DiscoveryManifest::Starting(_)) {
        return Err(stale(discovery_path, StaleDiscoveryReason::NotReady));
    }
    let lifetime = &manifest.common().lifetime;
    let key = DiscoveryKey::new(
        &lifetime.workspace_id,
        &lifetime.session_id,
        &lifetime.runner_instance,
        lifetime.channel_epoch,
    )
    .map_err(|_| stale(discovery_path, StaleDiscoveryReason::PathIdentityMismatch))?;
    if root.path().join(key.relative_path()) != discovery_path {
        return Err(stale(
            discovery_path,
            StaleDiscoveryReason::PathIdentityMismatch,
        ));
    }
    Ok(DiscoveredSession {
        key,
        manifest,
        discovery_path: discovery_path.to_path_buf(),
    })
}

fn stale(path: &Path, reason: StaleDiscoveryReason) -> DiscoveryError {
    DiscoveryError::StaleDiscovery {
        path: path.to_path_buf(),
        reason,
    }
}

fn stale_or_security(
    error: DiscoveryError,
    path: &Path,
    reason: StaleDiscoveryReason,
) -> DiscoveryError {
    match error {
        DiscoveryError::Serialization(_)
        | DiscoveryError::ManifestValidation(_)
        | DiscoveryError::ManifestTooLarge { .. } => stale(path, reason),
        DiscoveryError::Io { ref source, .. } if source.kind() == std::io::ErrorKind::NotFound => {
            stale(path, StaleDiscoveryReason::MissingManifest)
        }
        DiscoveryError::Security {
            violation: super::SecurityViolation::ExpectedDirectory,
            ..
        } => stale(path, StaleDiscoveryReason::UnexpectedEntry),
        _ => error,
    }
}
