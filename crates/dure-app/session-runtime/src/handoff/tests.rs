use super::*;
use std::path::PathBuf;
use std::time::Duration;

use dure_app_sqlite::SqliteDomainStore;
use hmux_client::{
    CompletedStandaloneTargetLifecycle, ExitedSessionRetirementGeneration,
    LocalProcessGenerationStatus, LocalSessionCatalog, ManagedCreateAdvanceResolution,
    ManagedCreateRequest, ManagedSessionCreator, ManagedSessionStopper, ManagedStopRequest,
    PermissionMode, StandaloneCreateRequest, StandaloneRecipeRequirement,
    StandaloneRecoveryCreateIdentity, StandaloneSessionCreator, probe_local_process_generation,
};

#[tokio::test]
async fn prepared_recovery_binding_matches_the_durable_destination_owner() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let store = SqliteDomainStore::open(root.join("state.sqlite3"))
        .await
        .unwrap();
    let source = SessionCheckoutBindingV1::new(
        managed_identity(
            root.join("source").to_str().unwrap(),
            "source-create",
            "source-session",
            "workspace",
        ),
        root.to_str().unwrap().into(),
        None,
    );
    store
        .prepare_session_checkout_with(&source, || async {
            Ok::<_, dure_app::DomainStoreErrorV1>(())
        })
        .await
        .unwrap();
    // Identity preparation and transfer do not launch a runtime process.
    let destination = CheckoutSessionRuntime::at_root(
        store.clone(),
        root.join("unused-runtime"),
        root.join("destination"),
    )
    .unwrap();
    let prepared =
        recovery_checkout_binding(&source, &root.join("destination"), "recovery").unwrap();
    let transferred = destination
        .retain_checkout_for_recovery(source.clone(), "recovery".into())
        .await
        .unwrap();
    assert_eq!(prepared, transferred);
    assert_eq!(transferred.claim_id, source.claim_id);
    assert_eq!(
        transferred.identity.runtime_namespace,
        root.join("destination").to_str().unwrap(),
    );
    assert_eq!(
        store
            .session_checkout(&prepared.identity)
            .await
            .unwrap()
            .unwrap()
            .binding,
        prepared,
    );
    assert!(
        store
            .session_checkout(&source.identity)
            .await
            .unwrap()
            .is_none()
    );
    store.close().await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn standalone_handoff_reads_the_observed_source_namespace() {
    let fixture = Fixture::new().await;
    let request = StandaloneCreateRequest::new(
        &fixture.root,
        Some("handoff-source".into()),
        command(),
        24,
        80,
    )
    .unwrap()
    .with_recovery_identity(
        StandaloneRecoveryCreateIdentity::new("standalone_handoff", "source-create")
            .unwrap()
            .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound),
    )
    .unwrap();
    let created = StandaloneSessionCreator::new(&fixture.executable)
        .with_discovery_root(fixture.root.join("source"))
        .create(request)
        .unwrap();
    let source = created.session().clone();
    let descriptor = source.descriptor();
    let binding = SessionCheckoutBindingV1::new(
        crate::standalone::standalone_identity(
            fixture.root.join("source").to_str().unwrap(),
            source.create_idempotency_key().unwrap(),
            &descriptor.session_id,
            &descriptor.workspace_id,
        ),
        fixture.root.to_str().unwrap().into(),
        None,
    );
    // This lookup fixture supplies an explicit non-linked resource record for
    // an actual runtime creation; it does not certify ordinary create admission.
    fixture
        .store
        .prepare_session_checkout_with(&binding, || async {
            Ok::<_, dure_app::DomainStoreErrorV1>(())
        })
        .await
        .unwrap();
    let result = fixture
        .destination
        .checkout_for_session(source.clone())
        .await;
    let still_live = probe_local_process_generation(&descriptor.provider_process).unwrap();
    let cleanup = LocalSessionCatalog::new(fixture.root.join("source"))
        .retire_completed_standalone_target(
            &ExitedSessionRetirementGeneration::from_descriptor(descriptor).unwrap(),
            &descriptor.provider_process,
            Duration::from_secs(3),
        );
    fixture.store.close().await;
    assert_eq!(cleanup, CompletedStandaloneTargetLifecycle::Retired);
    assert_eq!(still_live, LocalProcessGenerationStatus::Live);
    assert_eq!(result.unwrap(), Some(binding));
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn managed_handoff_reads_the_observed_source_namespace() {
    assert_managed_handoff(false).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn managed_successor_handoff_resolves_its_source_origin() {
    assert_managed_handoff(true).await;
}

async fn assert_managed_handoff(advance: bool) {
    let fixture = Fixture::new().await;
    let request = ManagedCreateRequest::new(
        "source-create",
        "handoff-source",
        "workspace",
        "local-shell",
        PermissionMode::Default,
        &fixture.root,
        command(),
        24,
        80,
    )
    .unwrap();
    let created = fixture.source.create(request.clone()).await.unwrap();
    let binding = fixture
        .store
        .session_checkout(&SessionCheckoutIdentityV1 {
            runtime_namespace: fixture.root.join("source").to_str().unwrap().into(),
            owner: SessionCheckoutOwnerV1::Managed {
                idempotency_key: request.idempotency_key().into(),
                session_id: request.session_id().into(),
                workspace_id: request.workspace_id().into(),
            },
        })
        .await
        .unwrap()
        .unwrap()
        .binding;
    let source = if advance {
        let descriptor = created.session().descriptor();
        let stop = ManagedStopRequest::new(
            "advance-source",
            &descriptor.session_id,
            &descriptor.workspace_id,
        )
        .unwrap()
        .with_expected_fence(
            &descriptor.runner_principal,
            &descriptor.runner_instance,
            descriptor.channel_epoch.parse().unwrap(),
            &descriptor.host_instance_id,
            &descriptor.terminal_epoch,
        )
        .unwrap();
        ManagedSessionStopper::new(&fixture.executable, &fixture.root)
            .with_discovery_root(fixture.root.join("source"))
            .stop(stop)
            .unwrap();
        let ManagedCreateAdvanceResolution::Advanced(successor) =
            ManagedSessionCreator::new(&fixture.executable)
                .with_discovery_root(fixture.root.join("source"))
                .create_or_reconcile_and_advance(request.clone())
                .unwrap()
        else {
            panic!("an explicitly stopped source must advance");
        };
        assert_ne!(
            successor.session().descriptor().session_id,
            request.session_id()
        );
        successor.session().clone()
    } else {
        created.session().clone()
    };
    let result = fixture
        .destination
        .checkout_for_session(source.clone())
        .await;
    let still_live = probe_local_process_generation(&source.descriptor().provider_process).unwrap();
    // Capture lookup and liveness before closing the owned source lineage.
    fixture
        .source
        .close(
            ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    fixture.store.close().await;
    assert_eq!(still_live, LocalProcessGenerationStatus::Live);
    assert_eq!(result.unwrap(), Some(binding));
}

fn command() -> Vec<String> {
    vec![
        "/bin/sh".into(),
        "-c".into(),
        "while IFS= read -r line; do :; done".into(),
    ]
}

struct Fixture {
    root: PathBuf,
    store: SqliteDomainStore,
    executable: PathBuf,
    source: CheckoutSessionRuntime,
    destination: CheckoutSessionRuntime,
}

impl Fixture {
    async fn new() -> Self {
        let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
            .canonicalize()
            .unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        assert!(root.starts_with(&guardian) && root != guardian);
        // Preserve every discovery record until the outer process guardian has
        // retired the exact Host/provider generations, including after panic.
        let root = temporary.keep().canonicalize().unwrap();
        let store = SqliteDomainStore::open(root.join("application-state.sqlite3"))
            .await
            .unwrap();
        let executable = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
        let source =
            CheckoutSessionRuntime::at_root(store.clone(), executable.clone(), root.join("source"))
                .unwrap();
        let destination = CheckoutSessionRuntime::at_root(
            store.clone(),
            executable.clone(),
            root.join("destination"),
        )
        .unwrap();
        Self {
            root,
            store,
            executable,
            source,
            destination,
        }
    }
}
