use super::*;
use crate::SessionCheckoutAdmission;
use crate::session_checkout::{CloseTransition, preparation::prepare_on, transition_on};
use dure_app::{AgentBootstrapV1, SessionCheckoutAdmissionV1};

impl crate::SqliteDomainStore {
    /// Retain an unlaunched Agent's exact incarnation and prospective native
    /// root together. The caller acquires Git membership before acknowledging
    /// registration; these durable inputs also survive a lost acknowledgement.
    pub async fn prepare_agent_checkout(
        &self,
        binding: &SessionCheckoutBindingV1,
        agent: &AgentBootstrapV1,
        timestamp: i64,
    ) -> Result<SessionCheckoutRecordV1, DomainStoreErrorV1> {
        let agent_id = agent_owner(binding)?;
        if agent_id != &agent.agent_id || binding.working_directory != agent.working_directory {
            return Err(conflict(
                binding,
                "registration metadata names another resource",
            ));
        }
        if binding.claim_id != binding.identity.owner_id() {
            return Err(conflict(binding, "registration requires its own claim"));
        }
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| map_sqlx("prepare_agent_checkout", error))?;
        crate::agent_bootstrap::ensure_on(&mut transaction, agent, timestamp).await?;
        if owner_on(&mut transaction, agent_id)
            .await?
            .is_some_and(|owner| owner != binding.identity.owner_id().as_str())
        {
            let predecessor = checkout_on(&mut transaction, agent_id).await?;
            if !predecessor
                .is_some_and(|record| record.admission == SessionCheckoutAdmissionV1::Closed)
                || selection_on(&mut transaction, agent_id).await?.is_some()
            {
                return Err(conflict(
                    binding,
                    "another Agent incarnation owns the resource",
                ));
            }
        }
        prepare_on(&mut transaction, binding, || async {
            Ok::<_, DomainStoreErrorV1>(())
        })
        .await?;
        // The incarnation selects its native root here. A caller supplies only
        // the runtime workspace, never another Agent's destructive root address.
        let origin = binding
            .registered_agent_native_origin(agent.runtime_workspace_id.as_str())
            .expect("a fresh Agent claim was validated before preparation");
        let payload = serde_json::to_value(&origin)
            .map_err(|error| serialization("agent_checkout_origin", error))?;
        let record = transition_on(
            &mut transaction,
            &binding.identity,
            None,
            Some(&payload),
            CloseTransition::RememberTarget,
        )
        .await?
        .expect("prepared binding remains in this transaction");
        sqlx::query("UPDATE agents SET checkout_owner_id = ?2 WHERE agent_id = ?1")
            .bind(agent_id.as_str())
            .bind(binding.identity.owner_id().as_str())
            .execute(&mut *transaction)
            .await
            .map_err(|error| map_sqlx("prepare_agent_checkout", error))?;
        transaction
            .commit()
            .await
            .map_err(|error| map_sqlx("prepare_agent_checkout", error))?;
        Ok(record)
    }

    /// Claim and registered launch retain the existing admission guard. A
    /// concurrent cancellation cannot pass an in-flight Git claim/reservation.
    pub async fn admit_agent_checkout(
        &self,
        binding: &SessionCheckoutBindingV1,
        origin: &SessionCheckoutIdentityV1,
    ) -> Result<SessionCheckoutAdmission, DomainStoreErrorV1> {
        let mut admission = self.admit_session_checkout(&binding.identity).await?;
        let record = require_owner_on(&mut admission.transaction, binding).await?;
        // Remove's existing close journal owns admission while provider stop
        // is pending. SourceRetained excludes that close, so a rejected stop
        // remains resumable without reopening a permanently closed checkout.
        require_registration_admission_on(&mut admission.transaction, agent_owner(binding)?)
            .await?;
        let payload = serde_json::to_value(origin)
            .map_err(|error| serialization("agent_checkout_origin", error))?;
        admission.retained = super::roots::binding_on(&mut admission.transaction, origin)
            .await?
            .as_ref()
            == Some(binding);
        if !admission.retained && record.close_payload.as_ref() != Some(&payload) {
            return Err(conflict(binding, "the registered native root changed"));
        }
        admission.agent_origin = Some(origin.clone());
        Ok(admission)
    }

    /// Add a prospective Refresh root to the same Agent lifetime. Reserve the
    /// runtime while this guard is held, then finish before launching it.
    pub async fn admit_agent_checkout_replacement(
        &self,
        binding: &SessionCheckoutBindingV1,
        source: &SessionCheckoutIdentityV1,
        target: &SessionCheckoutIdentityV1,
    ) -> Result<SessionCheckoutAdmission, DomainStoreErrorV1> {
        let mut admission = self.admit_agent_checkout(binding, source).await?;
        if !admission.retained() {
            return Err(conflict(
                binding,
                "the source claim has not been acknowledged",
            ));
        }
        let (
            SessionCheckoutOwnerV1::Managed {
                workspace_id: source_workspace,
                ..
            },
            SessionCheckoutOwnerV1::Managed {
                workspace_id: target_workspace,
                ..
            },
        ) = (&source.owner, &target.owner)
        else {
            return Err(conflict(binding, "replacement requires managed roots"));
        };
        if source.runtime_namespace != target.runtime_namespace
            || source_workspace != target_workspace
        {
            return Err(conflict(
                binding,
                "replacement left its runtime namespace or workspace",
            ));
        }
        if crate::session_checkout::row::read(&mut admission.transaction, target)
            .await?
            .is_some()
        {
            return Err(conflict(
                binding,
                "the target already has independent checkout admission",
            ));
        }
        if super::roots::binding_on(&mut admission.transaction, target)
            .await?
            .is_some_and(|existing| existing != *binding)
        {
            return Err(conflict(binding, "another Agent owns the replacement"));
        }
        admission.agent_origin = Some(target.clone());
        Ok(admission)
    }

    /// Cancel only a prelaunch registration. Once a runtime selection exists,
    /// its existing Stop/Remove saga owns retirement and resource finalization.
    /// Closing and selection publication serialize on the same transaction.
    pub async fn begin_agent_registration_close(
        &self,
        binding: &SessionCheckoutBindingV1,
    ) -> Result<SessionCheckoutRecordV1, DomainStoreErrorV1> {
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| map_sqlx("close_agent_registration", error))?;
        require_owner_on(&mut transaction, binding).await?;
        if selection_on(&mut transaction, agent_owner(binding)?)
            .await?
            .is_some()
        {
            return Err(conflict(binding, "the selected runtime owns Agent removal"));
        }
        let record = transition_on(
            &mut transaction,
            &binding.identity,
            Some(&binding.claim_id),
            None,
            CloseTransition::Begin,
        )
        .await?
        .expect("exact binding remains in this transaction");
        transaction
            .commit()
            .await
            .map_err(|error| map_sqlx("close_agent_registration", error))?;
        Ok(record)
    }
}

pub(super) async fn require_registration_admission_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<(), DomainStoreErrorV1> {
    if let Some(close) =
        crate::agent_runtime_close::effective_close_for_agent_on(connection, agent_id).await?
        && crate::agent_runtime_removal::read_on(connection, &close.intent.operation_id)
            .await?
            .is_some()
    {
        return Err(identity_conflict(
            "agent checkout registration",
            agent_id.as_str(),
            "Agent removal owns registration admission",
        ));
    }
    Ok(())
}

async fn require_owner_on(
    connection: &mut SqliteConnection,
    binding: &SessionCheckoutBindingV1,
) -> Result<SessionCheckoutRecordV1, DomainStoreErrorV1> {
    checkout_on(connection, agent_owner(binding)?)
        .await?
        .filter(|record| record.binding == *binding)
        .ok_or_else(|| {
            conflict(
                binding,
                "the Agent registration no longer owns this resource",
            )
        })
}

fn agent_owner(binding: &SessionCheckoutBindingV1) -> Result<&AgentIdV1, DomainStoreErrorV1> {
    match &binding.identity.owner {
        SessionCheckoutOwnerV1::Agent { agent_id, .. } => Ok(agent_id),
        _ => Err(conflict(
            binding,
            "Agent registration requires an Agent owner",
        )),
    }
}

fn conflict(binding: &SessionCheckoutBindingV1, reason: &str) -> DomainStoreErrorV1 {
    identity_conflict(
        "agent checkout registration",
        binding.identity.owner_id().as_str(),
        reason,
    )
}
