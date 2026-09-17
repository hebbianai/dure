use dure_app::{SessionCheckoutBindingV1, SessionCheckoutIdentityV1, SessionCheckoutOwnerV1};
use hmux_client::{
    CreatedStandaloneSession, StandaloneCreateRequest, StandaloneReplacementSource,
    standalone_create_idempotency_key,
};
use hmux_host::local_discovery::workspace_id_for_path;
use std::time::Duration;

use crate::{CheckoutSessionRuntime, SessionCheckoutError};

pub(super) fn standalone_identity(
    namespace: &str,
    key: &str,
    session: &str,
    workspace: &str,
) -> SessionCheckoutIdentityV1 {
    SessionCheckoutIdentityV1 {
        runtime_namespace: namespace.to_owned(),
        owner: SessionCheckoutOwnerV1::Standalone {
            workspace_id: workspace.into(),
            session_id: session.into(),
            recovery_id: key.into(),
        },
    }
}

impl CheckoutSessionRuntime {
    /// Retain the checkout before launching the journal's exact target. Transfer
    /// an existing source binding, or acquire one for a legacy unbound source.
    /// The caller's prepared recovery journal owns this request and its replay;
    /// a failed launch cannot release the claim while retry can still create.
    /// Optional exact source stop follows admission, never precedes it.
    pub async fn create_standalone_replacement(
        &self,
        source: Option<SessionCheckoutBindingV1>,
        request: StandaloneCreateRequest,
        replacement_source: Option<StandaloneReplacementSource>,
    ) -> Result<CreatedStandaloneSession, SessionCheckoutError> {
        let runtime = self.clone();
        tokio::spawn(async move {
            let _source_lock = replacement_source
                .as_ref()
                .map(StandaloneReplacementSource::lock)
                .transpose()
                .map_err(SessionCheckoutError::Journal)?;
            runtime.retain_standalone(&request, source).await?;
            if let Some(source) = replacement_source {
                tokio::task::spawn_blocking(move || source.stop(Duration::from_secs(3))).await??;
            }
            let creator = runtime.standalone_creator.clone();
            let created = tokio::task::spawn_blocking(move || creator.create(request)).await??;
            crate::standalone_close::remember_standalone_close_target(
                &runtime.store,
                created.session(),
            )
            .await?;
            Ok(created)
        })
        .await?
    }

    pub(super) async fn retain_standalone(
        &self,
        request: &StandaloneCreateRequest,
        source: Option<SessionCheckoutBindingV1>,
    ) -> Result<(), SessionCheckoutError> {
        let recovery = request
            .recovery_identity()
            .ok_or(SessionCheckoutError::MissingCreateIdentity)?;
        let cwd = request.provider_cwd().canonicalize()?;
        let identity = standalone_identity(
            &self.namespace,
            &standalone_create_idempotency_key(recovery),
            recovery.target_session_id(),
            &workspace_id_for_path(&cwd),
        );
        // Both ordinary creation and replacement have already reserved their
        // full request in the existing journal before resource admission.
        self.prepare_checkout(identity, &cwd, source, || async { Ok(()) })
            .await
            .map(|_| ())
    }
}
