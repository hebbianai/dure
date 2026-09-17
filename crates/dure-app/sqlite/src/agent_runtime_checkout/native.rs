use super::*;
use crate::SessionCheckoutAdmission;
use dure_app::{RuntimeKindIdV1, SessionCheckoutAdmissionV1, WorkflowSessionGenerationV1};

impl crate::SqliteDomainStore {
    /// Refresh has a runtime receipt, not an Agent hint. Resolve its unique
    /// current owner under the same admission as close/adoption. Keep the guard
    /// through Git claim acknowledgement before publishing root membership.
    /// The runtime caller proves this session's immutable checkout ancestry.
    pub async fn admit_agent_native_checkout(
        &self,
        session: &WorkflowSessionGenerationV1,
        runtime_kind: &RuntimeKindIdV1,
        source: &SessionCheckoutBindingV1,
    ) -> Result<Option<SessionCheckoutAdmission>, DomainStoreErrorV1> {
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| map_sqlx("adopt_agent_native_checkout", error))?;
        let Some(authority) = crate::checkpoint_bindings::authority_for_exact_session_on(
            &mut transaction,
            session,
            runtime_kind,
        )
        .await?
        else {
            return Ok(None);
        };
        let agent_id = &authority.binding.agent_id;
        let Some(selection) = selection_on(&mut transaction, agent_id).await? else {
            return Ok(None);
        };
        AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: authority.clone(),
        }
        .validate_for_selection(&selection)?;
        if selection.provider_id != session.provider_id {
            return Err(identity_conflict(
                "agent runtime checkout",
                agent_id.as_str(),
                "the exact generation is not the selected native provider",
            ));
        }
        let SessionCheckoutOwnerV1::Managed { workspace_id, .. } = &source.identity.owner else {
            return Err(identity_conflict(
                "agent runtime checkout",
                agent_id.as_str(),
                "native adoption requires a managed origin",
            ));
        };
        if workspace_id != &session.workspace_id {
            return Err(identity_conflict(
                "agent runtime checkout",
                agent_id.as_str(),
                "the checkout origin belongs to another workspace",
            ));
        }
        registration::require_registration_admission_on(&mut transaction, agent_id).await?;
        let existing = checkout_on(&mut transaction, agent_id).await?;
        let record = if let Some(record) =
            existing.filter(|record| record.binding != source.retained_by_agent(agent_id))
        {
            // Older Refresh could allocate a separate Managed claim after a
            // settings transition retained this Agent's original incarnation.
            // Exact current native ownership admits membership, not replacement
            // of the Agent lifetime or a cwd-only resource substitution.
            let observed =
                crate::session_checkout::row::read_registration(&mut transaction, &source.claim_id)
                    .await?;
            if !observed.is_some_and(|current| {
                current.binding == *source && current.admission == SessionCheckoutAdmissionV1::Open
            }) || record.binding.identity.runtime_namespace != source.identity.runtime_namespace
                || record.binding.working_directory != source.working_directory
                || record.binding.registration != source.registration
            {
                return Err(identity_conflict(
                    "agent runtime checkout",
                    agent_id.as_str(),
                    "the selected Agent and native source retain different resources",
                ));
            }
            record
        } else {
            adopt_on(&mut transaction, agent_id, source).await?;
            checkout_on(&mut transaction, agent_id)
                .await?
                .expect("adoption publishes its binding in this transaction")
        };
        if record.admission != SessionCheckoutAdmissionV1::Open {
            return Err(identity_conflict(
                "agent runtime checkout",
                agent_id.as_str(),
                "Agent checkout admission is closed",
            ));
        }
        let retained = roots::binding_on(&mut transaction, &source.identity)
            .await?
            .as_ref()
            == Some(&record.binding);
        Ok(Some(SessionCheckoutAdmission {
            transaction,
            binding: record.binding,
            agent_origin: Some(source.identity.clone()),
            retained,
        }))
    }
}
