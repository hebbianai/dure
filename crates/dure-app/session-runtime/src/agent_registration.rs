use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    AgentBootstrapV1, OperationIdV1, SessionCheckoutBindingV1, SessionCheckoutIdentityV1,
    SessionCheckoutOwnerV1, SessionCheckoutRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::recovery_journal::managed_create_ledger::{
    ManagedCreateReconcileLedgerState, reconcile_identity,
};
use hmux_client::{LocalSessionCatalog, ManagedCreateReconcileRequest};

use crate::{
    CheckoutSessionRuntime, SessionCheckoutError,
    create::{claim_admission, selected_checkout},
    managed_identity,
    namespace::runtime_namespace,
};

/// The host's registered resource and allocated native root. Clients persist
/// this receipt and use its root for launch; they never allocate another root.
#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCheckoutRegistrationV1 {
    pub binding: SessionCheckoutBindingV1,
    pub root: ManagedCreateReconcileRequest,
}

/// Registration selects the backend namespace, not a runtime executable.
pub async fn register_agent_checkout(
    store: SqliteDomainStore,
    catalog: LocalSessionCatalog,
    registration_id: OperationIdV1,
    agent: AgentBootstrapV1,
) -> Result<AgentCheckoutRegistrationV1, SessionCheckoutError> {
    register_in_namespace(
        store,
        runtime_namespace(catalog.discovery_root())?,
        registration_id,
        agent,
    )
    .await
}

/// Resolve an executable only when the registration's native root was reserved.
/// Unlaunched cancellation still closes product admission before releasing Git.
pub async fn close_agent_registration(
    store: SqliteDomainStore,
    catalog: LocalSessionCatalog,
    binding: SessionCheckoutBindingV1,
    executable: impl FnOnce() -> Result<PathBuf, SessionCheckoutError> + Send + 'static,
) -> Result<(), SessionCheckoutError> {
    let namespace = runtime_namespace(catalog.discovery_root())?;
    let runtime_store = store.clone();
    let runtime_root = PathBuf::from(&namespace);
    close_in_namespace(store, namespace, binding, move || {
        CheckoutSessionRuntime::at_root(runtime_store, executable()?, runtime_root)
    })
    .await
}

impl CheckoutSessionRuntime {
    /// Acquire before a client publishes its Agent projection. Metadata and
    /// registration commit together without requiring a provider/runtime selection.
    /// The caller retains the opaque registration ID across retry.
    pub async fn register_agent_checkout(
        &self,
        registration_id: OperationIdV1,
        agent: AgentBootstrapV1,
    ) -> Result<AgentCheckoutRegistrationV1, SessionCheckoutError> {
        register_in_namespace(
            self.store.clone(),
            self.namespace.clone(),
            registration_id,
            agent,
        )
        .await
    }

    /// Resolve the host-allocated root through the existing indexed claim key.
    /// All create ports use this lookup; an optional client hint cannot select
    /// a different lifetime or turn a registered launch into a Managed claim.
    pub(super) async fn registered_agent_checkout(
        &self,
        origin: &SessionCheckoutIdentityV1,
    ) -> Result<Option<SessionCheckoutBindingV1>, SessionCheckoutError> {
        if let Some(binding) = self.store.agent_checkout_for_root(origin).await? {
            return Ok(Some(binding));
        }
        let SessionCheckoutOwnerV1::Managed {
            workspace_id,
            session_id,
            ..
        } = &origin.owner
        else {
            return Ok(None);
        };
        let Ok(claim_id) = OperationIdV1::new(session_id.clone()) else {
            return Ok(None);
        };
        let Some(record) = self.store.session_checkout_registration(&claim_id).await? else {
            return Ok(None);
        };
        if record
            .binding
            .registered_agent_native_origin(workspace_id)
            .as_ref()
            != Some(origin)
        {
            return Ok(None);
        }
        // Admission compares the saved root and current Agent association in
        // its transaction, including closed predecessor incarnations.
        Ok(Some(record.binding))
    }

    /// Own-only compensation before the Agent has a selected runtime. Closing
    /// is durable before any native root is retired. An unreserved root closes
    /// product launch admission without inventing a runtime retirement receipt;
    /// response-loss replay never invents a generation or releases a successor.
    pub async fn close_agent_registration(
        &self,
        binding: SessionCheckoutBindingV1,
    ) -> Result<(), SessionCheckoutError> {
        let runtime = self.clone();
        close_in_namespace(
            self.store.clone(),
            self.namespace.clone(),
            binding,
            move || Ok(runtime),
        )
        .await
    }

    /// The caller has closed Agent admission through cancellation or removal.
    pub(super) async fn close_registered_native_root(
        &self,
        root: ManagedCreateReconcileRequest,
    ) -> Result<(), SessionCheckoutError> {
        let runtime = self.clone();
        close_registered_native_root(&self.store, &self.namespace, root, move || Ok(runtime)).await
    }
}

async fn register_in_namespace(
    store: SqliteDomainStore,
    namespace: String,
    registration_id: OperationIdV1,
    agent: AgentBootstrapV1,
) -> Result<AgentCheckoutRegistrationV1, SessionCheckoutError> {
    tokio::spawn(async move {
        let identity = SessionCheckoutIdentityV1 {
            runtime_namespace: namespace.clone(),
            owner: SessionCheckoutOwnerV1::Agent {
                agent_id: agent.agent_id.clone(),
                registration_id,
            },
        };
        let cwd = PathBuf::from(&agent.working_directory);
        let binding = selected_checkout(&store, identity, &cwd).await?;
        require_cwd(&binding, &cwd)?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(std::io::Error::other)?
            .as_millis();
        let timestamp = i64::try_from(timestamp).map_err(std::io::Error::other)?;
        let record = store
            .prepare_agent_checkout(&binding, &agent, timestamp)
            .await?;
        let root = native_root(&record)?;
        let origin = managed_identity(
            &namespace,
            root.idempotency_key(),
            root.session_id(),
            root.workspace_id(),
        );
        let admission = store.admit_agent_checkout(&binding, &origin).await?;
        let binding = claim_admission(admission, &cwd).await?;
        Ok(AgentCheckoutRegistrationV1 { binding, root })
    })
    .await?
}

async fn close_in_namespace(
    store: SqliteDomainStore,
    namespace: String,
    binding: SessionCheckoutBindingV1,
    runtime: impl FnOnce() -> Result<CheckoutSessionRuntime, SessionCheckoutError> + Send + 'static,
) -> Result<(), SessionCheckoutError> {
    tokio::spawn(async move {
        require_namespace(&namespace, &binding)?;
        let record = store.begin_agent_registration_close(&binding).await?;
        let mut roots = store.agent_checkout_roots(&binding).await?;
        let initial = native_root(&record)?;
        let initial = managed_identity(
            &namespace,
            initial.idempotency_key(),
            initial.session_id(),
            initial.workspace_id(),
        );
        if !roots.contains(&initial) {
            roots.push(initial);
        }
        let mut resolve_runtime = Some(runtime);
        let mut resolved = None;
        for origin in roots {
            let request = native_request(&namespace, origin)?;
            close_registered_native_root(&store, &namespace, request, || {
                if resolved.is_none() {
                    resolved = Some(resolve_runtime.take().expect("runtime is resolved once")()?);
                }
                Ok(resolved.as_ref().expect("runtime was resolved").clone())
            })
            .await?;
        }
        crate::cleanup::finish_checkout_cleanup(&store, record).await
    })
    .await?
}

async fn close_registered_native_root(
    store: &SqliteDomainStore,
    namespace: &str,
    root: ManagedCreateReconcileRequest,
    runtime: impl FnOnce() -> Result<CheckoutSessionRuntime, SessionCheckoutError>,
) -> Result<(), SessionCheckoutError> {
    let identity = managed_identity(
        namespace,
        root.idempotency_key(),
        root.session_id(),
        root.workspace_id(),
    );
    // Registered launch reserves Hmux while holding Agent admission. Close
    // also fences the generic product create path before observing Hmux, so
    // a delayed caller cannot bypass cancellation by losing its Agent hint.
    // Ledger NotFound now means no admitted product launch can arrive later;
    // it is not an inference of process absence from discovery/filesystem CWD.
    store.begin_session_checkout_close(&identity).await?;
    let discovery = PathBuf::from(namespace);
    let requested = root.clone();
    let reserved = tokio::task::spawn_blocking(move || reconcile_identity(&discovery, &requested))
        .await?
        .map_err(SessionCheckoutError::Journal)?;
    if matches!(reserved, ManagedCreateReconcileLedgerState::NotFound) {
        crate::cleanup::finish_retired_checkout(store, identity).await
    } else {
        runtime()?.close(root).await.map(|_| ())
    }
}

fn native_root(
    record: &SessionCheckoutRecordV1,
) -> Result<ManagedCreateReconcileRequest, SessionCheckoutError> {
    let origin: SessionCheckoutIdentityV1 = serde_json::from_value(
        record
            .close_payload
            .clone()
            .ok_or_else(|| invalid("registration lost its native root"))?,
    )?;
    native_request(&record.binding.identity.runtime_namespace, origin)
}

pub(super) fn native_request(
    namespace: &str,
    origin: SessionCheckoutIdentityV1,
) -> Result<ManagedCreateReconcileRequest, SessionCheckoutError> {
    if origin.runtime_namespace != namespace {
        return Err(invalid(
            "registration root belongs to another runtime namespace",
        ));
    }
    let SessionCheckoutOwnerV1::Managed {
        workspace_id,
        session_id,
        idempotency_key,
    } = origin.owner
    else {
        return Err(invalid("registration requires a native create root"));
    };
    ManagedCreateReconcileRequest::new(idempotency_key, session_id, workspace_id)
        .map_err(|error| invalid(&error.to_string()))
}

fn require_namespace(
    namespace: &str,
    binding: &SessionCheckoutBindingV1,
) -> Result<(), SessionCheckoutError> {
    if binding.identity.runtime_namespace != namespace {
        return Err(invalid(
            "Agent registration belongs to another runtime namespace",
        ));
    }
    Ok(())
}

fn require_cwd(binding: &SessionCheckoutBindingV1, cwd: &Path) -> Result<(), SessionCheckoutError> {
    if Path::new(&binding.working_directory) != cwd {
        return Err(invalid("Agent registration working directory changed"));
    }
    Ok(())
}

fn invalid(message: &str) -> SessionCheckoutError {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message).into()
}

#[cfg(test)]
mod tests;
