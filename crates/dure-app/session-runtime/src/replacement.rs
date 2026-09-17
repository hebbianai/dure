use dure_app::{SessionCheckoutBindingV1, SessionCheckoutIdentityV1};
use hmux_client::{
    ManagedCreateAdvanceResolution, ManagedCreateReconcileRequest, ManagedCreateRequest,
    managed_replacement_root_request,
    recovery_journal::{
        managed_create_ledger::{closed_retired_chain, resolve_create_origin},
        managed_replacement::replay_request,
    },
};

use crate::{
    CheckoutSessionRuntime, SessionCheckoutError, cleanup::finish_retired_checkout,
    managed_identity,
};

mod legacy;

impl CheckoutSessionRuntime {
    /// Same-directory Agent Refresh retains its logical resource owner. An
    /// independent session or changed directory still acquires its own claim.
    pub async fn replace_current_and_advance(
        &self,
        source_request: ManagedCreateRequest,
    ) -> Result<ManagedCreateAdvanceResolution, SessionCheckoutError> {
        self.replace_current_and_advance_observed(source_request, |_| {})
            .await
    }

    /// Request-scoped diagnostics only. The execution task retains the observer
    /// along with its admission ownership if its caller disconnects.
    pub async fn replace_current_and_advance_observed<F>(
        &self,
        source_request: ManagedCreateRequest,
        mut observe: F,
    ) -> Result<ManagedCreateAdvanceResolution, SessionCheckoutError>
    where
        F: FnMut(&'static str) + Send + 'static,
    {
        let runtime = self.clone();
        tokio::spawn(async move {
            observe("checkout.replacement.entry");
            let root = runtime.discovery_root.clone();
            let source_request = tokio::task::spawn_blocking(move || {
                replay_request(&root, &source_request)
                    .map(|saved| saved.unwrap_or(source_request))
                    .map_err(SessionCheckoutError::Journal)
            })
            .await??;
            observe("checkout.replay.ready");
            let target = managed_replacement_root_request(&source_request)?;
            let source = ManagedCreateReconcileRequest::new(
                source_request.idempotency_key(),
                source_request.session_id(),
                source_request.workspace_id(),
            )
            .expect("a validated create request has a reconciliation identity");
            let (origin, binding) = runtime.refresh_checkout_source(&source).await?;
            observe("checkout.source.ready");
            let binding = match binding {
                Some(binding) => Some(binding),
                None => {
                    runtime
                        .adopt_legacy_refresh_checkout(&source_request, &origin)
                        .await?
                }
            };
            if let Some(binding) = binding
                && std::path::Path::new(&binding.working_directory) == source_request.provider_cwd()
            {
                // Older registrations have no committed claim acknowledgement.
                // Confirm their source once, before admitting any new root.
                if runtime
                    .store
                    .agent_checkout_for_root(&origin)
                    .await?
                    .is_none()
                {
                    let admission = runtime
                        .store
                        .admit_agent_checkout(&binding, &origin)
                        .await?;
                    crate::create::claim_admission(admission, source_request.provider_cwd())
                        .await?;
                }
                observe("checkout.registration.ready");
                let target_identity = managed_identity(
                    &runtime.namespace,
                    target.idempotency_key(),
                    target.session_id(),
                    target.workspace_id(),
                );
                let admission = runtime
                    .store
                    .admit_agent_checkout_replacement(&binding, &origin, &target_identity)
                    .await?;
                observe("checkout.admission.ready");
                runtime.reserve_creation(target, true).await?;
                observe("checkout.reservation.ready");
                crate::create::claim_admission(admission, source_request.provider_cwd()).await?;
                observe("checkout.claim.ready");
                let creator = runtime.creator.clone();
                // No SQL transaction spans runtime launch/stop. Every target is
                // already recorded under the Agent's close fence before launch.
                observe("checkout.broker.start");
                let resolution = tokio::task::spawn_blocking(move || {
                    creator.replace_current_and_advance(source_request)
                })
                .await?
                .map_err(SessionCheckoutError::from)?;
                observe("checkout.broker.ready");
                if matches!(
                    resolution,
                    ManagedCreateAdvanceResolution::Current(_)
                        | ManagedCreateAdvanceResolution::Advanced(_)
                ) && runtime
                    .store
                    .session_checkout(&origin)
                    .await?
                    .is_some_and(|record| {
                        record.admission != dure_app::SessionCheckoutAdmissionV1::Closed
                    })
                {
                    // Mixed-version sources may still own an independent
                    // claim. Release it only after exact runtime retirement;
                    // ordinary retained roots need no retirement scan or Git
                    // cleanup. The Agent's own lifetime remains untouched.
                    runtime.release_replaced_source(source).await?;
                }
                observe("checkout.replacement.ready");
                return Ok(resolution);
            }
            observe("checkout.independent.start");
            let resolution = runtime
                .execute_create(target, None, true, move |creator, _| {
                    creator.replace_current_and_advance(source_request)
                })
                .await?;
            observe("checkout.independent.ready");
            if matches!(
                resolution,
                ManagedCreateAdvanceResolution::Current(_)
                    | ManagedCreateAdvanceResolution::Advanced(_)
            ) {
                runtime.release_replaced_source(source).await?;
            }
            observe("checkout.replacement.ready");
            Ok(resolution)
        })
        .await?
    }

    pub(super) async fn refresh_checkout_source(
        &self,
        source: &ManagedCreateReconcileRequest,
    ) -> Result<(SessionCheckoutIdentityV1, Option<SessionCheckoutBindingV1>), SessionCheckoutError>
    {
        let exact = managed_identity(
            &self.namespace,
            source.idempotency_key(),
            source.session_id(),
            source.workspace_id(),
        );
        // Retained logical roots already name their resource owner. Runtime
        // admission and retirement remain the broker's responsibility; only
        // unindexed descendants and legacy roots need ancestry for this lookup.
        if let Some(binding) = self.store.agent_checkout_for_root(&exact).await? {
            return Ok((exact, Some(binding)));
        }
        let discovery = self.discovery_root.clone();
        let origin = source.clone();
        let origin =
            tokio::task::spawn_blocking(move || resolve_create_origin(&discovery, &origin))
                .await??;
        let origin = managed_identity(
            &self.namespace,
            origin.idempotency_key(),
            origin.session_id(),
            origin.workspace_id(),
        );
        let binding = self.registered_agent_checkout(&origin).await?;
        Ok((origin, binding))
    }

    async fn release_replaced_source(
        &self,
        source: ManagedCreateReconcileRequest,
    ) -> Result<(), SessionCheckoutError> {
        let root = self.discovery_root.clone();
        let closed =
            tokio::task::spawn_blocking(move || closed_retired_chain(&root, &source)).await??;
        if let Some(chain) = closed {
            for source in chain.identities() {
                finish_retired_checkout(
                    &self.store,
                    managed_identity(
                        &self.namespace,
                        source.idempotency_key(),
                        source.session_id(),
                        source.workspace_id(),
                    ),
                )
                .await?;
            }
        }
        Ok(())
    }
}
