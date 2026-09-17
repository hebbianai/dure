use crate::local_protocol::WorkingDirectorySource;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkingDirectoryObservation {
    pub path: String,
    pub source: WorkingDirectorySource,
}

impl WorkingDirectoryObservation {
    #[must_use]
    pub fn new(path: impl Into<String>, source: WorkingDirectorySource) -> Self {
        Self {
            path: path.into(),
            source,
        }
    }
}

pub(super) fn valid_path(path: &str, maximum_path_bytes: usize) -> bool {
    !path.is_empty() && path.len() <= maximum_path_bytes && !path.chars().any(char::is_control)
}
