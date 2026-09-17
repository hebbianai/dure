use super::*;
use dure_app::{SessionCheckoutAdmissionV1, SessionCheckoutBindingV1};
use hmux_client::{
    LocalProcessGenerationStatus, LocalSession, StandaloneCreateRequest,
    StandaloneRecipeRequirement, StandaloneRecoveryCreateIdentity, StandaloneSessionCreator,
    probe_local_process_generation,
};

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn standalone_close_reaches_a_compatibility_root_when_the_primary_root_is_absent() {
    let fixture = NativeFixture::new().await;
    let descriptor = fixture.source.descriptor();
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    assert_eq!(
        fixture
            .catalog()
            .open(&SessionSelector::new(
                &descriptor.session_id,
                Some(descriptor.workspace_id.clone()),
            ))
            .unwrap()
            .descriptor(),
        descriptor
    );
    assert!(!fixture.primary.exists());

    let result = fixture.close().await;
    let provider_after_close = probe_local_process_generation(&descriptor.provider_process);
    // Observe the service result before cleanup; cleanup cannot manufacture GREEN.
    let cleanup = fixture.retire();
    fixture.store.close().await;
    assert_eq!(cleanup, CompletedStandaloneTargetLifecycle::Retired);
    assert!(!fixture.primary.exists());
    assert_eq!(result.unwrap(), StandaloneCloseOutcome::Terminated);
    assert_eq!(
        provider_after_close.unwrap(),
        LocalProcessGenerationStatus::Absent
    );
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn compatibility_close_finishes_the_binding_in_its_source_namespace() {
    let fixture = NativeFixture::new().await;
    std::fs::create_dir(&fixture.primary).unwrap();
    let binding = fixture.bind().await;
    let result = fixture.close().await;
    let after_close = fixture
        .store
        .session_checkout(&binding.identity)
        .await
        .unwrap()
        .unwrap();
    let cleanup = fixture.retire();
    fixture.store.close().await;
    assert_eq!(cleanup, CompletedStandaloneTargetLifecycle::Retired);
    assert_eq!(result.unwrap(), StandaloneCloseOutcome::Terminated);
    assert_eq!(after_close.binding, binding);
    assert_eq!(after_close.admission, SessionCheckoutAdmissionV1::Closed);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn absent_compatibility_root_resumes_its_admitted_close_after_reopen() {
    absent_compatibility_root_resumes_close(true).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn absent_compatibility_root_closes_a_created_target_after_reopen() {
    absent_compatibility_root_resumes_close(false).await;
}

async fn absent_compatibility_root_resumes_close(admit_before_retirement: bool) {
    let fixture = NativeFixture::new().await;
    std::fs::create_dir(&fixture.primary).unwrap();
    let binding = fixture.bind().await;
    let descriptor = fixture.source.descriptor();
    let request = StandaloneCloseRequest {
        generation: ExitedSessionRetirementGeneration::from_descriptor(descriptor).unwrap(),
        provider_process: descriptor.provider_process.clone(),
    };
    let payload = serde_json::to_value(request).unwrap();
    if admit_before_retirement {
        fixture
            .store
            .begin_session_checkout_close_with(&binding.identity, &payload)
            .await
            .unwrap()
            .unwrap();
    } else {
        let remembered = fixture
            .store
            .remember_session_checkout_close_target(&binding.identity, &payload)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(remembered.admission, SessionCheckoutAdmissionV1::Open);
    }
    assert_eq!(
        fixture.retire(),
        CompletedStandaloneTargetLifecycle::Retired
    );
    // Exact retirement precedes loss of discovery. Preserve the retired files
    // in this same owned fixture instead of deleting evidence for the guardian.
    std::fs::rename(
        &fixture.compatibility,
        fixture.root.join("retired-discovery"),
    )
    .unwrap();
    fixture.store.close().await;
    let reopened = SqliteDomainStore::open(fixture.root.join("application-state.sqlite3"))
        .await
        .unwrap();
    let result = close_standalone_session(
        reopened.clone(),
        fixture.catalog(),
        descriptor.workspace_id.clone(),
        descriptor.session_id.clone(),
        Some(descriptor.terminal_epoch.clone()),
        Duration::from_secs(3),
    )
    .await;
    let after_close = reopened
        .session_checkout(&binding.identity)
        .await
        .unwrap()
        .unwrap();
    reopened.close().await;
    assert_eq!(result.unwrap(), StandaloneCloseOutcome::AlreadyExited);
    assert_eq!(after_close.binding, binding);
    assert_eq!(after_close.admission, SessionCheckoutAdmissionV1::Closed);
    assert!(!fixture.compatibility.exists());
}

struct NativeFixture {
    root: PathBuf,
    store: SqliteDomainStore,
    compatibility: PathBuf,
    primary: PathBuf,
    source: LocalSession,
}

impl NativeFixture {
    async fn new() -> Self {
        let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
            .canonicalize()
            .unwrap();
        let (temporary, root, store) = fixture().await;
        assert!(root.starts_with(&guardian) && root != guardian);
        // The process guardian, not TempDir::drop on a test panic, owns final
        // removal after reconciling every exact Host/provider generation.
        let root = temporary.keep();
        let runtime = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
        let compatibility = tempfile::tempdir_in(&root).unwrap().keep();
        let primary = root.join("never-created-primary");
        let request = StandaloneCreateRequest::new(
            &root,
            Some("compatibility-close".into()),
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "while IFS= read -r line; do :; done".into(),
            ],
            24,
            80,
        )
        .unwrap()
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new(
                "standalone_compatibility_close",
                "fixture-launch",
            )
            .unwrap()
            .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound),
        )
        .unwrap();
        let created = StandaloneSessionCreator::new(runtime)
            .with_discovery_root(&compatibility)
            .create(request)
            .unwrap();
        Self {
            root,
            store,
            compatibility,
            primary,
            source: created.session().clone(),
        }
    }

    fn catalog(&self) -> LocalSessionCatalog {
        LocalSessionCatalog::with_read_only_discovery_roots(
            &self.primary,
            vec![self.compatibility.clone()],
        )
        .unwrap()
    }

    async fn close(&self) -> Result<StandaloneCloseOutcome, crate::SessionCheckoutError> {
        let descriptor = self.source.descriptor();
        close_standalone_session(
            self.store.clone(),
            self.catalog(),
            descriptor.workspace_id.clone(),
            descriptor.session_id.clone(),
            Some(descriptor.terminal_epoch.clone()),
            Duration::from_secs(3),
        )
        .await
    }

    fn retire(&self) -> CompletedStandaloneTargetLifecycle {
        let descriptor = self.source.descriptor();
        LocalSessionCatalog::new(&self.compatibility).retire_completed_standalone_target(
            &ExitedSessionRetirementGeneration::from_descriptor(descriptor).unwrap(),
            &descriptor.provider_process,
            Duration::from_secs(3),
        )
    }

    async fn bind(&self) -> SessionCheckoutBindingV1 {
        let descriptor = self.source.descriptor();
        let identity = standalone_identity(
            self.compatibility.canonicalize().unwrap().to_str().unwrap(),
            self.source.create_idempotency_key().unwrap(),
            &descriptor.session_id,
            &descriptor.workspace_id,
        );
        let binding =
            SessionCheckoutBindingV1::new(identity, self.root.to_str().unwrap().into(), None);
        self.store
            .prepare_session_checkout_with(&binding, || async {
                Ok::<_, dure_app::DomainStoreErrorV1>(())
            })
            .await
            .unwrap();
        binding
    }
}
