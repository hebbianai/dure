use dure_app::{
    SessionCheckoutBindingV1, SessionCheckoutIdentityV1, SessionCheckoutOwnerV1,
    SessionCheckoutRecordV1, WorkflowSessionGenerationV1,
};
use hmux_client::recovery_journal::managed_create_ledger::{
    historical_create_receipt, resolve_create_origin,
};
use hmux_client::{LocalSession, ManagedCreateReconcileRequest, SessionClass};
use std::path::Path;

use crate::{CheckoutSessionRuntime, SessionCheckoutError, managed_identity, runtime_namespace};

#[cfg(all(test, unix))]
mod tests;

/// Select the existing journal as the next owner without moving or releasing
/// the immutable claim. Preparation and durable transfer share this identity.
pub fn recovery_checkout_binding(
    source: &SessionCheckoutBindingV1,
    discovery_root: &Path,
    recovery_id: &str,
) -> Result<SessionCheckoutBindingV1, SessionCheckoutError> {
    Ok(SessionCheckoutBindingV1 {
        identity: recovery_identity(runtime_namespace(discovery_root)?, recovery_id),
        ..source.clone()
    })
}

fn recovery_identity(namespace: String, recovery_id: &str) -> SessionCheckoutIdentityV1 {
    SessionCheckoutIdentityV1 {
        runtime_namespace: namespace,
        owner: SessionCheckoutOwnerV1::Recovery {
            recovery_id: recovery_id.into(),
        },
    }
}

impl CheckoutSessionRuntime {
    /// Read the resource retained by an exact managed create lineage. Native
    /// adoption and runtime recovery use the same origin resolver.
    pub async fn checkout_for_managed_create(
        &self,
        source: ManagedCreateReconcileRequest,
    ) -> Result<Option<SessionCheckoutBindingV1>, SessionCheckoutError> {
        managed_checkout(&self.store, self.namespace.clone(), source).await
    }

    /// Resolve a current or retired generation's exact resource ancestry. The
    /// immutable receipt is not liveness or permission to stop a process.
    pub async fn managed_checkout_origin(
        &self,
        source: WorkflowSessionGenerationV1,
    ) -> Result<
        Option<(SessionCheckoutIdentityV1, Option<SessionCheckoutRecordV1>)>,
        SessionCheckoutError,
    > {
        let discovery = self.discovery_root.clone();
        let request = tokio::task::spawn_blocking(move || {
            let Some(receipt) =
                historical_create_receipt(&discovery, &source.workspace_id, &source.session_id)
                    .map_err(SessionCheckoutError::Journal)?
            else {
                return Ok(None);
            };
            if receipt.provider_id() != source.provider_id.as_str()
                || !receipt.generation_fence().is_some_and(|fence| {
                    fence.matches_generation(
                        &source.runner_principal,
                        &source.runner_instance,
                        &source.channel_epoch,
                        &source.host_instance_id,
                        &source.terminal_epoch,
                    )
                })
            {
                return Err(SessionCheckoutError::Journal(
                    "session_checkout_generation_conflict".into(),
                ));
            }
            ManagedCreateReconcileRequest::new(
                receipt.idempotency_key(),
                &source.session_id,
                &source.workspace_id,
            )
            .map(Some)
            .map_err(|error| SessionCheckoutError::Journal(error.to_string()))
        })
        .await??;
        match request {
            Some(request) => managed_origin(&self.store, self.namespace.clone(), request)
                .await
                .map(Some),
            None => Ok(None),
        }
    }

    /// Rehost uses its own immutable journal rather than a create-successor
    /// slot. Return its proven source generation, never a reconstructed Agent
    /// selection or a predecessor guessed from a session name.
    pub async fn managed_rehost_predecessor(
        &self,
        origin: SessionCheckoutIdentityV1,
    ) -> Result<Option<WorkflowSessionGenerationV1>, SessionCheckoutError> {
        let discovery = self.discovery_root.clone();
        let namespace = self.namespace.clone();
        tokio::task::spawn_blocking(move || {
            let SessionCheckoutOwnerV1::Managed {
                workspace_id,
                session_id,
                idempotency_key,
            } = origin.owner
            else {
                return Err(SessionCheckoutError::Journal(
                    "session_checkout_origin_invalid".into(),
                ));
            };
            if origin.runtime_namespace != namespace {
                return Err(SessionCheckoutError::Journal(
                    "session_checkout_origin_invalid".into(),
                ));
            }
            let Some(receipt) = historical_create_receipt(&discovery, &workspace_id, &session_id)
                .map_err(SessionCheckoutError::Journal)?
            else {
                return Ok(None);
            };
            if receipt.idempotency_key() != idempotency_key {
                return Err(SessionCheckoutError::Journal(
                    "session_checkout_generation_conflict".into(),
                ));
            }
            let Some(edge) = hmux_client::recovery_journal::read_managed_rehost_predecessor(
                &discovery, &receipt,
            )
            .map_err(SessionCheckoutError::Journal)?
            else {
                return Ok(None);
            };
            let source = edge.source_generation();
            Ok(Some(WorkflowSessionGenerationV1 {
                session_id: source.session_id().into(),
                workspace_id: source.workspace_id().into(),
                provider_id: dure_app::ProviderIdV1::new(edge.provider_id())
                    .map_err(|error| SessionCheckoutError::Journal(error.to_string()))?,
                runner_principal: source.runner_principal().into(),
                runner_instance: source.runner_instance().into(),
                channel_epoch: source.channel_epoch().into(),
                host_instance_id: source.host_instance_id().into(),
                terminal_epoch: source.terminal_epoch().into(),
            }))
        })
        .await?
    }

    /// Freeze a legacy source's selection before its recovery stops it. Replays
    /// resolve the immutable claim even after a target has become its owner.
    /// Existing sources keep their original binding for the subsequent transfer.
    pub async fn select_recovery_checkout(
        &self,
        source: Option<SessionCheckoutBindingV1>,
        cwd: &Path,
        recovery_id: &str,
    ) -> Result<SessionCheckoutBindingV1, SessionCheckoutError> {
        if let Some(source) = source {
            return Ok(source);
        }
        if let Some(binding) = self.retained_recovery_checkout(recovery_id).await? {
            return Ok(binding);
        }
        crate::create::selected_checkout(
            &self.store,
            recovery_identity(self.namespace.clone(), recovery_id),
            cwd,
        )
        .await
    }

    /// Old prepared payloads lack a checkout field. Their pre-stop SQL
    /// selection is still authoritative, including after transfer to a target.
    /// Never capture the filesystem or activate a claim while reading it.
    pub async fn retained_recovery_checkout(
        &self,
        recovery_id: &str,
    ) -> Result<Option<SessionCheckoutBindingV1>, SessionCheckoutError> {
        let identity = recovery_identity(self.namespace.clone(), recovery_id);
        Ok(self
            .store
            .session_checkout_registration(&identity.owner_id())
            .await?
            .map(|record| SessionCheckoutBindingV1 {
                identity,
                ..record.binding
            }))
    }

    /// Read the selected creation's resource owner. Managed rehost successors
    /// resolve their origin through runtime lineage; standalone recovery uses
    /// its manifest create key. Neither a cwd nor a pane invents a binding.
    pub async fn checkout_for_session(
        &self,
        source: LocalSession,
    ) -> Result<Option<SessionCheckoutBindingV1>, SessionCheckoutError> {
        let Some(key) = source.create_idempotency_key() else {
            return Ok(None);
        };
        let namespace = runtime_namespace(source.discovery_root().unwrap_or(&self.discovery_root))?;
        let descriptor = source.descriptor();
        let identity = match descriptor.session_class {
            SessionClass::Managed => {
                let requested = ManagedCreateReconcileRequest::new(
                    key,
                    &descriptor.session_id,
                    &descriptor.workspace_id,
                )
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
                return managed_checkout(&self.store, namespace, requested).await;
            }
            SessionClass::Standalone => crate::standalone::standalone_identity(
                &namespace,
                key,
                &descriptor.session_id,
                &descriptor.workspace_id,
            ),
        };
        Ok(self
            .store
            .session_checkout(&identity)
            .await?
            .map(|record| record.binding))
    }

    /// The caller has persisted these inputs in its existing recovery journal.
    /// Transfer the immutable claim before retiring its source, never release
    /// and reacquire it through a checkout-removal admission gap.
    pub async fn retain_checkout_for_recovery(
        &self,
        source: SessionCheckoutBindingV1,
        recovery_id: String,
    ) -> Result<SessionCheckoutBindingV1, SessionCheckoutError> {
        let destination = recovery_checkout_binding(&source, &self.discovery_root, &recovery_id)?;
        let record = if source.identity == destination.identity {
            // A fresh recovery owns its frozen selection before any target
            // exists. SQL rejects an old owner once this claim transfers away.
            self.store
                .prepare_session_checkout_with(&source, || async {
                    Ok::<_, SessionCheckoutError>(())
                })
                .await?
        } else {
            self.store
                .transfer_session_checkout_with(&source, &destination.identity, || async {
                    Ok::<_, SessionCheckoutError>(())
                })
                .await?
        };
        self.admit_checkout(record, Path::new(&source.working_directory))
            .await
    }
}

async fn managed_checkout(
    store: &dure_app_sqlite::SqliteDomainStore,
    namespace: String,
    source: ManagedCreateReconcileRequest,
) -> Result<Option<SessionCheckoutBindingV1>, SessionCheckoutError> {
    Ok(managed_origin(store, namespace, source)
        .await?
        .1
        .map(|record| record.binding))
}

async fn managed_origin(
    store: &dure_app_sqlite::SqliteDomainStore,
    namespace: String,
    source: ManagedCreateReconcileRequest,
) -> Result<(SessionCheckoutIdentityV1, Option<SessionCheckoutRecordV1>), SessionCheckoutError> {
    let discovery = std::path::PathBuf::from(&namespace);
    let origin =
        tokio::task::spawn_blocking(move || resolve_create_origin(&discovery, &source)).await??;
    let identity = managed_identity(
        &namespace,
        origin.idempotency_key(),
        origin.session_id(),
        origin.workspace_id(),
    );
    let checkout = store.session_checkout(&identity).await?;
    Ok((identity, checkout))
}
