use super::*;
use dure_app::{
    GitCheckoutRegistrationV1, GitCheckoutRemovalPolicyV1, GitCheckoutRemovalRequestV1,
    SessionCheckoutAdmissionV1, SessionCheckoutRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use dure_git_checkout::{
    GitCheckoutRemovalOperation, capture_git_checkout_registration, read_git_checkout_claims,
};
use hmux_client::{
    CompletedStandaloneTargetLifecycle, LocalSessionObserver, ObserverAttachOptions,
    SessionRetirementReceiptState, SessionSelector,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

mod caller_disconnect;
mod pending_retirement;
mod refusal;
mod refusal_gc;
mod replacement;
mod retention;

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn unpresented_creation_releases_its_checkout_after_exact_retirement_and_reopen() {
    let fixture = Fixture::new().await;
    let created = fixture.create().await;
    let target = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )
    .unwrap();
    assert_eq!(fixture.claims(), 1);
    assert_eq!(
        fixture.removal("before-abandon"),
        Err("checkout_use_in_use")
    );
    assert_eq!(
        created.abandon_unpresented_creation().unwrap().state,
        SessionRetirementReceiptState::RetirementArmed
    );
    fixture.wait_for_retirement(&target).await;
    fixture.runtime.store.close().await;
    let reopened = SqliteDomainStore::open(&fixture.database).await.unwrap();
    crate::reconcile_checkout_users(
        reopened.clone(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
        fixture.registration.clone(),
    )
    .await
    .unwrap();
    let after = (fixture.claims(), fixture.removal("after-abandon"));
    reopened.close().await;
    assert_eq!(after, (0, Ok(())));
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn creation_lost_before_result_checkpoint_releases_its_retired_checkout_after_reopen() {
    let fixture = Fixture::new().await;
    let operation = OperationIdV1::new("ordinary-create").unwrap();
    let catalog = LocalSessionCatalog::new(&fixture.discovery);
    let Creation::Pending(prepared) = prepare(&catalog, &operation, fixture.request()).unwrap()
    else {
        panic!("new fixture must prepare its own creation");
    };
    let (reservation, request) = *prepared;
    fixture
        .runtime
        .retain_creation_request(reservation.recovery_id(), &request)
        .await
        .unwrap();
    let created = fixture.runtime.standalone_creator.create(request).unwrap();
    assert!(
        reservation
            .operation_checkpoint()
            .unwrap()
            .replacement_receipt
            .is_none()
    );
    drop(reservation);
    assert_eq!(fixture.record().await.close_payload, None);
    let target = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )
    .unwrap();
    assert_eq!(
        created.abandon_unpresented_creation().unwrap().state,
        SessionRetirementReceiptState::RetirementArmed
    );
    fixture.wait_for_retirement(&target).await;
    let discovered = catalog.open(&SessionSelector::new(
        created.receipt().session_id(),
        Some(created.receipt().workspace_id().into()),
    ));
    eprintln!(
        "retired creation discovery: {:?}",
        discovered
            .as_ref()
            .map(|session| session.descriptor().lifecycle)
    );
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    crate::reconcile_checkout_users(
        store.clone(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
        fixture.registration.clone(),
    )
    .await
    .unwrap();
    let after = (fixture.claims(), fixture.removal("remove-uncheckpointed"));
    store.close().await;
    assert_eq!(after, (0, Ok(())));
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn retry_before_result_checkpoint_cannot_restart_an_archived_creation() {
    let fixture = Fixture::new().await;
    let operation = OperationIdV1::new("ordinary-create").unwrap();
    let catalog = LocalSessionCatalog::new(&fixture.discovery);
    let Creation::Pending(prepared) = prepare(&catalog, &operation, fixture.request()).unwrap()
    else {
        panic!("new fixture must prepare its own creation");
    };
    let (reservation, request) = *prepared;
    fixture
        .runtime
        .retain_creation_request(reservation.recovery_id(), &request)
        .await
        .unwrap();
    let created = fixture
        .runtime
        .standalone_creator
        .create(request.clone())
        .unwrap();
    drop(reservation);
    let original = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )
    .unwrap();
    assert_eq!(
        created.abandon_unpresented_creation().unwrap().state,
        SessionRetirementReceiptState::RetirementArmed
    );
    fixture.wait_for_retirement(&original).await;
    let replay = fixture.runtime.standalone_creator.create(request);
    let observation = match replay {
        Ok(restarted) => {
            let target = CompletedStandaloneTarget::from_created(
                restarted.receipt().clone(),
                restarted.session().descriptor(),
            )
            .unwrap();
            let changed = target.generation() != original.generation();
            assert_eq!(
                catalog.retire_completed_standalone_target(
                    target.generation(),
                    target.provider_process(),
                    Duration::from_secs(3)
                ),
                CompletedStandaloneTargetLifecycle::Retired
            );
            (None, changed)
        }
        Err(error) => (Some(error.code().to_string()), false),
    };
    fixture.runtime.store.close().await;
    assert_eq!(
        observation,
        (Some("hmux_standalone_recovery_target_exited".into()), false)
    );
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn removal_reconciliation_preserves_a_creation_that_had_a_real_observer() {
    let fixture = Fixture::new().await;
    let created = fixture.create().await;
    let observer = LocalSessionObserver::connect_resolved(
        created.session().clone(),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    drop(observer);
    assert_eq!(
        created.abandon_unpresented_creation().unwrap().state,
        SessionRetirementReceiptState::SessionPreserved
    );
    fixture.reconcile().await;
    let record = fixture.record().await;
    let after = (
        fixture.claims(),
        fixture.removal("remove-presented"),
        record.admission,
    );
    let descriptor = created.session().descriptor();
    crate::close_standalone_session(
        fixture.runtime.store.clone(),
        LocalSessionCatalog::new(&fixture.discovery),
        descriptor.workspace_id.clone(),
        descriptor.session_id.clone(),
        Some(descriptor.terminal_epoch.clone()),
        Duration::from_secs(3),
    )
    .await
    .unwrap();
    fixture.runtime.store.close().await;
    assert_eq!(
        after,
        (
            1,
            Err("checkout_use_in_use"),
            SessionCheckoutAdmissionV1::Open
        )
    );
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn stale_retirement_observation_preserves_a_replacement_until_its_own_retirement() {
    let fixture = Fixture::new().await;
    let created = fixture.create().await;
    let old_record = fixture.record().await;
    let target = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )
    .unwrap();
    let catalog = LocalSessionCatalog::new(&fixture.discovery);
    assert_eq!(
        catalog.retire_completed_standalone_target(
            target.generation(),
            target.provider_process(),
            Duration::from_secs(3)
        ),
        CompletedStandaloneTargetLifecycle::Retired
    );
    let request = fixture
        .request()
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new("standalone_replacement", "replacement-proof")
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound),
        )
        .unwrap();
    let replacement = fixture
        .runtime
        .create_standalone_replacement(Some(old_record.binding.clone()), request, None)
        .await
        .unwrap();
    let replacement_record = fixture.record().await;
    assert_eq!(
        replacement_record.binding.claim_id,
        old_record.binding.claim_id
    );
    assert_ne!(
        replacement_record.binding.identity,
        old_record.binding.identity
    );
    assert!(replacement_record.close_payload.is_some());
    crate::standalone_close::resume_standalone_checkout_close(
        &fixture.runtime.store,
        &catalog,
        old_record,
    )
    .await
    .unwrap();
    assert_eq!(fixture.record().await, replacement_record);
    assert_eq!(fixture.claims(), 1);
    assert_eq!(
        fixture.removal("remove-replacement"),
        Err("checkout_use_in_use")
    );
    let target = CompletedStandaloneTarget::from_created(
        replacement.receipt().clone(),
        replacement.session().descriptor(),
    )
    .unwrap();
    assert_eq!(
        replacement.abandon_unpresented_creation().unwrap().state,
        SessionRetirementReceiptState::RetirementArmed
    );
    fixture.wait_for_retirement(&target).await;
    fixture.reconcile().await;
    let after = (
        fixture.claims(),
        fixture.removal("remove-retired-replacement"),
    );
    fixture.runtime.store.close().await;
    assert_eq!(after, (0, Ok(())));
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn completed_creation_replay_reopens_without_a_launcher_after_store_reconnect() {
    replay_without_a_launcher(None).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn checkpointed_creation_replay_finishes_cleanup_input_without_a_second_launch() {
    replay_without_a_launcher(Some(CheckpointEncoding::Exact)).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn legacy_checkpoint_replay_preserves_its_receipt_without_a_second_launch() {
    replay_without_a_launcher(Some(CheckpointEncoding::Legacy)).await;
}

enum CheckpointEncoding {
    Exact,
    Legacy,
}

async fn replay_without_a_launcher(checkpoint: Option<CheckpointEncoding>) {
    let fixture = Fixture::new().await;
    let operation = OperationIdV1::new("ordinary-create").unwrap();
    let created = if let Some(encoding) = checkpoint {
        let catalog = LocalSessionCatalog::new(&fixture.discovery);
        let Creation::Pending(prepared) = prepare(&catalog, &operation, fixture.request()).unwrap()
        else {
            panic!("new fixture must have a pending creation");
        };
        let (mut reservation, request) = *prepared;
        fixture
            .runtime
            .retain_creation_request(reservation.recovery_id(), &request)
            .await
            .unwrap();
        let created = fixture.runtime.standalone_creator.create(request).unwrap();
        let target = CompletedStandaloneTarget::from_created(
            created.receipt().clone(),
            created.session().descriptor(),
        )
        .unwrap();
        let serialized = match encoding {
            CheckpointEncoding::Exact => serde_json::to_string(&target),
            CheckpointEncoding::Legacy => serde_json::to_string(target.receipt()),
        }
        .unwrap();
        reservation
            .checkpoint_replacement_receipt(serialized)
            .unwrap();
        // Simulate process loss after the existing journal recorded the actual
        // generation, but before SQL cleanup input or operation completion.
        drop(reservation);
        assert_eq!(fixture.record().await.close_payload, None);
        created
    } else {
        fixture.create().await
    };
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let unavailable_launcher = fixture
        .database
        .parent()
        .unwrap()
        .join("absent-runtime-executable");
    assert!(!unavailable_launcher.exists());
    let runtime = CheckoutSessionRuntime::at_root(
        store.clone(),
        unavailable_launcher,
        fixture.discovery.clone(),
    )
    .unwrap();
    let replayed = runtime
        .create_standalone(operation.clone(), fixture.request())
        .await
        .unwrap();
    assert_eq!(
        replayed.session().descriptor(),
        created.session().descriptor()
    );
    assert_eq!(replayed.receipt(), created.receipt());
    let completed_retry = runtime
        .create_standalone(operation, fixture.request())
        .await
        .unwrap();
    assert_eq!(
        completed_retry.session().descriptor(),
        created.session().descriptor()
    );
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    assert_eq!(claims.len(), 1);
    let record = store
        .session_checkout_registration(&claims[0].claim_id)
        .await
        .unwrap()
        .unwrap();
    assert!(record.close_payload.is_some());
    assert_eq!(record.admission, SessionCheckoutAdmissionV1::Open);
    let descriptor = replayed.session().descriptor();
    crate::close_standalone_session(
        store.clone(),
        LocalSessionCatalog::new(&fixture.discovery),
        descriptor.workspace_id.clone(),
        descriptor.session_id.clone(),
        Some(descriptor.terminal_epoch.clone()),
        Duration::from_secs(3),
    )
    .await
    .unwrap();
    store.close().await;
    assert_eq!(fixture.claims(), 0);
}

struct Fixture {
    runtime: CheckoutSessionRuntime,
    database: PathBuf,
    checkout: PathBuf,
    discovery: PathBuf,
    executable: PathBuf,
    registration: GitCheckoutRegistrationV1,
}

impl Fixture {
    async fn new() -> Self {
        let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
            .canonicalize()
            .unwrap();
        let home = PathBuf::from(std::env::var_os("HOME").unwrap())
            .canonicalize()
            .unwrap();
        assert!(home.starts_with(&guardian) && home != guardian);
        // The outer guardian retains state on failure and retires exact native
        // generations before any root removal; TempDir must not delete a cwd.
        let root = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
        assert!(root.starts_with(&guardian) && root != guardian);
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["commit", "-q", "--allow-empty", "-m", "base"]);
        git(&root, &["worktree", "add", "-q", "-b", "shell", "checkout"]);
        let checkout = root.join("checkout").canonicalize().unwrap();
        let registration = capture_git_checkout_registration(&checkout)
            .unwrap()
            .unwrap();
        let database = root.join("application-state.sqlite3");
        let store = SqliteDomainStore::open(&database).await.unwrap();
        let discovery = root.join("discovery");
        let executable = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
        let runtime =
            CheckoutSessionRuntime::at_root(store, executable.clone(), discovery.clone()).unwrap();
        Self {
            runtime,
            database,
            checkout,
            discovery,
            executable,
            registration,
        }
    }

    fn request(&self) -> StandaloneCreateRequest {
        StandaloneCreateRequest::new(
            &self.checkout,
            Some("checkout-cleanup".into()),
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "while IFS= read -r line; do :; done".into(),
            ],
            24,
            80,
        )
        .unwrap()
    }

    async fn create(&self) -> CreatedStandaloneSession {
        self.runtime
            .create_standalone(
                OperationIdV1::new("ordinary-create").unwrap(),
                self.request(),
            )
            .await
            .unwrap()
    }

    async fn record(&self) -> SessionCheckoutRecordV1 {
        let claims = read_git_checkout_claims(&self.registration).unwrap();
        assert_eq!(claims.len(), 1);
        self.runtime
            .store
            .session_checkout_registration(&claims[0].claim_id)
            .await
            .unwrap()
            .unwrap()
    }

    async fn reconcile(&self) {
        crate::reconcile_checkout_users(
            self.runtime.store.clone(),
            self.executable.clone(),
            self.discovery.clone(),
            self.registration.clone(),
        )
        .await
        .unwrap();
    }

    fn claims(&self) -> usize {
        read_git_checkout_claims(&self.registration).unwrap().len()
    }

    fn removal(&self, operation: &str) -> Result<(), &'static str> {
        GitCheckoutRemovalOperation::new(
            &GitCheckoutRemovalRequestV1 {
                repository_path: self.registration.repository_path.clone(),
                instance: self.registration.instance.clone(),
                policy: GitCheckoutRemovalPolicyV1::RequireClean,
            },
            &OperationIdV1::new(operation).unwrap(),
        )
        .unwrap()
        .admit()
        .and_then(|permit| permit.abort())
        .map_err(|error| error.code)
    }

    async fn wait_for_retirement(&self, target: &CompletedStandaloneTarget) {
        let catalog = LocalSessionCatalog::new(&self.discovery);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let lifecycle = catalog.resolve_completed_standalone_target(
                target.generation(),
                target.provider_process(),
            );
            if lifecycle == CompletedStandaloneTargetLifecycle::Retired {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "target did not retire: {lifecycle:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn git(root: &Path, arguments: &[&str]) {
    // No inherited repository pointers, hooks or signing configuration can
    // route these disposable Git mutations back into the task checkout.
    let output = Command::new("/usr/bin/git")
        .env_clear()
        .current_dir(root)
        .args([
            "-c",
            "user.name=QA",
            "-c",
            "user.email=qa@qa",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(output.status.success(), "Git fixture failed: {output:?}");
}
