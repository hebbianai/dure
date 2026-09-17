use std::path::Path;

use dure_app::{
    SessionCheckoutBindingV1, SessionCheckoutIdentityV1, SessionCheckoutOwnerV1,
    SessionCheckoutRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::recovery_journal::existing_operation::{self, RecoveryOperationObservation};
use hmux_client::recovery_journal::prepared_standalone_create::{execution, refusal};
use hmux_client::recovery_journal::{
    RecoveryCompletion, RecoveryIdentity, RecoveryReservationState,
    STANDALONE_CREATE_OPERATION_RECOVERY_ACTION, acknowledge_completion,
};
use hmux_client::{
    CompletedStandaloneTargetLifecycle, CreatedStandaloneSession,
    ExitedSessionRetirementGeneration, LocalSessionCatalog, SessionClass, StandaloneCreateRequest,
    standalone_create_idempotency_key,
};
use hmux_host::local_discovery::workspace_id_for_path;

use crate::{CheckoutSessionRuntime, SessionCheckoutError};

fn identity(namespace: &str, recovery_id: &str) -> SessionCheckoutIdentityV1 {
    SessionCheckoutIdentityV1 {
        runtime_namespace: namespace.into(),
        owner: SessionCheckoutOwnerV1::Recovery {
            recovery_id: recovery_id.into(),
        },
    }
}

impl CheckoutSessionRuntime {
    pub(super) async fn retain_creation_request(
        &self,
        recovery_id: &str,
        request: &StandaloneCreateRequest,
    ) -> Result<SessionCheckoutBindingV1, SessionCheckoutError> {
        let cwd = request.provider_cwd().canonicalize()?;
        self.prepare_checkout(
            identity(&self.namespace, recovery_id),
            &cwd,
            None,
            || async { Ok(()) },
        )
        .await
    }

    /// The journal has completed before this publication. A reconnect resumes
    /// the same ownership transfer; it never creates a second resource claim.
    pub(super) async fn publish_creation_session(
        &self,
        recovery_id: &str,
        created: &CreatedStandaloneSession,
    ) -> Result<(), SessionCheckoutError> {
        let descriptor = created.session().descriptor();
        let destination = crate::standalone::standalone_identity(
            &self.namespace,
            created
                .session()
                .create_idempotency_key()
                .ok_or(SessionCheckoutError::MissingCreateIdentity)?,
            &descriptor.session_id,
            &descriptor.workspace_id,
        );
        if let Some(source) = self
            .store
            .session_checkout(&identity(&self.namespace, recovery_id))
            .await?
        {
            let close_payload = crate::standalone_close::close_target_payload(
                &ExitedSessionRetirementGeneration::from_descriptor(descriptor)?,
                &descriptor.provider_process,
            )?;
            self.store
                .transfer_session_checkout_with_target(
                    &source.binding,
                    &destination,
                    Some(&close_payload),
                    || async { Ok::<_, SessionCheckoutError>(()) },
                )
                .await?;
        } else if self.store.session_checkout(&destination).await?.is_none() {
            return Err(SessionCheckoutError::MissingCreateIdentity);
        }
        crate::standalone_close::remember_standalone_close_target(&self.store, created.session())
            .await
    }

    pub(super) async fn reconcile_creation_retention(
        &self,
        recovery_id: &str,
    ) -> Result<(), SessionCheckoutError> {
        if let Some(record) = self
            .store
            .session_checkout(&identity(&self.namespace, recovery_id))
            .await?
        {
            reconcile_retention(
                &self.store,
                &LocalSessionCatalog::new(&self.discovery_root),
                record,
            )
            .await?;
        }
        Ok(())
    }
}

/// A terminal journal refusal prevents another launch, while an archived exact
/// generation proves an already launched target ended. Neither missing journal
/// state nor an uncertain runtime observation releases a pending operation.
pub(crate) async fn reconcile_retention(
    store: &SqliteDomainStore,
    catalog: &LocalSessionCatalog,
    record: SessionCheckoutRecordV1,
) -> Result<(), SessionCheckoutError> {
    let observed = record.binding.clone();
    let observation_catalog = catalog.clone();
    let Some((identity, completion)) =
        tokio::task::spawn_blocking(move || finished_creation(&observation_catalog, &observed))
            .await??
    else {
        return Ok(());
    };
    if let Some(current) = store
        .begin_session_checkout_claim_close(&record.binding.identity, &record.binding.claim_id)
        .await?
    {
        crate::cleanup::finish_checkout_cleanup(store, current).await?;
        // Git release and SQL close are durable before the journal payload
        // can be reclaimed. Its acknowledgement fence still forbids launch.
        let root = catalog.discovery_root().to_path_buf();
        tokio::task::spawn_blocking(move || acknowledge_completion(&root, &identity, &completion))
            .await?
            .map_err(SessionCheckoutError::Journal)?;
    }
    Ok(())
}

fn finished_creation(
    catalog: &LocalSessionCatalog,
    binding: &SessionCheckoutBindingV1,
) -> Result<Option<(RecoveryIdentity, RecoveryCompletion)>, SessionCheckoutError> {
    let SessionCheckoutOwnerV1::Recovery { recovery_id } = &binding.identity.owner else {
        return Err(SessionCheckoutError::CloseTargetChanged);
    };
    let Some(observation) = existing_operation::read(
        catalog.discovery_root(),
        recovery_id,
        STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    )
    .map_err(SessionCheckoutError::Journal)?
    else {
        return Ok(None);
    };
    let checkpoint = match &observation {
        RecoveryOperationObservation::Pending { checkpoint, .. } => checkpoint.as_ref(),
        RecoveryOperationObservation::Completed { completion, .. } => {
            completion.operation_checkpoint.as_ref()
        }
    };
    let Some(checkpoint) = checkpoint else {
        return Ok(None);
    };
    let request: StandaloneCreateRequest = serde_json::from_str(&checkpoint.canonical_payload)?;
    request
        .validate()
        .map_err(|error| SessionCheckoutError::Journal(error.to_string()))?;
    let create = request
        .recovery_identity()
        .ok_or(SessionCheckoutError::MissingCreateIdentity)?;
    let rejected = match &observation {
        RecoveryOperationObservation::Pending { .. } => false,
        RecoveryOperationObservation::Completed { completion, .. } => refusal::code(
            completion,
            create.target_session_id(),
            super::CREATION_NAMESPACE,
        )
        .map_err(SessionCheckoutError::Journal)?
        .is_some(),
    };
    let workspace_id = workspace_id_for_path(Path::new(&binding.working_directory));
    let session = catalog.find_creation(
        &workspace_id,
        create.target_session_id(),
        &standalone_create_idempotency_key(create),
    )?;
    let finished = if let Some(session) = session {
        if session.descriptor().session_class != SessionClass::Standalone {
            return Err(SessionCheckoutError::CloseTargetChanged);
        }
        let generation = ExitedSessionRetirementGeneration::from_descriptor(session.descriptor())?;
        catalog.resolve_completed_standalone_target(
            &generation,
            &session.descriptor().provider_process,
        ) == CompletedStandaloneTargetLifecycle::Retired
    } else {
        rejected
    };
    if !finished {
        return Ok(None);
    }
    complete_finished_creation(catalog, observation, create.target_session_id())
}

fn complete_finished_creation(
    catalog: &LocalSessionCatalog,
    observation: RecoveryOperationObservation,
    target_session_id: &str,
) -> Result<Option<(RecoveryIdentity, RecoveryCompletion)>, SessionCheckoutError> {
    let identity = match observation {
        RecoveryOperationObservation::Completed {
            identity,
            completion,
        } => {
            return Ok(Some((identity, *completion)));
        }
        RecoveryOperationObservation::Pending { identity, .. } => identity,
    };
    // Completion and replay share the existing operation lock. A current
    // completion wins; a missing operation never becomes a new reservation.
    let Some(current) = existing_operation::reopen(catalog.discovery_root(), &identity)
        .map_err(SessionCheckoutError::Journal)?
    else {
        return Ok(None);
    };
    let completed = match current {
        RecoveryReservationState::Completed(completed) => completed,
        RecoveryReservationState::Pending(mut reservation) => {
            let checkpoint = reservation
                .operation_checkpoint()
                .ok_or(SessionCheckoutError::MissingCreateIdentity)?;
            let completed = if checkpoint.replacement_receipt.is_some() {
                super::completion(&super::completed_target(catalog, checkpoint)?)
            } else {
                refusal::completion(
                    target_session_id,
                    super::CREATION_NAMESPACE,
                    "hmux_standalone_recovery_target_exited",
                )
            };
            execution::complete(&mut reservation, completed)
                .map_err(SessionCheckoutError::Journal)?
        }
    };
    Ok(Some((identity, completed)))
}
