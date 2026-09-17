use dure_app::DomainStoreErrorV1;
use serde::Serialize;

use crate::BackendDispatchError;
use crate::provider_credential_profile::ProviderCredentialProfileErrorV1;
use crate::structured_provider_runtime::{
    StructuredProviderRuntimeErrorKindV1, StructuredProviderRuntimeErrorV1,
};

/// Diagnostics for the existing publication path, not another lifecycle or
/// retry authority. Preserve public error codes and retry dispositions while
/// carrying the cause supplied by the component that actually failed.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Stage {
    LineageResolution,
    TargetObservation,
    SourceObservation,
    CredentialResolution,
    ReplacementRetirement,
    ReceiptRead,
    Publication,
    Clock,
}

impl Stage {
    fn annotate(
        self,
        mut failure: BackendDispatchError,
        cause: impl Into<String>,
    ) -> BackendDispatchError {
        let cause = cause.into();
        failure.message = format!("{}: {cause}", failure.code);
        failure.details = Some(serde_json::json!({ "stage": self, "cause": cause }));
        failure
    }

    pub(super) fn unavailable(self, cause: impl Into<String>) -> BackendDispatchError {
        self.annotate(
            BackendDispatchError::from("agent_runtime_native_rehost_unavailable"),
            cause,
        )
    }

    pub(super) fn store_error(self, error: DomainStoreErrorV1) -> BackendDispatchError {
        let detail = error.to_string();
        let cause = match &error {
            DomainStoreErrorV1::Storage { code, .. }
            | DomainStoreErrorV1::Compatibility { code, .. }
            | DomainStoreErrorV1::AgentSpawnPlanAdmissionRejected { code } => (*code).to_owned(),
            _ => detail.clone(),
        };
        let failure = match error {
            DomainStoreErrorV1::InvalidRecord { .. }
            | DomainStoreErrorV1::IdentityConflict { .. }
            | DomainStoreErrorV1::IdempotencyConflict { .. }
            | DomainStoreErrorV1::RevisionConflict { .. }
            | DomainStoreErrorV1::NotFound { .. } => conflict(),
            _ => BackendDispatchError::from("agent_runtime_native_rehost_store_failed"),
        };
        let mut failure = self.annotate(failure, cause);
        failure.message = format!("{}: {detail}", failure.code);
        failure
    }
}

pub(super) fn conflict() -> BackendDispatchError {
    BackendDispatchError::terminal("agent_runtime_native_rehost_conflict")
}

pub(super) fn credential_error(error: ProviderCredentialProfileErrorV1) -> BackendDispatchError {
    match error {
        ProviderCredentialProfileErrorV1::RequestInvalid
        | ProviderCredentialProfileErrorV1::Conflict
        | ProviderCredentialProfileErrorV1::StaleGeneration
        | ProviderCredentialProfileErrorV1::Unavailable => {
            Stage::CredentialResolution.annotate(conflict(), error.code())
        }
        ProviderCredentialProfileErrorV1::StoreFailed => {
            Stage::CredentialResolution.unavailable(error.code())
        }
    }
}

pub(super) fn retirement_error(error: StructuredProviderRuntimeErrorV1) -> BackendDispatchError {
    let mut failure = match error.kind {
        StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable
        | StructuredProviderRuntimeErrorKindV1::SourceBusy
        | StructuredProviderRuntimeErrorKindV1::LaunchFailed
        | StructuredProviderRuntimeErrorKindV1::StopFailed => {
            Stage::ReplacementRetirement.unavailable(error.code)
        }
        StructuredProviderRuntimeErrorKindV1::RequestInvalid
        | StructuredProviderRuntimeErrorKindV1::CredentialUnavailable
        | StructuredProviderRuntimeErrorKindV1::CredentialStale
        | StructuredProviderRuntimeErrorKindV1::RuntimeConflict
        | StructuredProviderRuntimeErrorKindV1::ExplicitRecoveryRequired => {
            Stage::ReplacementRetirement.annotate(conflict(), error.code)
        }
    };
    if let Some(detail) = error.detail {
        failure.message = format!("{}: {detail}", failure.message);
    }
    failure
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BackendFailureDispositionV1;

    #[test]
    fn credential_registry_errors_retry_only_store_failures() {
        for error in [
            ProviderCredentialProfileErrorV1::RequestInvalid,
            ProviderCredentialProfileErrorV1::Conflict,
            ProviderCredentialProfileErrorV1::StaleGeneration,
            // A rehost receipt has already fixed the launched credential. A
            // missing expected or observed registration cannot converge by
            // replaying the same operation.
            ProviderCredentialProfileErrorV1::Unavailable,
        ] {
            let failure = credential_error(error);
            assert_eq!(failure.disposition, BackendFailureDispositionV1::Terminal);
            assert_eq!(
                failure.details,
                Some(serde_json::json!({
                    "stage": "credential_resolution",
                    "cause": error.code(),
                })),
            );
        }
        assert_eq!(
            credential_error(ProviderCredentialProfileErrorV1::StoreFailed).disposition,
            BackendFailureDispositionV1::RetrySame,
        );
    }

    #[test]
    fn retirement_preserves_provider_cause_without_changing_retry_disposition() {
        for (kind, disposition) in [
            (
                StructuredProviderRuntimeErrorKindV1::StopFailed,
                BackendFailureDispositionV1::RetrySame,
            ),
            (
                StructuredProviderRuntimeErrorKindV1::CredentialStale,
                BackendFailureDispositionV1::Terminal,
            ),
        ] {
            let failure = retirement_error(
                StructuredProviderRuntimeErrorV1::new(kind, "fixture_provider_cause")
                    .with_detail(Some("fixture provider detail".into())),
            );
            assert_eq!(failure.disposition, disposition);
            assert!(failure.message.contains("fixture provider detail"));
            assert_eq!(
                failure.details,
                Some(serde_json::json!({
                    "stage": "replacement_retirement",
                    "cause": "fixture_provider_cause",
                })),
            );
        }
    }
}
