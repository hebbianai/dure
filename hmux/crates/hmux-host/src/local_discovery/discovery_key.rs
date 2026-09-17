use std::fmt;
use std::path::{Path, PathBuf};

pub const MAX_DISCOVERY_ID_BYTES: usize = 96;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SessionIdLookupKey {
    session_id: String,
}

impl SessionIdLookupKey {
    pub(super) fn new(session_id: impl Into<String>) -> Result<Self, DiscoveryKeyError> {
        let key = Self {
            session_id: session_id.into(),
        };
        validate_id("session_id", &key.session_id)?;
        Ok(key)
    }

    #[must_use]
    pub(super) fn session_id(&self) -> &str {
        &self.session_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionLookupKey {
    workspace_id: String,
    session_id: String,
}

impl SessionLookupKey {
    pub fn new(
        workspace_id: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Result<Self, DiscoveryKeyError> {
        let key = Self {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
        };
        validate_id("workspace_id", &key.workspace_id)?;
        validate_id("session_id", &key.session_id)?;
        Ok(key)
    }

    #[must_use]
    pub fn relative_path(&self) -> PathBuf {
        PathBuf::from(format!("w_{}", encode_component(&self.workspace_id)))
            .join(format!("s_{}", encode_component(&self.session_id)))
    }

    #[must_use]
    pub(super) fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub(super) fn session_id(&self) -> &str {
        &self.session_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveryKey {
    workspace_id: String,
    session_id: String,
    runner_instance: String,
    channel_epoch: u64,
}

impl DiscoveryKey {
    pub fn new(
        workspace_id: impl Into<String>,
        session_id: impl Into<String>,
        runner_instance: impl Into<String>,
        channel_epoch: u64,
    ) -> Result<Self, DiscoveryKeyError> {
        let key = Self {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
            runner_instance: runner_instance.into(),
            channel_epoch,
        };
        validate_id("workspace_id", &key.workspace_id)?;
        validate_id("session_id", &key.session_id)?;
        validate_id("runner_instance", &key.runner_instance)?;
        Ok(key)
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn runner_instance(&self) -> &str {
        &self.runner_instance
    }

    #[must_use]
    pub fn channel_epoch(&self) -> u64 {
        self.channel_epoch
    }

    #[must_use]
    pub fn relative_path(&self) -> PathBuf {
        // Why: runner instance and channel epoch fence one provider generation,
        // not the Session Host lifetime. Keeping them out of the path gives the
        // logical session exactly one OS lock while an explicit replacement
        // updates the mutable fence inside that Host.
        SessionLookupKey {
            workspace_id: self.workspace_id.clone(),
            session_id: self.session_id.clone(),
        }
        .relative_path()
    }
}

fn validate_id(field: &'static str, value: &str) -> Result<(), DiscoveryKeyError> {
    if value.is_empty() {
        return Err(DiscoveryKeyError::Empty { field });
    }
    if value.len() > MAX_DISCOVERY_ID_BYTES {
        return Err(DiscoveryKeyError::TooLong {
            field,
            actual: value.len(),
            maximum: MAX_DISCOVERY_ID_BYTES,
        });
    }
    Ok(())
}

fn encode_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value.bytes() {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

pub(super) fn decode_workspace_directory(path: &Path) -> Option<String> {
    let encoded = path.file_name()?.to_str()?.strip_prefix("w_")?;
    decode_component(encoded)
}

fn decode_component(encoded: &str) -> Option<String> {
    if encoded.is_empty()
        || encoded.len() > MAX_DISCOVERY_ID_BYTES.saturating_mul(2)
        || encoded.len() % 2 != 0
    {
        return None;
    }
    let mut decoded = Vec::with_capacity(encoded.len() / 2);
    for pair in encoded.as_bytes().chunks_exact(2) {
        decoded.push(decode_hex(pair[0])?.checked_mul(16)? + decode_hex(pair[1])?);
    }
    String::from_utf8(decoded).ok()
}

fn decode_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DiscoveryKeyError {
    Empty {
        field: &'static str,
    },
    TooLong {
        field: &'static str,
        actual: usize,
        maximum: usize,
    },
}

impl fmt::Display for DiscoveryKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty { field } => write!(formatter, "{field} must not be empty"),
            Self::TooLong {
                field,
                actual,
                maximum,
            } => write!(
                formatter,
                "{field} length {actual} exceeds maximum {maximum}"
            ),
        }
    }
}

impl std::error::Error for DiscoveryKeyError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn path_encoding_is_injective_for_lossy_filename_collisions() {
        let candidates = ["a/b", "a?b", "a_b", "a\\b", "é", "e\u{301}"];
        let paths = candidates
            .into_iter()
            .map(|workspace| {
                let path = DiscoveryKey::new(workspace, "session", "runner", 1)
                    .unwrap()
                    .relative_path();
                assert_eq!(
                    decode_workspace_directory(path.parent().unwrap()).as_deref(),
                    Some(workspace)
                );
                path
            })
            .collect::<HashSet<_>>();

        assert_eq!(paths.len(), candidates.len());
    }

    #[test]
    fn tuple_boundaries_cannot_collide() {
        let left = DiscoveryKey::new("ab", "c", "runner", 1).unwrap();
        let right = DiscoveryKey::new("a", "bc", "runner", 1).unwrap();

        assert_ne!(left.relative_path(), right.relative_path());
    }

    #[test]
    fn oversized_identity_is_rejected_before_path_construction() {
        assert!(matches!(
            DiscoveryKey::new("x".repeat(MAX_DISCOVERY_ID_BYTES + 1), "s", "r", 1),
            Err(DiscoveryKeyError::TooLong {
                field: "workspace_id",
                ..
            })
        ));
    }
}
