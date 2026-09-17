use super::private_storage;
use super::{DiscoveryError, DiscoveryRoot};
use serde::Serialize;
use std::fs;
use std::path::Path;

/// Bounded facts for the canonical discovery registration catalog.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryRegistrationCapacity {
    pub used: usize,
    pub maximum: usize,
    pub remaining: usize,
}

impl DiscoveryRegistrationCapacity {
    #[must_use]
    pub fn empty(maximum: usize) -> Self {
        Self {
            used: 0,
            maximum,
            remaining: maximum,
        }
    }
}

/// Count logical session directories without trusting or following an
/// unvalidated discovery ancestor.
///
/// Admission calls this while holding the root's shared maintenance lease and
/// separate exclusive registration lease, making the count plus subsequent
/// directory creation one serialized action. Status calls it under a shared
/// maintenance lease. Invalid `w_*` or `s_*` entries fail closed here: unlike
/// an attach census, capacity admission must not pretend a path is free when
/// another same-user writer could later make it valid.
pub(super) fn inspect(
    root: &DiscoveryRoot,
) -> Result<DiscoveryRegistrationCapacity, DiscoveryError> {
    private_storage::validate_directory(root.path())?;
    let maximum = root.limits().max_session_catalog_entries;
    let max_scan_entries = root.limits().max_session_census_scan_entries;
    let mut scanned_entries = 0_usize;
    let mut used = 0_usize;
    let workspace_entries = fs::read_dir(root.path()).map_err(|error| {
        DiscoveryError::io(
            "read discovery root for registration capacity",
            root.path(),
            error,
        )
    })?;
    for workspace_entry in workspace_entries {
        scanned_entries = scanned_entries.saturating_add(1);
        enforce_scan_bound(scanned_entries, max_scan_entries)?;
        let workspace_entry = workspace_entry.map_err(|error| {
            DiscoveryError::io(
                "read discovery workspace entry for registration capacity",
                root.path(),
                error,
            )
        })?;
        let workspace_path = workspace_entry.path();
        if !has_component_prefix(&workspace_path, "w_") {
            continue;
        }
        private_storage::validate_directory(&workspace_path)?;
        let session_entries = fs::read_dir(&workspace_path).map_err(|error| {
            DiscoveryError::io(
                "read discovery workspace for registration capacity",
                &workspace_path,
                error,
            )
        })?;
        for session_entry in session_entries {
            scanned_entries = scanned_entries.saturating_add(1);
            enforce_scan_bound(scanned_entries, max_scan_entries)?;
            let session_entry = session_entry.map_err(|error| {
                DiscoveryError::io(
                    "read discovery session entry for registration capacity",
                    &workspace_path,
                    error,
                )
            })?;
            let session_path = session_entry.path();
            if !has_component_prefix(&session_path, "s_") {
                continue;
            }
            private_storage::validate_directory(&session_path)?;
            used = used.saturating_add(1);
        }
    }
    Ok(DiscoveryRegistrationCapacity {
        used,
        maximum,
        remaining: maximum.saturating_sub(used),
    })
}

fn enforce_scan_bound(actual: usize, maximum: usize) -> Result<(), DiscoveryError> {
    if actual > maximum {
        return Err(DiscoveryError::LookupScanLimitExceeded { maximum });
    }
    Ok(())
}

fn has_component_prefix(path: &Path, prefix: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(prefix))
}
