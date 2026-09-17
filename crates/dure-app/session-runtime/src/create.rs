use std::future::Future;
use std::path::Path;

use dure_app::{
    SessionCheckoutAdmissionV1, SessionCheckoutBindingV1, SessionCheckoutIdentityV1,
    SessionCheckoutRecordV1,
};
use dure_git_checkout::{
    GitCheckoutInstanceError, capture_git_checkout_registration, claim_git_checkout_registration,
    retain_working_directory,
};
use hmux_client::recovery_journal::managed_create_ledger::{
    ManagedCreateAdmissionError, ManagedCreateLedgerState, ManagedCreateLineageAdmission,
    ManagedCreateReconcileLedgerState, prepare_root_request, reconcile_identity, reserve_request,
    resolve_create_origin,
};
use hmux_client::{
    CreatedManagedSession, ManagedCreateAdvanceResolution, ManagedCreateReconcileRequest,
    ManagedCreateRequest, ManagedSessionCreator,
};

use crate::{CheckoutSessionRuntime, SessionCheckoutError, managed_identity};

impl CheckoutSessionRuntime {
    /// Reserve first, retain the exact resource, then let the runtime create.
    /// Losing the caller detaches observation, not the admitted operation.
    pub async fn create(
        &self,
        request: ManagedCreateRequest,
    ) -> Result<CreatedManagedSession, SessionCheckoutError> {
        self.execute_create(request, None, false, |creator, request| {
            creator.create(request)
        })
        .await
    }

    /// Retain one origin claim while the runtime reconciles source policy and
    /// allocates successors. Existing identities keep their runtime authority.
    pub async fn advance(
        &self,
        request: ManagedCreateRequest,
    ) -> Result<ManagedCreateAdvanceResolution, SessionCheckoutError> {
        self.execute_create(request, None, true, |creator, request| {
            creator.create_or_reconcile_and_advance(request)
        })
        .await
    }

    /// Retain this independent session through a product's existing async
    /// launch port. The port must execute the same prepared request; admission,
    /// cancellation and compensation remain owned by this shared lifecycle.
    pub async fn advance_using<T, E, F, Fut>(
        &self,
        request: ManagedCreateRequest,
        launch: F,
    ) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<SessionCheckoutError> + Send + 'static,
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, E>> + Send,
    {
        self.execute_retained(request, None, true, move |_| launch())
            .await
    }

    /// Keep the checkout on this root while Hmux allocates and reconciles its
    /// successors. Logical close already resolves their origin through Hmux.
    /// A failed target cannot release an inherited claim; explicit close can.
    pub async fn create_replacement_and_advance(
        &self,
        source_binding: Option<SessionCheckoutBindingV1>,
        request: ManagedCreateRequest,
    ) -> Result<ManagedCreateAdvanceResolution, SessionCheckoutError> {
        self.execute_create(request, source_binding, false, |creator, request| {
            creator.create_or_reconcile_and_advance(request)
        })
        .await
    }

    pub(super) async fn execute_create<T, E, F>(
        &self,
        request: ManagedCreateRequest,
        source_binding: Option<SessionCheckoutBindingV1>,
        advance: bool,
        launch: F,
    ) -> Result<T, SessionCheckoutError>
    where
        T: Send + 'static,
        E: Send + 'static,
        SessionCheckoutError: From<E>,
        F: FnOnce(ManagedSessionCreator, ManagedCreateRequest) -> Result<T, E> + Send + 'static,
    {
        let creator = self.creator.clone();
        self.execute_retained(
            request,
            source_binding,
            advance,
            move |prepared| async move {
                Ok(tokio::task::spawn_blocking(move || launch(creator, prepared)).await??)
            },
        )
        .await
    }

    async fn execute_retained<T, E, F, Fut>(
        &self,
        request: ManagedCreateRequest,
        source_binding: Option<SessionCheckoutBindingV1>,
        advance: bool,
        launch: F,
    ) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<SessionCheckoutError> + Send + 'static,
        F: FnOnce(ManagedCreateRequest) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, E>> + Send,
    {
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut reconcile = ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .expect("a validated create request has a valid reconciliation identity");
            if advance {
                let root = runtime.discovery_root.clone();
                reconcile =
                    tokio::task::spawn_blocking(move || resolve_create_origin(&root, &reconcile))
                        .await
                        .map_err(SessionCheckoutError::from)?
                        .map_err(SessionCheckoutError::from)?;
            }
            let identity = managed_identity(
                &runtime.namespace,
                reconcile.idempotency_key(),
                reconcile.session_id(),
                reconcile.workspace_id(),
            );
            let created = async {
                runtime
                    .prepare_checkout(identity, request.provider_cwd(), source_binding, || {
                        runtime.reserve_creation(request.clone(), advance)
                    })
                    .await?;
                launch(request).await
            }
            .await;
            if created.is_err() {
                runtime.reconcile_creation(reconcile).await?;
            }
            created
        })
        .await
        .map_err(SessionCheckoutError::from)?
    }

    pub(super) async fn prepare_checkout<F, Fut>(
        &self,
        identity: SessionCheckoutIdentityV1,
        cwd: &Path,
        source_binding: Option<SessionCheckoutBindingV1>,
        reserve: F,
    ) -> Result<SessionCheckoutBindingV1, SessionCheckoutError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(), SessionCheckoutError>>,
    {
        if let Some(binding) = self.registered_agent_checkout(&identity).await? {
            if Path::new(&binding.working_directory) != cwd
                || source_binding
                    .as_ref()
                    .is_some_and(|source| source != &binding)
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "registered launch names another resource",
                )
                .into());
            }
            let admission = self.store.admit_agent_checkout(&binding, &identity).await?;
            reserve().await?;
            return claim_admission(admission, cwd).await;
        }
        let record = match source_binding {
            Some(binding) => {
                // A linked checkout can retain a different subdirectory;
                // Git checks the actual launch cwd against that instance below.
                // A frozen non-checkout selection cannot cover a different cwd.
                if binding.registration.is_none() && Path::new(&binding.working_directory) != cwd {
                    return Err(GitCheckoutInstanceError {
                        code: "worktree_identity_changed",
                        message: "replacement left its selected non-checkout working directory"
                            .into(),
                    }
                    .into());
                }
                self.store
                    .transfer_session_checkout_with(&binding, &identity, reserve)
                    .await?
            }
            None => {
                let binding = selected_checkout(&self.store, identity, cwd).await?;
                self.store
                    .prepare_session_checkout_with(&binding, reserve)
                    .await?
            }
        };
        self.admit_checkout(record, cwd).await
    }

    pub(super) async fn admit_checkout(
        &self,
        record: SessionCheckoutRecordV1,
        cwd: &Path,
    ) -> Result<SessionCheckoutBindingV1, SessionCheckoutError> {
        if record.admission != SessionCheckoutAdmissionV1::Open {
            return Err(SessionCheckoutError::Closing);
        }
        let admission = self
            .store
            .admit_session_checkout(&record.binding.identity)
            .await?;
        claim_admission(admission, cwd).await
    }

    pub(super) async fn reserve_creation(
        &self,
        request: ManagedCreateRequest,
        advance: bool,
    ) -> Result<(), SessionCheckoutError> {
        let root = self.discovery_root.clone();
        tokio::task::spawn_blocking(move || {
            if advance {
                // Advance may change the source policy or start from a successor.
                // An existing identity already has durable runtime admission;
                // leave reconciliation of that policy and lineage to the broker.
                let identity = ManagedCreateReconcileRequest::new(
                    request.idempotency_key(),
                    request.session_id(),
                    request.workspace_id(),
                )
                .expect("a validated create request has a reconciliation identity");
                if !matches!(
                    reconcile_identity(&root, &identity)
                        .map_err(ManagedCreateAdmissionError::Ledger)?,
                    ManagedCreateReconcileLedgerState::NotFound
                ) {
                    return Ok(());
                }
                return prepare_root_request(&root, &request).map_err(Into::into);
            }
            match reserve_request(&root, &request, ManagedCreateLineageAdmission::Root)? {
                ManagedCreateLedgerState::Retired => {
                    Err(ManagedCreateAdmissionError::GenerationRetiredExact.into())
                }
                _ => Ok(()),
            }
        })
        .await?
    }
}

pub(super) async fn claim_admission(
    admission: dure_app_sqlite::SessionCheckoutAdmission,
    cwd: &Path,
) -> Result<SessionCheckoutBindingV1, SessionCheckoutError> {
    if admission.retained()
        && admission.binding().registration.is_some()
        && Path::new(&admission.binding().working_directory) == cwd
    {
        let binding = admission.binding().clone();
        admission.finish().await?;
        return Ok(binding);
    }
    let cwd = cwd.to_path_buf();
    // The blocking task owns admission. Cancelling its observer cannot let
    // close pass a Git claim whose blocking task is still running.
    let admission = tokio::task::spawn_blocking(move || {
        let binding = admission.binding();
        if let Some(registration) = &binding.registration {
            claim_git_checkout_registration(&cwd, &binding.claim_id, Some(registration))?;
        } else {
            retain_working_directory(&cwd, &binding.claim_id)?;
        }
        Ok::<_, SessionCheckoutError>(admission)
    })
    .await??;
    let binding = admission.binding().clone();
    admission.finish().await?;
    Ok(binding)
}

pub(super) async fn selected_checkout(
    store: &dure_app_sqlite::SqliteDomainStore,
    identity: SessionCheckoutIdentityV1,
    cwd: &Path,
) -> Result<SessionCheckoutBindingV1, SessionCheckoutError> {
    if let Some(record) = store.session_checkout(&identity).await? {
        return Ok(record.binding);
    }
    let cwd = cwd.to_path_buf();
    tokio::task::spawn_blocking(move || {
        if !cwd.is_absolute() || !std::fs::metadata(&cwd)?.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "working directory must be an existing absolute directory",
            )
            .into());
        }
        // Git is an optional capability. Without an exact registration, claim
        // admission retains the directory under the shared removal authority.
        let registration = capture_git_checkout_registration(&cwd).ok().flatten();
        let working_directory = cwd
            .to_str()
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "non-UTF-8 working directory",
                )
            })?
            .to_owned();
        Ok(SessionCheckoutBindingV1::new(
            identity,
            working_directory,
            registration,
        ))
    })
    .await?
}
