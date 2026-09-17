use super::{
    RemoteManagedCreateChainStopError, RemoteManagedCreateError, RemoteManagedCreateReconcileError,
    RemoteManagedRehostError, RemoteManagedStopError,
};
use crate::{CatalogError, ChannelCompletion};

fn before_answer<E>(
    error: CatalogError,
    unavailable: fn(String) -> E,
    unknown: fn(String) -> E,
) -> E {
    // Only a missing/non-executable command before any answer proves the
    // helper could not run. Other failures may follow an admitted operation.
    let project = if matches!(
        &error,
        CatalogError::CommandFailed(ChannelCompletion {
            exit_status: Some(126 | 127),
            ..
        })
    ) {
        unavailable
    } else {
        unknown
    };
    project(error.to_string())
}

impl From<CatalogError> for RemoteManagedRehostError {
    fn from(error: CatalogError) -> Self {
        before_answer(error, Self::RuntimeUpdateRequired, Self::OutcomeUnknown)
    }
}

impl From<CatalogError> for RemoteManagedCreateError {
    fn from(error: CatalogError) -> Self {
        before_answer(error, Self::RuntimeUpdateRequired, Self::OutcomeUnknown)
    }
}

impl From<CatalogError> for RemoteManagedCreateReconcileError {
    fn from(error: CatalogError) -> Self {
        before_answer(error, Self::RuntimeUpdateRequired, Self::OutcomeUnknown)
    }
}

impl From<CatalogError> for RemoteManagedCreateChainStopError {
    fn from(error: CatalogError) -> Self {
        before_answer(error, Self::RuntimeUpdateRequired, Self::OutcomeUnknown)
    }
}

impl From<CatalogError> for RemoteManagedStopError {
    fn from(error: CatalogError) -> Self {
        before_answer(error, Self::RuntimeUpdateRequired, Self::OutcomeUnknown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(error: impl Fn() -> CatalogError) -> [&'static str; 5] {
        [
            RemoteManagedRehostError::from(error()).code(),
            RemoteManagedCreateError::from(error()).code(),
            RemoteManagedCreateReconcileError::from(error()).code(),
            RemoteManagedCreateChainStopError::from(error()).code(),
            RemoteManagedStopError::from(error()).code(),
        ]
    }

    #[test]
    fn every_broker_projects_an_unavailable_command_consistently() {
        for status in [126, 127] {
            assert_eq!(
                codes(|| CatalogError::CommandFailed(ChannelCompletion {
                    exit_status: Some(status),
                    diagnostic: "fixture command unavailable".into(),
                })),
                ["hmux_remote_runtime_update_required"; 5]
            );
        }
    }

    #[test]
    fn incomplete_and_post_answer_failures_remain_unknown() {
        for status in [None, Some(1)] {
            assert!(
                codes(|| CatalogError::CommandFailed(ChannelCompletion {
                    exit_status: status,
                    diagnostic: "fixture command failed".into(),
                }))
                .iter()
                .all(|code| code.ends_with("outcome_unknown"))
            );
        }
        assert!(
            codes(|| CatalogError::Response(
                "the remote command exited with status 127 after answering".into()
            ))
            .iter()
            .all(|code| code.ends_with("outcome_unknown"))
        );
    }
}
