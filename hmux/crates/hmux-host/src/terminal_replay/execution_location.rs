use crate::local_protocol::ExecutionLocation;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionLocationObservation {
    pub location: ExecutionLocation,
}

impl ExecutionLocationObservation {
    #[must_use]
    pub fn local() -> Self {
        Self {
            location: ExecutionLocation::Local,
        }
    }

    #[must_use]
    pub fn ssh(target: impl Into<String>) -> Self {
        Self {
            location: ExecutionLocation::Ssh {
                target: target.into(),
            },
        }
    }
}
