use sha2::{Digest, Sha256};
use std::path::Path;

/// Derive the canonical local workspace identity from its provider cwd.
#[must_use]
pub fn workspace_id_for_path(path: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(path.as_os_str().as_encoded_bytes());
    format!("workspace_{:.16x}", digest.finalize())
}
