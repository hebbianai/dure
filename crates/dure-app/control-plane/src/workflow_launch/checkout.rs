use super::*;
use dure_session_runtime::{CheckoutSessionRuntime, SessionCheckoutError};

/// Independent workers retain their own checkout lifetime. Agent spawn and
/// generation transitions already belong to the Agent's registration instead.
pub(crate) async fn launch_independent(
    state: &crate::ServiceState,
    request: WorkflowSessionLaunchRequestV1,
    environment: ProviderStateEnvironment,
) -> Result<WorkflowSessionLaunchReceiptV1, WorkflowSessionLaunchFailureV1> {
    let prepared = managed_create_request(&request, environment.clone(), None)?;
    let runtime = CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        state.hmux_identity.runtime_executable_path.clone(),
        state.hmux_identity.discovery_root.clone(),
    )
    .map_err(checkout_failure)?;
    let launcher = Arc::clone(&state.credential_aware_workflow_launcher);
    runtime
        .advance_using(prepared, move || async move {
            launcher
                .launch_with_provider_state(request, environment, None)
                .await
                .map_err(RetainedLaunchFailure)
        })
        .await
        .map_err(|error: RetainedLaunchFailure| error.0)
}

struct RetainedLaunchFailure(WorkflowSessionLaunchFailureV1);

impl From<SessionCheckoutError> for RetainedLaunchFailure {
    fn from(error: SessionCheckoutError) -> Self {
        Self(checkout_failure(error))
    }
}

fn checkout_failure(error: SessionCheckoutError) -> WorkflowSessionLaunchFailureV1 {
    match error {
        SessionCheckoutError::Checkout(error) => failure(error.code),
        SessionCheckoutError::Create(error) => match error.disposition() {
            ManagedCreateFailureDisposition::Rejected => rejected_failure(error.code()),
            ManagedCreateFailureDisposition::Retryable => failure(error.code()),
        },
        SessionCheckoutError::Closing => rejected_failure("session_checkout_closing"),
        _ => failure("workflow_checkout_unavailable"),
    }
}
