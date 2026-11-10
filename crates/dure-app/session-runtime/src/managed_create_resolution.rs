use hmux_client::{
    CreatedManagedSession, ManagedCreateAdvanceResolution, ManagedCreateFailureDisposition,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedCreateRetrySameReason {
    Pending,
    AuthorityUnavailable,
    CreateRetryable,
}

/// Provider-neutral projection of the Hmux managed-create authority.
///
/// Current and Advanced are the only successful outcomes of the explicit
/// destructive composition. Legacy create/reconcile states never cross this
/// command boundary.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ManagedCreateAdvanceCommandResolution<T> {
    Current {
        receipt: T,
    },
    Advanced {
        receipt: T,
    },
    RetrySame {
        reason: ManagedCreateRetrySameReason,
        code: String,
        message: String,
    },
    Rejected {
        code: String,
        message: String,
    },
}

fn retry_same<T>(
    reason: ManagedCreateRetrySameReason,
    code: impl Into<String>,
    message: impl Into<String>,
) -> ManagedCreateAdvanceCommandResolution<T> {
    ManagedCreateAdvanceCommandResolution::retry_same(reason, code, message)
}

pub fn project_managed_create_advance(
    resolution: Result<ManagedCreateAdvanceResolution, hmux_client::ManagedCreateError>,
) -> ManagedCreateAdvanceCommandResolution<CreatedManagedSession> {
    match resolution {
        Ok(ManagedCreateAdvanceResolution::Current(created)) => {
            ManagedCreateAdvanceCommandResolution::Current { receipt: created }
        }
        Ok(ManagedCreateAdvanceResolution::Advanced(created)) => {
            ManagedCreateAdvanceCommandResolution::Advanced { receipt: created }
        }
        Ok(ManagedCreateAdvanceResolution::Pending) => retry_same(
            ManagedCreateRetrySameReason::Pending,
            "hmux_managed_create_pending",
            "the exact managed create is still pending",
        ),
        Ok(ManagedCreateAdvanceResolution::AuthorityUnavailable(authority)) => retry_same(
            ManagedCreateRetrySameReason::AuthorityUnavailable,
            authority.code,
            authority.message,
        ),
        Err(error) => {
            let code = error.code().to_string();
            let message = error.to_string();
            match error.disposition() {
                ManagedCreateFailureDisposition::Rejected => {
                    ManagedCreateAdvanceCommandResolution::rejected(code, message)
                }
                ManagedCreateFailureDisposition::Retryable => {
                    retry_same(ManagedCreateRetrySameReason::CreateRetryable, code, message)
                }
            }
        }
    }
}

/// Code of the `retry_same` resolution for a store write that could not take
/// the database lock in time, after the store's own retries.
const SESSION_CHECKOUT_STORE_BUSY_CODE: &str = "session_checkout_store_busy";

pub fn project_checkout_advance(
    resolution: Result<ManagedCreateAdvanceResolution, crate::SessionCheckoutError>,
) -> Result<ManagedCreateAdvanceCommandResolution<CreatedManagedSession>, String> {
    match resolution {
        Ok(resolution) => Ok(project_managed_create_advance(Ok(resolution))),
        Err(crate::SessionCheckoutError::Create(error)) => {
            Ok(project_managed_create_advance(Err(error)))
        }
        // A busy store refused its write before applying it, and the exact
        // idempotent request stays safe to replay. Name that outcome instead of
        // a bare error string, which a client can only read as unknown.
        Err(crate::SessionCheckoutError::Store(
            error @ dure_app::DomainStoreErrorV1::Busy { .. },
        )) => Ok(retry_same(
            ManagedCreateRetrySameReason::CreateRetryable,
            SESSION_CHECKOUT_STORE_BUSY_CODE,
            error.to_string(),
        )),
        Err(error) => Err(error.to_string()),
    }
}

impl<T> ManagedCreateAdvanceCommandResolution<T> {
    pub fn map<U>(self, project: impl FnOnce(T) -> U) -> ManagedCreateAdvanceCommandResolution<U> {
        match self {
            Self::Current { receipt } => ManagedCreateAdvanceCommandResolution::Current {
                receipt: project(receipt),
            },
            Self::Advanced { receipt } => ManagedCreateAdvanceCommandResolution::Advanced {
                receipt: project(receipt),
            },
            Self::RetrySame {
                reason,
                code,
                message,
            } => ManagedCreateAdvanceCommandResolution::RetrySame {
                reason,
                code,
                message,
            },
            Self::Rejected { code, message } => {
                ManagedCreateAdvanceCommandResolution::Rejected { code, message }
            }
        }
    }

    pub fn retry_same(
        reason: ManagedCreateRetrySameReason,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::RetrySame {
            reason,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn rejected(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Rejected {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SessionCheckoutError;
    use dure_app::DomainStoreErrorV1;

    fn project_store_error(
        error: DomainStoreErrorV1,
    ) -> Result<ManagedCreateAdvanceCommandResolution<()>, String> {
        project_checkout_advance(Err(SessionCheckoutError::Store(error)))
            .map(|resolution| resolution.map(|_| ()))
    }

    #[test]
    fn a_busy_checkout_store_is_a_replayable_resolution_not_an_error_string() {
        let resolution = project_store_error(DomainStoreErrorV1::Busy {
            operation: "prepare_session_checkout",
        });

        assert_eq!(
            resolution,
            Ok(ManagedCreateAdvanceCommandResolution::RetrySame {
                reason: ManagedCreateRetrySameReason::CreateRetryable,
                code: "session_checkout_store_busy".into(),
                message: "store is busy during prepare_session_checkout".into(),
            })
        );
    }

    #[test]
    fn other_checkout_store_failures_keep_their_error() {
        let error = DomainStoreErrorV1::Storage {
            code: "sqlite_io",
            detail: "disk I/O error".into(),
        };

        assert_eq!(project_store_error(error.clone()), Err(error.to_string()));
    }
}
