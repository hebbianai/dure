use std::path::{Path, PathBuf};

use dure_app::{
    AgentRuntimeTransitionStore, GitCheckoutRegistrationV1, SessionCheckoutAdmissionV1,
    SessionCheckoutOwnerV1,
};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::{
    LocalSessionCatalog, ManagedCreateReconcileRequest, ManagedSessionCreateReconciler,
};

use crate::{
    SessionCheckoutError, managed_cleanup::reconcile_creation, namespace::runtime_namespace,
};

/// Reconcile this product's actual checkout users before confirmed removal.
/// The discovery root is the backend's already resolved canonical namespace.
/// Unknown/foreign claims do not require runtime initialization. Git still owns
/// final removal admission; completed sessions are never stopped by this path.
pub async fn reconcile_checkout_users(
    store: SqliteDomainStore,
    executable: PathBuf,
    canonical_discovery_root: PathBuf,
    registration: GitCheckoutRegistrationV1,
) -> Result<(), SessionCheckoutError> {
    reconcile_catalog_checkout_users(
        store,
        move || Ok(executable),
        LocalSessionCatalog::new(canonical_discovery_root),
        registration,
    )
    .await
}

/// Desktop callers retain the runtime's configured lookup scope. Only records
/// in that scope may reconcile; executable discovery is deferred until a
/// managed creation actually needs it. Standalone and foreign claims never
/// require installing or activating a runtime merely to attempt Git removal.
pub async fn reconcile_catalog_checkout_users(
    store: SqliteDomainStore,
    executable: impl FnOnce() -> Result<PathBuf, SessionCheckoutError> + Clone + Send + 'static,
    catalog: LocalSessionCatalog,
    registration: GitCheckoutRegistrationV1,
) -> Result<(), SessionCheckoutError> {
    // Keep admitted compensation alive if the removal caller disconnects.
    tokio::spawn(async move {
        let namespaces = tokio::task::spawn_blocking(move || {
            // Compare configured roots in the same namespace used by claim
            // admission. Normalize each scope once, not once per claim.
            // An unresolved scope cannot authorize cleanup; its retained claims
            // still prevent removal without blocking other configured roots.
            catalog
                .discovery_paths()
                .filter_map(|root| runtime_namespace(root).ok())
                .collect::<Vec<_>>()
        })
        .await?;
        // Git membership can disappear before the final SQL checkpoint. The
        // durable binding owns pending product work; each runtime still decides
        // whether it has retired, and Git alone admits actual checkout removal.
        let mut records = store
            .session_checkout_recovery_candidates(&registration, &namespaces)
            .await?;
        let checkout = PathBuf::from(&registration.instance.canonical_path);
        let directory_claims = tokio::task::spawn_blocking(move || {
            dure_git_checkout::read_working_directory_claims(&checkout)
        })
        .await??;
        records.extend(
            store
                .directory_checkout_recovery_candidates(&directory_claims, &namespaces)
                .await?,
        );
        let mut identities = Vec::new();
        let mut registrations = Vec::new();
        for record in records {
            let identity = &record.binding.identity;
            let root = Path::new(&identity.runtime_namespace);
            // Each owner uses its existing lifecycle authority. Exhaustive
            // dispatch keeps a new owner from silently skipping reconciliation.
            match &identity.owner {
                SessionCheckoutOwnerV1::Agent { agent_id, .. } => {
                    // Its original runtime can retire while another provider
                    // is selected. Explicit cancellation/removal owns this
                    // lifetime; runtime absence is not release authority.
                    // Pre-selection cancellation already has Closing and its
                    // immutable native root here. Reuse that same close owner,
                    // not runtime absence, a new journal or a cleanup worker.
                    if record.admission == SessionCheckoutAdmissionV1::Closing
                        && store.agent_runtime_selection(agent_id).await?.is_none()
                    {
                        registrations.push(record.binding);
                    }
                }
                SessionCheckoutOwnerV1::Standalone { .. } => {
                    crate::standalone_close::resume_standalone_checkout_close(
                        &store,
                        &LocalSessionCatalog::new(root),
                        record,
                    )
                    .await?;
                }
                SessionCheckoutOwnerV1::Recovery { .. } => {
                    crate::standalone_creation::reconcile_retention(
                        &store,
                        &LocalSessionCatalog::new(root),
                        record,
                    )
                    .await?;
                }
                SessionCheckoutOwnerV1::Managed {
                    workspace_id,
                    session_id,
                    idempotency_key,
                } => {
                    identities.push((
                        identity.runtime_namespace.clone(),
                        ManagedCreateReconcileRequest::new(
                            idempotency_key,
                            session_id,
                            workspace_id,
                        )
                        .map_err(|error| {
                            std::io::Error::new(std::io::ErrorKind::InvalidData, error)
                        })?,
                    ));
                }
            }
        }
        for binding in registrations {
            let root = PathBuf::from(&binding.identity.runtime_namespace);
            let executable = executable.clone();
            crate::close_agent_registration(
                store.clone(),
                LocalSessionCatalog::new(root),
                binding,
                executable,
            )
            .await?;
        }
        for (namespace, reconcile) in identities {
            let root = PathBuf::from(&namespace);
            let executable = executable.clone();
            reconcile_creation(store.clone(), namespace, reconcile, move || {
                Ok(ManagedSessionCreateReconciler::new(executable()?).with_discovery_root(root))
            })
            .await?;
        }
        Ok(())
    })
    .await?
}
