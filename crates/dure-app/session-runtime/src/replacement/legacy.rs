use std::path::Path;

use dure_app::{
    ProviderIdV1, RuntimeKindIdV1, SessionCheckoutBindingV1, SessionCheckoutIdentityV1,
    SessionCheckoutOwnerV1, WorkflowSessionGenerationV1,
};
use hmux_client::{
    ManagedCreateRequest, recovery_journal::managed_create_ledger::historical_create_receipt,
};

use crate::{CheckoutSessionRuntime, SessionCheckoutError};

impl CheckoutSessionRuntime {
    pub(super) async fn adopt_legacy_refresh_checkout(
        &self,
        request: &ManagedCreateRequest,
        origin: &SessionCheckoutIdentityV1,
    ) -> Result<Option<SessionCheckoutBindingV1>, SessionCheckoutError> {
        let Some(record) = self
            .store
            .session_checkout_registration(&origin.owner_id())
            .await?
        else {
            return Ok(None);
        };
        if Path::new(&record.binding.working_directory) != request.provider_cwd() {
            return Ok(None);
        }
        // An earlier adoption may have committed just before its observer was
        // lost. Reuse only that exact saved origin; admission checks the Agent.
        if matches!(
            record.binding.identity.owner,
            SessionCheckoutOwnerV1::Agent { .. }
        ) && record.close_payload.as_ref()
            == Some(
                &serde_json::to_value(origin)
                    .map_err(|error| SessionCheckoutError::Journal(error.to_string()))?,
            )
        {
            return Ok(Some(record.binding));
        }
        if record.binding.identity != *origin {
            return Ok(None);
        }
        let discovery = self.discovery_root.clone();
        let source = request.clone();
        let receipt = tokio::task::spawn_blocking(move || {
            historical_create_receipt(&discovery, source.workspace_id(), source.session_id())
                .map_err(SessionCheckoutError::Journal)
        })
        .await??;
        let Some(receipt) = receipt else {
            return Ok(None);
        };
        if receipt.idempotency_key() != request.idempotency_key()
            || receipt.provider_id() != request.provider_id()
        {
            return Err(SessionCheckoutError::Journal(
                "session_checkout_generation_conflict".into(),
            ));
        }
        let Some(fence) = receipt.generation_fence() else {
            return Ok(None);
        };
        let session = WorkflowSessionGenerationV1 {
            session_id: receipt.session_id().into(),
            workspace_id: receipt.workspace_id().into(),
            provider_id: ProviderIdV1::new(receipt.provider_id())
                .map_err(|error| SessionCheckoutError::Journal(error.to_string()))?,
            runner_principal: fence.runner_principal().into(),
            runner_instance: fence.runner_instance().into(),
            channel_epoch: fence.channel_epoch().to_string(),
            host_instance_id: fence.host_instance_id().into(),
            terminal_epoch: fence.terminal_epoch().into(),
        };
        let admission = self
            .store
            .admit_agent_native_checkout(
                &session,
                &RuntimeKindIdV1::new("runtime.hmux").expect("static runtime kind"),
                &record.binding,
            )
            .await?;
        match admission {
            Some(admission) => crate::create::claim_admission(admission, request.provider_cwd())
                .await
                .map(Some),
            None => Ok(None),
        }
    }
}
