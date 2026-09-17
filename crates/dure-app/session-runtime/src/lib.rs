//! Compose product resource retention with the existing runtime lifecycle.
//!
//! SQLite freezes the selected checkout and serializes this product's claim
//! writer against close. Git owns membership/removal; the runtime owns create
//! identity, successor chains and process retirement. No provider process runs
//! while a SQLite transaction is held.

use std::path::PathBuf;

use dure_app::{SessionCheckoutIdentityV1, SessionCheckoutOwnerV1};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::recovery_journal::managed_create_ledger::resolve_create_origin;
use hmux_client::{
    LocalSessionCatalog, ManagedCreateChainStopReceiptV2, ManagedCreateReconcileRequest,
    ManagedSessionCreateReconciler, ManagedSessionCreator, ManagedSessionStopper,
    StandaloneSessionCreator,
};
use hmux_host::local_discovery::DiscoveryRoot;

mod error;
pub use error::SessionCheckoutError;
mod agent_registration;
mod agent_removal;
pub use agent_registration::{
    AgentCheckoutRegistrationV1, close_agent_registration, register_agent_checkout,
};
mod checkout_recovery;
mod cleanup;
use cleanup::finish_managed_close;
mod create;
mod handoff;
mod managed_cleanup;
pub use managed_cleanup::reconcile_managed_close;
mod managed_create_resolution;
pub use managed_create_resolution::{
    ManagedCreateAdvanceCommandResolution, ManagedCreateRetrySameReason, project_checkout_advance,
};
pub mod host_command;
mod replacement;
pub use handoff::recovery_checkout_binding;
mod namespace;
use namespace::runtime_namespace;
mod standalone;
mod standalone_handoff;
pub use hmux_client::StandaloneReplacementSource;
mod standalone_close;
mod standalone_creation;
pub use checkout_recovery::{reconcile_catalog_checkout_users, reconcile_checkout_users};
pub use standalone_close::{StandaloneCloseOutcome, close_standalone_session};

#[derive(Clone)]
pub struct CheckoutSessionRuntime {
    store: SqliteDomainStore,
    discovery_root: PathBuf,
    namespace: String,
    creator: ManagedSessionCreator,
    standalone_creator: StandaloneSessionCreator,
    reconciler: ManagedSessionCreateReconciler,
    stopper: ManagedSessionStopper,
}

fn managed_identity(
    namespace: &str,
    key: &str,
    session: &str,
    workspace: &str,
) -> SessionCheckoutIdentityV1 {
    SessionCheckoutIdentityV1 {
        runtime_namespace: namespace.into(),
        owner: SessionCheckoutOwnerV1::Managed {
            workspace_id: workspace.into(),
            session_id: session.into(),
            idempotency_key: key.into(),
        },
    }
}

impl CheckoutSessionRuntime {
    /// Diagnostic selection follows this execution handle across worker tasks;
    /// it does not alter the retained resource or provider request identity.
    #[must_use]
    pub fn with_broker_timing(mut self) -> Self {
        self.creator = self.creator.with_broker_timing();
        self
    }

    /// Preserve the runtime's environment-derived canonical and read-only roots.
    pub fn from_environment(
        store: SqliteDomainStore,
        runtime: PathBuf,
    ) -> Result<Self, SessionCheckoutError> {
        Self::open(store, runtime, None)
    }

    /// Explicit roots are for an already selected local backend or isolated QA.
    pub fn at_root(
        store: SqliteDomainStore,
        runtime: PathBuf,
        discovery_root: PathBuf,
    ) -> Result<Self, SessionCheckoutError> {
        Self::open(store, runtime, Some(discovery_root))
    }

    fn open(
        store: SqliteDomainStore,
        runtime: PathBuf,
        configured_root: Option<PathBuf>,
    ) -> Result<Self, SessionCheckoutError> {
        let root = match &configured_root {
            Some(root) => root.clone(),
            None => LocalSessionCatalog::from_environment()?
                .discovery_root()
                .to_path_buf(),
        };
        let root = DiscoveryRoot::create(root).map_err(hmux_client::ClientError::from)?;
        let namespace = runtime_namespace(root.path())?;
        let discovery_root = PathBuf::from(&namespace);
        let working_directory = runtime.parent().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "runtime has no parent")
        })?;
        let creator = ManagedSessionCreator::new(&runtime);
        // Fresh standalone creation and its journal share one writable namespace;
        // unlike source lookup, it does not consume compatibility roots.
        let standalone_creator =
            StandaloneSessionCreator::new(&runtime).with_discovery_root(&discovery_root);
        let reconciler = ManagedSessionCreateReconciler::new(&runtime);
        let stopper = ManagedSessionStopper::new(&runtime, working_directory);
        let (creator, reconciler, stopper) = if configured_root.is_some() {
            (
                creator.with_discovery_root(&discovery_root),
                reconciler.with_discovery_root(&discovery_root),
                stopper.with_discovery_root(&discovery_root),
            )
        } else {
            (creator, reconciler, stopper)
        };
        Ok(Self {
            store,
            discovery_root,
            namespace,
            creator,
            standalone_creator,
            reconciler,
            stopper,
        })
    }

    async fn reconcile_creation(
        &self,
        reconcile: ManagedCreateReconcileRequest,
    ) -> Result<(), SessionCheckoutError> {
        let reconciler = self.reconciler.clone();
        managed_cleanup::reconcile_creation(
            self.store.clone(),
            self.namespace.clone(),
            reconcile,
            move || Ok(reconciler),
        )
        .await
    }

    /// End a logical session lifetime, not merely a generation during rehost.
    /// A failed/pending stop leaves Closing and retains the exact Git claim.
    /// An admitted close finishes even if its caller stops awaiting the result.
    pub async fn close(
        &self,
        root: ManagedCreateReconcileRequest,
    ) -> Result<ManagedCreateChainStopReceiptV2, SessionCheckoutError> {
        let runtime = self.clone();
        tokio::spawn(async move { runtime.close_owned(root).await }).await?
    }

    async fn close_owned(
        &self,
        root: ManagedCreateReconcileRequest,
    ) -> Result<ManagedCreateChainStopReceiptV2, SessionCheckoutError> {
        // Product claims belong to root creates, not unbound rehost successors.
        // Close that owner's admission before runtime stop, including when the
        // caller knows only a successor and its stop transport subsequently fails.
        let discovery = self.discovery_root.clone();
        let requested = root.clone();
        let origin =
            tokio::task::spawn_blocking(move || resolve_create_origin(&discovery, &requested))
                .await??;
        let identity = managed_identity(
            &self.namespace,
            origin.idempotency_key(),
            origin.session_id(),
            origin.workspace_id(),
        );
        self.store.begin_session_checkout_close(&identity).await?;
        let stopper = self.stopper.clone();
        let receipt =
            tokio::task::spawn_blocking(move || stopper.stop_create_chain_v2(root)).await??;
        finish_managed_close(&self.store, &self.namespace, &receipt).await?;
        Ok(receipt)
    }
}
