use dure_app::{
    AgentRuntimeCloseRecordV1, AgentRuntimeCloseStateV1, AgentRuntimeRemovalPlanV1,
    SessionCheckoutOwnerV1,
};
use hmux_client::ManagedCreateReconcileRequest;

use crate::{CheckoutSessionRuntime, SessionCheckoutError, cleanup::finish_checkout_cleanup};

impl CheckoutSessionRuntime {
    /// Resume finalization from the backend's frozen removal journal. Ordinary
    /// generation stop never calls this: it must retain its resumable resource.
    pub async fn finish_agent_removal(
        &self,
        close: &AgentRuntimeCloseRecordV1,
        plan: &AgentRuntimeRemovalPlanV1,
    ) -> Result<(), SessionCheckoutError> {
        if close.state != AgentRuntimeCloseStateV1::Stopped {
            return Err(invalid("the selected provider has not stopped"));
        }
        let checkout = if let Some(checkout) = &plan.checkout {
            let current = self
                .store
                .agent_runtime_checkout(&close.intent.source.agent_id)
                .await?;
            if current.as_ref().map(|record| &record.binding) != Some(checkout) {
                return Err(invalid("the retained resource owner changed"));
            }
            // The selected runtime is stopped. Close Agent launch admission
            // before reconciling its prospective Native root, including a
            // Chat-first Agent whose Native root was never reserved.
            self.store
                .begin_session_checkout_close(&checkout.identity)
                .await?
        } else {
            None
        };
        if let Some(checkout) = &checkout {
            // The close fence makes this durable membership set immutable,
            // including a ready target whose UI publication was interrupted.
            for root in self.store.agent_checkout_roots(&checkout.binding).await? {
                self.close_registered_native_root(crate::agent_registration::native_request(
                    &self.namespace,
                    root,
                )?)
                .await?;
            }
        }
        for root in &plan.managed_roots {
            let SessionCheckoutOwnerV1::Managed {
                workspace_id,
                session_id,
                idempotency_key,
            } = &root.owner
            else {
                return Err(invalid(
                    "Agent removal requires an exact managed create origin",
                ));
            };
            if root.runtime_namespace != self.namespace {
                return Err(invalid(
                    "managed create belongs to another runtime namespace",
                ));
            }
            let request =
                ManagedCreateReconcileRequest::new(idempotency_key, session_id, workspace_id)
                    .map_err(|_| invalid("invalid managed create origin"))?;
            let registered = checkout.as_ref().is_some_and(|record| {
                record
                    .binding
                    .registered_agent_native_origin(workspace_id)
                    .as_ref()
                    == Some(root)
            });
            if registered {
                self.close_registered_native_root(request).await?;
            } else {
                // An adopted/observed origin requires actual runtime retirement;
                // the unreserved registration case is not a legacy fallback.
                self.close(request).await?;
            }
        }
        if let Some(checkout) = checkout {
            finish_checkout_cleanup(&self.store, checkout).await?;
        }
        Ok(())
    }
}

fn invalid(message: &str) -> SessionCheckoutError {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message).into()
}
