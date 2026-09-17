use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityViolation {
    Symlink,
    ExpectedDirectory,
    ExpectedRegularFile,
    WrongOwner { expected: u32, actual: u32 },
    WrongMode { expected: u32, actual: u32 },
    ReplacedDuringOpen,
    WindowsReparsePoint,
    WindowsOwnerMismatch,
    WindowsDaclMissing,
    WindowsDaclUnprotected,
    WindowsDaclUnexpectedAce,
    WindowsDaclMissingOwnerRights,
    WindowsDaclMissingSystemRights,
}

/// Filesystem facts only; callers retain discovery and recovery policy.
#[derive(Debug)]
pub enum StorageError {
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    Security {
        path: PathBuf,
        violation: SecurityViolation,
    },
}

impl StorageError {
    pub(super) fn io(operation: &'static str, path: &Path, source: io::Error) -> Self {
        Self::Io {
            operation,
            path: path.to_path_buf(),
            source,
        }
    }

    pub(super) fn security(path: &Path, violation: SecurityViolation) -> Self {
        Self::Security {
            path: path.to_path_buf(),
            violation,
        }
    }
}

impl fmt::Display for StorageError {
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
                "insecure private path {}: {violation:?}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for StorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Security { .. } => None,
        }
    }
}
