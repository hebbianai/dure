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

pub fn project_checkout_advance(
    resolution: Result<ManagedCreateAdvanceResolution, crate::SessionCheckoutError>,
) -> Result<ManagedCreateAdvanceCommandResolution<CreatedManagedSession>, String> {
    match resolution {
        Ok(resolution) => Ok(project_managed_create_advance(Ok(resolution))),
        Err(crate::SessionCheckoutError::Create(error)) => {
            Ok(project_managed_create_advance(Err(error)))
        }
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
