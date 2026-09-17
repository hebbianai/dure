use super::*;
mod refresh;
use dure_app::{
    AgentExecutionProfileV1, AgentIdV1, AgentInteractionProfileV1, AgentRecordV1,
    AgentRuntimeSelectionV1, AgentRuntimeTransitionStore, DomainStore, GitCheckoutRegistrationV1,
    GitCheckoutRemovalPolicyV1, GitCheckoutRemovalRequestV1, ProjectIdV1, ProjectRecordV1,
    ProviderIdV1, ProviderPermissionModeV1, SessionCheckoutAdmissionV1, WorkspaceIdV1,
    WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use dure_git_checkout::{
    GitCheckoutRemovalOperation, capture_git_checkout_registration, read_git_checkout_claims,
};
use hmux_client::{ManagedCreateAdvanceResolution, ManagedCreateRequest, PermissionMode};
use std::process::Command;

mod unavailable_git;

#[tokio::test]
async fn recovery_closes_unlaunched_registration_without_resolving_an_executable() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    let fixture = Fixture::new(false).await;
    let registered = fixture
        .register("cancel-before-runtime-selection")
        .await
        .unwrap();
    fixture
        .store
        .begin_agent_registration_close(&registered.binding)
        .await
        .unwrap();
    let resolutions = Arc::new(AtomicUsize::new(0));
    let observed = resolutions.clone();
    let result = crate::reconcile_catalog_checkout_users(
        fixture.store.clone(),
        move || {
            observed.fetch_add(1, Ordering::SeqCst);
            Err(
                std::io::Error::new(std::io::ErrorKind::NotFound, "runtime is not installed")
                    .into(),
            )
        },
        hmux_client::LocalSessionCatalog::new(&fixture.runtime.discovery_root),
        fixture.registration.clone(),
    )
    .await;
    assert!(
        result.is_ok(),
        "unlaunched cancellation does not need an executable: {result:?}"
    );
    assert_eq!(resolutions.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.claims(), 0);
    assert_eq!(fixture.removal("after-runtime-free-recovery"), Ok(()));
    assert!(
        fixture
            .register("cancel-before-runtime-selection")
            .await
            .is_err()
    );
    fixture.store.close().await;
}

#[tokio::test]
async fn reserved_registration_retains_its_claim_when_native_retirement_is_unavailable() {
    use hmux_client::recovery_journal::managed_create_ledger::{
        ManagedCreateLineageAdmission, reserve_request,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    let fixture = Fixture::new(false).await;
    let registered = fixture.register("reserved-before-close").await.unwrap();
    reserve_request(
        &fixture.runtime.discovery_root,
        &fixture.request(&registered.root),
        ManagedCreateLineageAdmission::Root,
    )
    .unwrap();
    let resolutions = Arc::new(AtomicUsize::new(0));
    let observed = resolutions.clone();
    let result = crate::close_agent_registration(
        fixture.store.clone(),
        hmux_client::LocalSessionCatalog::new(&fixture.runtime.discovery_root),
        registered.binding.clone(),
        move || {
            observed.fetch_add(1, Ordering::SeqCst);
            Err(
                std::io::Error::new(std::io::ErrorKind::NotFound, "runtime is not installed")
                    .into(),
            )
        },
    )
    .await;
    assert!(
        matches!(result, Err(SessionCheckoutError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound)
    );
    assert_eq!(resolutions.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.claims(), 1);
    assert_eq!(
        fixture
            .store
            .session_checkout(&registered.binding.identity)
            .await
            .unwrap()
            .unwrap()
            .admission,
        SessionCheckoutAdmissionV1::Closing
    );
    assert!(fixture.register("reserved-before-close").await.is_err());
    fixture.store.close().await;
}

#[tokio::test]
async fn registered_agent_blocks_removal_before_any_runtime_exists() {
    let fixture = Fixture::new(false).await;
    let binding = fixture.register("registration-one").await.unwrap();
    assert_eq!(fixture.claims(), 1);
    assert_eq!(
        fixture.removal("remove-registered"),
        Err("checkout_use_in_use")
    );
    assert_eq!(fixture.register("registration-one").await.unwrap(), binding);
    assert_eq!(fixture.claims(), 1);
    assert!(fixture.register("registration-newcomer").await.is_err());
    assert_eq!(fixture.claims(), 1);
    fixture.store.close().await;
}

#[tokio::test]
async fn prior_removal_permit_refuses_registration_before_acknowledgement() {
    let fixture = Fixture::new(false).await;
    let permit = fixture.removal_operation("prior-removal").admit().unwrap();
    let result = fixture.register("registration-one").await;
    assert!(
        matches!(result, Err(SessionCheckoutError::Checkout(error)) if error.code == "checkout_use_phase_conflict")
    );
    assert_eq!(fixture.claims(), 0);
    permit.abort().unwrap();
    let recovered = fixture.register("registration-one").await.unwrap();
    assert_eq!(fixture.claims(), 1);
    assert_eq!(
        fixture
            .store
            .agent_runtime_checkout(&agent_id())
            .await
            .unwrap()
            .unwrap()
            .binding,
        recovered.binding
    );
    fixture.store.close().await;
}

#[tokio::test]
async fn changed_registration_root_and_foreign_cancellation_preserve_the_owner() {
    let fixture = Fixture::new(false).await;
    let binding = fixture.register("registration-one").await.unwrap();
    let mut foreign = binding.binding.clone();
    foreign.identity.owner = SessionCheckoutOwnerV1::Agent {
        agent_id: agent_id(),
        registration_id: operation("different-incarnation"),
    };
    foreign.claim_id = foreign.identity.owner_id();
    assert!(
        fixture
            .runtime
            .close_agent_registration(foreign)
            .await
            .is_err()
    );
    assert!(
        fixture
            .runtime
            .register_agent_checkout(
                operation("registration-one"),
                AgentBootstrapV1 {
                    runtime_workspace_id: WorkspaceIdV1::new("another-workspace").unwrap(),
                    ..fixture.agent(agent_id())
                },
            )
            .await
            .is_err()
    );
    assert_eq!(fixture.claims(), 1);
    let retained = fixture
        .store
        .agent_runtime_checkout(&agent_id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained.binding, binding.binding);
    assert_eq!(retained.admission, SessionCheckoutAdmissionV1::Open);
    fixture.store.close().await;
}

#[tokio::test]
async fn registration_bootstraps_an_unregistered_agent_without_a_runtime_selection() {
    let fixture = Fixture::new(false).await;
    let missing = AgentIdV1::new("missing-agent").unwrap();
    let result = fixture
        .runtime
        .register_agent_checkout(
            operation("registration-one"),
            fixture.agent(missing.clone()),
        )
        .await;
    assert!(
        result.is_ok(),
        "registration must bootstrap missing metadata: {result:?}"
    );
    assert_eq!(fixture.claims(), 1);
    assert!(
        fixture
            .store
            .agent_runtime_selection(&missing)
            .await
            .unwrap()
            .is_none()
    );
    let registered = fixture.store.agent(&missing).await.unwrap().unwrap();
    assert_eq!(
        registered.provider_id,
        ProviderIdV1::new("local-shell").unwrap()
    );
    let workspace = fixture
        .store
        .workspace(&registered.workspace_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(workspace.root_path, fixture.checkout.to_str().unwrap());
    assert!(
        fixture
            .store
            .project(&workspace.project_id)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        fixture
            .store
            .agent_runtime_checkout(&missing)
            .await
            .unwrap()
            .unwrap()
            .binding,
        result.unwrap().binding
    );
    fixture.store.close().await;
}

#[tokio::test]
async fn distinct_agents_with_the_same_retry_key_receive_distinct_native_roots() {
    let fixture = Fixture::new(false).await;
    let first = fixture.register("same-retry-key").await.unwrap();
    let mut second_agent = fixture.store.agent(&agent_id()).await.unwrap().unwrap();
    second_agent.agent_id = AgentIdV1::new("second-agent").unwrap();
    fixture.store.upsert_agent(&second_agent).await.unwrap();
    let second = fixture
        .runtime
        .register_agent_checkout(
            operation("same-retry-key"),
            fixture.agent(second_agent.agent_id),
        )
        .await
        .unwrap();
    let first_record = fixture
        .store
        .session_checkout(&first.binding.identity)
        .await
        .unwrap()
        .unwrap();
    let second_record = fixture
        .store
        .session_checkout(&second.binding.identity)
        .await
        .unwrap()
        .unwrap();
    fixture.store.close().await;
    assert_ne!(first.binding.claim_id, second.binding.claim_id);
    assert_ne!(first.root, second.root);
    assert_ne!(
        first_record.close_payload, second_record.close_payload,
        "independent Agent registrations must not share a root whose cancellation stops both"
    );
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn cancelling_an_unlaunched_registration_closes_launch_admission_and_releases_its_claim() {
    let fixture = Fixture::new(true).await;
    let binding = fixture.register("registration-one").await.unwrap();
    fixture
        .runtime
        .close_agent_registration(binding.binding.clone())
        .await
        .unwrap();
    assert_eq!(fixture.claims(), 0);
    assert_eq!(fixture.removal("after-cancel"), Ok(()));
    assert!(fixture.register("registration-one").await.is_err());
    assert!(
        fixture
            .runtime
            .advance(fixture.request(&binding.root))
            .await
            .is_err(),
        "generic product launch must not bypass a cancelled Agent registration"
    );
    fixture
        .runtime
        .close_agent_registration(binding.binding)
        .await
        .unwrap();
    assert_eq!(fixture.claims(), 0);
    fixture.store.close().await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn registered_native_launch_reuses_the_agent_claim_until_explicit_close() {
    let fixture = Fixture::new(true).await;
    let binding = fixture.register("registration-one").await.unwrap();
    let outcome = fixture
        .runtime
        .advance(fixture.request(&binding.root))
        .await;
    let claims_after_launch = fixture.claims();
    let association = fixture
        .store
        .agent_runtime_checkout(&agent_id())
        .await
        .unwrap()
        .unwrap();
    // Even a failed assertion below cannot strand this fixture's provider.
    let executable = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
    crate::close_agent_registration(
        fixture.store.clone(),
        hmux_client::LocalSessionCatalog::new(&fixture.runtime.discovery_root),
        binding.binding.clone(),
        move || Ok(executable),
    )
    .await
    .unwrap();
    assert!(matches!(
        outcome.unwrap(),
        ManagedCreateAdvanceResolution::Current(_)
    ));
    assert_eq!(
        claims_after_launch, 1,
        "launch must not create a second Managed claim"
    );
    assert_eq!(association.binding, binding.binding);
    assert_eq!(fixture.claims(), 0);
    assert_eq!(fixture.removal("after-native-close"), Ok(()));
    fixture.store.close().await;
}

#[tokio::test]
async fn registered_async_launch_port_observes_one_agent_claim_without_a_client_hint() {
    let fixture = Fixture::new(false).await;
    let registered = fixture.register("registration-one").await.unwrap();
    let registration = fixture.registration.clone();
    let observed: Result<usize, SessionCheckoutError> = fixture
        .runtime
        .advance_using(fixture.request(&registered.root), move || async move {
            Ok(read_git_checkout_claims(&registration)?.len())
        })
        .await;
    fixture.store.close().await;
    assert_eq!(
        observed.unwrap(),
        1,
        "the production async launch port must reuse registration ownership"
    );
}

#[tokio::test]
async fn registered_cancellation_closes_the_generic_async_launch_port_before_runtime_cleanup() {
    let fixture = Fixture::new(false).await;
    let registered = fixture.register("registration-one").await.unwrap();
    fixture
        .store
        .begin_agent_registration_close(&registered.binding)
        .await
        .unwrap();
    let launched = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observation = launched.clone();
    let outcome: Result<(), SessionCheckoutError> = fixture
        .runtime
        .advance_using(fixture.request(&registered.root), move || async move {
            observation.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .await;
    fixture.store.close().await;
    assert!(
        outcome.is_err(),
        "Closing must refuse a generic launch: {outcome:?}"
    );
    assert!(!launched.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(
        fixture.claims(),
        1,
        "runtime cleanup still owns the retained claim"
    );
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn registered_direct_create_and_async_launch_share_the_same_lifetime() {
    for use_async_port in [false, true] {
        let fixture = Fixture::new(true).await;
        let registered = fixture.register("registration-one").await.unwrap();
        let request = fixture.request(&registered.root);
        let outcome = if use_async_port {
            let creator = fixture.runtime.creator.clone();
            let launch = request.clone();
            fixture
                .runtime
                .advance_using(request, move || async move {
                    tokio::task::spawn_blocking(move || creator.create(launch))
                        .await?
                        .map_err(SessionCheckoutError::from)
                })
                .await
        } else {
            fixture.runtime.create(request).await
        };
        let claims = fixture.claims();
        // Native Stop closes the root, not the durable Agent registration.
        let stopped = fixture.runtime.close(registered.root.clone()).await;
        let retained_after_stop = fixture.claims();
        fixture
            .runtime
            .close_agent_registration(registered.binding)
            .await
            .unwrap();
        fixture.store.close().await;
        assert!(outcome.is_ok(), "registered launch: {outcome:?}");
        assert!(stopped.is_ok(), "native stop: {stopped:?}");
        assert_eq!(claims, 1, "create must reuse the Agent's existing claim");
        assert_eq!(
            retained_after_stop, 1,
            "Stop must retain the Agent resource"
        );
        assert_eq!(fixture.claims(), 0);
    }
}

#[tokio::test]
async fn registered_lookup_does_not_adopt_another_origin_or_an_ordinary_claim() {
    let fixture = Fixture::new(false).await;
    let registered = fixture.register("registration-one").await.unwrap();
    let origin = managed_identity(
        &fixture.runtime.namespace,
        registered.root.idempotency_key(),
        registered.root.session_id(),
        registered.root.workspace_id(),
    );
    assert_eq!(
        fixture
            .runtime
            .registered_agent_checkout(&origin)
            .await
            .unwrap(),
        Some(registered.binding)
    );
    let mut other_namespace = origin.clone();
    other_namespace.runtime_namespace.push_str("-other");
    assert!(
        fixture
            .runtime
            .registered_agent_checkout(&other_namespace)
            .await
            .unwrap()
            .is_none()
    );
    let ordinary = ManagedCreateReconcileRequest::new("ordinary", "ordinary", "workspace").unwrap();
    let request = fixture.request(&ordinary);
    let registration = fixture.registration.clone();
    let ordinary_claims: Result<usize, SessionCheckoutError> = fixture
        .runtime
        .advance_using(request, move || async move {
            Ok(read_git_checkout_claims(&registration)?.len())
        })
        .await;
    assert_eq!(
        ordinary_claims.unwrap(),
        2,
        "independent sessions keep their own claim"
    );
    fixture.store.close().await;
}

#[tokio::test]
async fn cancellation_and_initial_selection_share_one_admission_order() {
    for selection_first in [false, true] {
        let fixture = Fixture::new(false).await;
        let registered = fixture.register("registration-one").await.unwrap();
        let selection = AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id(),
            provider_id: ProviderIdV1::new("local-shell").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 1,
        };
        if selection_first {
            fixture
                .store
                .initialize_agent_runtime_selection(&selection)
                .await
                .unwrap();
            assert!(
                fixture
                    .store
                    .begin_agent_registration_close(&registered.binding)
                    .await
                    .is_err()
            );
        } else {
            fixture
                .store
                .begin_agent_registration_close(&registered.binding)
                .await
                .unwrap();
            assert!(
                fixture
                    .store
                    .initialize_agent_runtime_selection(&selection)
                    .await
                    .is_err()
            );
            assert!(
                fixture
                    .store
                    .agent_runtime_selection(&agent_id())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(
            fixture.claims(),
            1,
            "neither admission branch alone authorizes Git cleanup"
        );
        fixture.store.close().await;
    }
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn a_new_incarnation_survives_the_previous_registrations_cancel_retry() {
    let fixture = Fixture::new(true).await;
    let first = fixture.register("registration-one").await.unwrap();
    fixture
        .runtime
        .close_agent_registration(first.binding.clone())
        .await
        .unwrap();
    let second = fixture.register("registration-two").await.unwrap();
    let late_cancel = fixture
        .runtime
        .close_agent_registration(first.binding.clone())
        .await;
    let retained = fixture
        .store
        .agent_runtime_checkout(&agent_id())
        .await
        .unwrap()
        .unwrap();
    let after_late_cancel = fixture.claims();
    fixture
        .runtime
        .close_agent_registration(second.binding.clone())
        .await
        .unwrap();
    assert!(late_cancel.is_err());
    assert_eq!(after_late_cancel, 1);
    assert_eq!(retained.binding, second.binding);
    assert_ne!(first.root, second.root);
    assert_ne!(first.binding.claim_id, second.binding.claim_id);
    assert_eq!(fixture.claims(), 0);
    fixture.store.close().await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn reopening_resumes_an_admitted_prelaunch_cancel_without_a_runtime_selection() {
    let fixture = Fixture::new(true).await;
    let registered = fixture.register("registration-one").await.unwrap();
    fixture
        .store
        .begin_agent_registration_close(&registered.binding)
        .await
        .unwrap();
    // Crash after durable cancellation, before root retirement or Git release.
    fixture.store.close().await;
    let store = SqliteDomainStore::open(fixture.checkout.parent().unwrap().join("state.sqlite3"))
        .await
        .unwrap();
    let executable = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
    crate::reconcile_checkout_users(
        store.clone(),
        executable,
        fixture.runtime.discovery_root.clone(),
        fixture.registration.clone(),
    )
    .await
    .unwrap();
    let record = store
        .agent_runtime_checkout(&agent_id())
        .await
        .unwrap()
        .unwrap();
    let claims = fixture.claims();
    store.close().await;
    assert_eq!(
        claims, 0,
        "an admitted prelaunch cancellation must not leak its claim after reopen"
    );
    assert_eq!(record.admission, SessionCheckoutAdmissionV1::Closed);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn repeated_refresh_retains_one_agent_checkout_until_cancellation() {
    use hmux_client::ManagedCreateAdvanceResolution;
    let fixture = Fixture::new(true).await;
    let registered = fixture.register("refresh-registration").await.unwrap();
    fixture
        .runtime
        .advance(fixture.request(&registered.root))
        .await
        .unwrap();
    let mut root = registered.root.clone();
    let mut claims = Vec::new();
    let mut roots = Vec::new();
    for _ in 0..2 {
        let started = std::time::Instant::now();
        let result = fixture
            .runtime
            .replace_current_and_advance(fixture.request(&root))
            .await
            .unwrap();
        eprintln!("registered Refresh: {:?}", started.elapsed());
        let created = match result {
            ManagedCreateAdvanceResolution::Current(created)
            | ManagedCreateAdvanceResolution::Advanced(created) => created,
            other => panic!("Refresh did not become ready: {other:?}"),
        };
        let receipt = created.receipt();
        root = ManagedCreateReconcileRequest::new(
            receipt.idempotency_key(),
            receipt.session_id(),
            receipt.workspace_id(),
        )
        .unwrap();
        roots.push(root.clone());
        claims.push(fixture.claims());
    }
    // Cleanup before assertions also makes the RED run retire every fixture Host.
    for root in roots {
        fixture.runtime.close(root).await.unwrap();
    }
    let retained_after_stop = fixture.claims();
    fixture
        .runtime
        .close_agent_registration(registered.binding)
        .await
        .unwrap();
    let released = fixture.claims();
    fixture.store.close().await;
    assert_eq!(
        claims,
        vec![1, 1],
        "Refresh must not acquire independent Git claims"
    );
    assert_eq!(retained_after_stop, 1, "runtime Stop is not Agent removal");
    assert_eq!(released, 0);
}

struct Fixture {
    _temporary: tempfile::TempDir,
    checkout: PathBuf,
    registration: GitCheckoutRegistrationV1,
    store: SqliteDomainStore,
    runtime: CheckoutSessionRuntime,
}

impl Fixture {
    async fn new(native: bool) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        let repository = directory.join("repository");
        std::fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-q"]);
        git(
            &repository,
            &[
                "-c",
                "user.name=Registration fixture",
                "-c",
                "user.email=registration@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "fixture",
            ],
        );
        let checkout = directory.join("checkout");
        git(
            &repository,
            &[
                "worktree",
                "add",
                "--detach",
                checkout.to_str().unwrap(),
                "HEAD",
            ],
        );
        let registration = capture_git_checkout_registration(&checkout)
            .unwrap()
            .unwrap();
        let store = SqliteDomainStore::open(directory.join("state.sqlite3"))
            .await
            .unwrap();
        let project_id = ProjectIdV1::new("project").unwrap();
        let workspace_id = WorkspaceIdV1::new("workspace").unwrap();
        store
            .upsert_project(&ProjectRecordV1 {
                project_id: project_id.clone(),
                root_path: repository.to_str().unwrap().into(),
                display_name: "Fixture".into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: workspace_id.clone(),
                project_id,
                root_path: checkout.to_str().unwrap().into(),
                base_commit_sha: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store
            .upsert_agent(&AgentRecordV1 {
                agent_id: agent_id(),
                workspace_id,
                provider_id: ProviderIdV1::new("local-shell").unwrap(),
                display_name: "Agent".into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        let executable = if native {
            PathBuf::from(
                std::env::var_os("DURE_QA_HMUX_RUNTIME").expect("isolated native runtime required"),
            )
        } else {
            directory.join("unused-runtime")
        };
        let runtime =
            CheckoutSessionRuntime::at_root(store.clone(), executable, directory.join("discovery"))
                .unwrap();
        Self {
            _temporary: temporary,
            checkout,
            registration,
            store,
            runtime,
        }
    }

    async fn register(
        &self,
        incarnation: &str,
    ) -> Result<AgentCheckoutRegistrationV1, SessionCheckoutError> {
        crate::register_agent_checkout(
            self.store.clone(),
            hmux_client::LocalSessionCatalog::new(&self.runtime.discovery_root),
            operation(incarnation),
            self.agent(agent_id()),
        )
        .await
    }

    fn agent(&self, agent_id: AgentIdV1) -> AgentBootstrapV1 {
        AgentBootstrapV1 {
            agent_id,
            runtime_workspace_id: workspace_id(),
            provider_id: ProviderIdV1::new("local-shell").unwrap(),
            working_directory: self.checkout.to_str().unwrap().into(),
            display_name: "Agent".into(),
        }
    }

    fn request(&self, root: &ManagedCreateReconcileRequest) -> ManagedCreateRequest {
        ManagedCreateRequest::new(
            root.idempotency_key(),
            root.session_id(),
            root.workspace_id(),
            "local-shell",
            PermissionMode::Default,
            &self.checkout,
            vec!["/bin/sh".into(), "-c".into(), "exec sleep 120".into()],
            24,
            80,
        )
        .unwrap()
    }

    fn claims(&self) -> usize {
        read_git_checkout_claims(&self.registration).unwrap().len()
    }

    fn removal_operation(&self, name: &str) -> GitCheckoutRemovalOperation {
        GitCheckoutRemovalOperation::new(
            &GitCheckoutRemovalRequestV1 {
                repository_path: self.registration.repository_path.clone(),
                instance: self.registration.instance.clone(),
                policy: GitCheckoutRemovalPolicyV1::RequireClean,
            },
            &operation(name),
        )
        .unwrap()
    }

    fn removal(&self, name: &str) -> Result<(), &'static str> {
        let permit = self
            .removal_operation(name)
            .admit()
            .map_err(|error| error.code)?;
        permit.abort().unwrap();
        Ok(())
    }
}

fn agent_id() -> AgentIdV1 {
    AgentIdV1::new("agent").unwrap()
}
fn operation(id: &str) -> OperationIdV1 {
    OperationIdV1::new(id).unwrap()
}
fn workspace_id() -> WorkspaceIdV1 {
    WorkspaceIdV1::new("workspace").unwrap()
}

fn git(cwd: &Path, arguments: &[&str]) {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(arguments);
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            command.env_remove(name);
        }
    }
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "Git fixture failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}
