use super::{DiscoveryKeyError, ManifestValidationError};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

pub use hmux_local_platform::private_storage::SecurityViolation;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StaleDiscoveryReason {
    MissingManifest,
    InvalidManifest,
    NotReady,
    PathIdentityMismatch,
    UnexpectedEntry,
}

#[derive(Debug)]
pub enum DiscoveryError {
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    Security {
        path: PathBuf,
        violation: SecurityViolation,
    },
    UnsupportedPlatformSecurity {
        path: PathBuf,
        platform: &'static str,
    },
    ManifestValidation(ManifestValidationError),
    InvalidDiscoveryKey(DiscoveryKeyError),
    Serialization(serde_json::Error),
    ManifestTooLarge {
        actual: u64,
        maximum: usize,
    },
    PresentationCheckpointInvalid {
        reason: &'static str,
    },
    PresentationCheckpointTooLarge {
        actual: u64,
        maximum: usize,
    },
    AlreadyLocked {
        path: PathBuf,
    },
    ManifestConflict,
    InvalidManifestTransition {
        from: &'static str,
        to: &'static str,
    },
    ManifestKeyMismatch,
    LockScopeMismatch,
    GenerationMismatch,
    SessionNotFound,
    AmbiguousSession {
        candidates: usize,
    },
    LookupLimitExceeded {
        maximum: usize,
    },
    LookupScanLimitExceeded {
        maximum: usize,
    },
    RegistrationCapacityExceeded {
        used: usize,
        maximum: usize,
        remaining: usize,
    },
    RetiredHistoryRecordCapacityExceeded {
        actual: usize,
        maximum: usize,
    },
    RetiredHistoryByteCapacityExceeded {
        actual: u64,
        maximum: u64,
    },
    RetiredHistoryScanCapacityExceeded {
        actual: usize,
        maximum: usize,
    },
    GcPolicyInvalid,
    TemporaryFileCollisionLimit {
        attempts: usize,
    },
    StaleDiscovery {
        path: PathBuf,
        reason: StaleDiscoveryReason,
    },
}

impl DiscoveryError {
    pub(super) fn io(operation: &'static str, path: &Path, source: io::Error) -> Self {
        Self::Io {
            operation,
            path: path.to_path_buf(),
            source,
        }
    }

    #[cfg(test)]
    pub(super) fn security(path: &Path, violation: SecurityViolation) -> Self {
        Self::Security {
            path: path.to_path_buf(),
            violation,
        }
    }
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io {
                operation,
                path,
                source,
            } => write!(
                formatter,
                "{operation} at {} failed: {source}",
                path.display()
            ),
            Self::Security { path, violation } => write!(
                formatter,
                "insecure discovery path {}: {violation:?}",
                path.display()
            ),
            Self::UnsupportedPlatformSecurity { path, platform } => write!(
                formatter,
                "private discovery is unsupported on {platform} at {}",
                path.display()
            ),
            Self::ManifestValidation(error) => write!(formatter, "invalid manifest: {error}"),
            Self::InvalidDiscoveryKey(error) => write!(formatter, "invalid discovery key: {error}"),
            Self::Serialization(error) => {
                write!(formatter, "manifest serialization failed: {error}")
            }
            Self::ManifestTooLarge { actual, maximum } => {
                write!(
                    formatter,
                    "manifest length {actual} exceeds maximum {maximum}"
                )
            }
            Self::PresentationCheckpointInvalid { reason } => {
                write!(formatter, "invalid presentation checkpoint: {reason}")
            }
            Self::PresentationCheckpointTooLarge { actual, maximum } => write!(
                formatter,
                "presentation checkpoint length {actual} exceeds maximum {maximum}"
            ),
            Self::AlreadyLocked { path } => write!(
                formatter,
                "session lifetime is already locked at {}",
                path.display()
            ),
            Self::ManifestConflict => {
                write!(formatter, "manifest belongs to another host generation")
            }
            Self::InvalidManifestTransition { from, to } => {
                write!(formatter, "invalid manifest transition from {from} to {to}")
            }
            Self::ManifestKeyMismatch => write!(
                formatter,
                "manifest identity does not match its discovery key"
            ),
            Self::LockScopeMismatch => {
                write!(formatter, "lifetime lock belongs to another discovery key")
            }
            Self::GenerationMismatch => write!(
                formatter,
                "current manifest generation does not match cleanup target"
            ),
            Self::SessionNotFound => write!(formatter, "no ready manifest matches the session"),
            Self::AmbiguousSession { candidates } => write!(
                formatter,
                "session lookup found {candidates} ready manifests"
            ),
            Self::RegistrationCapacityExceeded {
                used,
                maximum,
                remaining,
            } => write!(
                formatter,
                "discovery registration capacity is exhausted: used={used}, maximum={maximum}, remaining={remaining}"
            ),
            Self::LookupLimitExceeded { maximum } => write!(
                formatter,
                "session lookup exceeded its {maximum} entry bound"
            ),
            Self::LookupScanLimitExceeded { maximum } => write!(
                formatter,
                "session lookup exceeded its {maximum} raw scan bound"
            ),
            Self::RetiredHistoryRecordCapacityExceeded { actual, maximum } => write!(
                formatter,
                "retired discovery history record count {actual} exceeds capacity {maximum}"
            ),
            Self::RetiredHistoryByteCapacityExceeded { actual, maximum } => write!(
                formatter,
                "retired discovery history bytes {actual} exceed capacity {maximum}"
            ),
            Self::RetiredHistoryScanCapacityExceeded { actual, maximum } => write!(
                formatter,
                "retired discovery history raw entries {actual} exceed capacity {maximum}"
            ),
            Self::GcPolicyInvalid => write!(formatter, "discovery GC policy is invalid"),
            Self::TemporaryFileCollisionLimit { attempts } => write!(
                formatter,
                "could not allocate a unique temporary manifest after {attempts} attempts"
            ),
            Self::StaleDiscovery { path, reason } => write!(
                formatter,
                "stale discovery entry at {}: {reason:?}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for DiscoveryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::ManifestValidation(error) => Some(error),
            Self::InvalidDiscoveryKey(error) => Some(error),
            Self::Serialization(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ManifestValidationError> for DiscoveryError {
    fn from(error: ManifestValidationError) -> Self {
        Self::ManifestValidation(error)
    }
}

impl From<DiscoveryKeyError> for DiscoveryError {
    fn from(error: DiscoveryKeyError) -> Self {
        Self::InvalidDiscoveryKey(error)
    }
}

impl From<hmux_local_platform::private_storage::StorageError> for DiscoveryError {
    fn from(error: hmux_local_platform::private_storage::StorageError) -> Self {
        use hmux_local_platform::private_storage::StorageError;
        match error {
            StorageError::Io {
                operation,
                path,
                source,
            } => Self::Io {
                operation,
                path,
                source,
            },
            StorageError::Security { path, violation } => Self::Security { path, violation },
        }
    }
}
