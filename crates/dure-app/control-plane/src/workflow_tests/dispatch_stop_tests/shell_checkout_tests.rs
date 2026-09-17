use super::*;
use dure_app::{SessionCheckoutAdmissionV1, SessionCheckoutIdentityV1};
use hmux_client::{
    LocalProcessGenerationStatus, ManagedCreateAdvanceResolution, ManagedCreateReconcileRequest,
    ManagedCreateRequest, ManagedSessionCreator, PermissionMode, SessionDescriptor,
    probe_local_process_generation,
};
use std::future::{Future, poll_fn};
use std::task::Poll;

mod close_admission;
mod process_fixture;
mod transfer_recovery;

#[tokio::test]
async fn agent_only_checkout_removal_does_not_require_session_runtime_discovery() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed =
        seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
    let stops = install_runtime(&mut state, seed.provider_id.clone(), None);
    // Only this disposable Agent owns the checkout. Hmux discovery is not a
    // prerequisite for stopping a structured provider and removing its files.
    let unavailable = root.path().join("unavailable-shell-discovery");
    fs::write(&unavailable, "not a runtime directory").unwrap();
    state.hmux_identity.discovery_root = unavailable;
    let preview = preview_stop(&state, "agent-only-remove", &seed.spawn_operation_id)
        .await
        .unwrap();
    let outcome = call_dispatch_stop(
        &state,
        "agent-only-remove-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await;
    assert!(matches!(outcome, Ok(value) if value["receipt"]["state"]["status"] == "succeeded"));
    assert!(!seed.checkout.exists());
    assert_eq!(stops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_managed_shell_blocks_agent_checkout_removal_real_hmux() {
    shell_lifetime_blocks_removal_until_close(ShellObservation::Attached).await;
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_managed_shell_successor_close_releases_its_original_checkout_real_hmux() {
    shell_lifetime_blocks_removal_until_close(ShellObservation::Advanced).await;
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_managed_shell_detached_success_keeps_its_checkout_until_close_real_hmux() {
    shell_lifetime_blocks_removal_until_close(ShellObservation::DetachedCreate).await;
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_managed_shell_detached_close_finishes_its_admitted_cleanup_real_hmux() {
    shell_lifetime_blocks_removal_until_close(ShellObservation::DetachedClose).await;
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_project_root_launches_shell_without_git_format_real_hmux() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let repository = crate::workspace_git::tests::repository().await;
    let project_root = repository.path().canonicalize().unwrap();
    for (key, value) in [
        ("core.repositoryformatversion", "1"),
        ("extensions.dureUnsupportedRegistrationFixture", "true"),
    ] {
        run_git(&project_root, &["config", key, value]);
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&project_root)
        .args(["rev-parse", "--show-toplevel"])
        .env_clear()
        .envs(std::env::vars_os().filter(|(key, _)| !key.to_string_lossy().starts_with("GIT_")))
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "the fixture Git must reject this format"
    );
    let config = fs::read(project_root.join(".git/config")).unwrap();
    let hmux = real_hmux::RealHmux::install(root, &mut state);
    let runtime = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
    let lifecycle = dure_session_runtime::CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        runtime,
        hmux.discovery.clone(),
    )
    .unwrap();
    let request = ManagedCreateRequest::new(
        "primary-directory-shell",
        "primary-directory-shell",
        "local-shell-workspace",
        "local-shell",
        PermissionMode::Default,
        project_root.clone(),
        vec!["/bin/cat".into()],
        24,
        80,
    )
    .unwrap();
    let created = lifecycle.create(request.clone()).await.unwrap();
    let descriptor = created.session().descriptor().clone();
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
    );
    let identity = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let binding = state
        .store
        .session_checkout(&shell_checkout_identity(&hmux.discovery, &identity))
        .await
        .unwrap()
        .unwrap()
        .binding;
    assert!(binding.registration.is_none());
    lifecycle.close(identity).await.unwrap();
    drop(created);
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent,
    );
    assert_eq!(fs::read(project_root.join(".git/config")).unwrap(), config);
}

enum ShellObservation {
    Attached,
    Advanced,
    AdvancedRejectedClose,
    DetachedCreate,
    DetachedClose,
}

fn shell_generation(descriptor: &SessionDescriptor) -> WorkflowSessionGenerationV1 {
    WorkflowSessionGenerationV1 {
        session_id: descriptor.session_id.clone(),
        workspace_id: descriptor.workspace_id.clone(),
        provider_id: ProviderIdV1::new("local-shell").unwrap(),
        runner_principal: descriptor.runner_principal.clone(),
        runner_instance: descriptor.runner_instance.clone(),
        channel_epoch: descriptor.channel_epoch.clone(),
        host_instance_id: descriptor.host_instance_id.clone(),
        terminal_epoch: descriptor.terminal_epoch.clone(),
    }
}

async fn shell_lifetime_blocks_removal_until_close(observation: ShellObservation) {
    let advanced = matches!(
        observation,
        ShellObservation::Advanced | ShellObservation::AdvancedRejectedClose
    );
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed =
        seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
    let hmux = real_hmux::RealHmux::install(root, &mut state);
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let runtime = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());

    // Use the desktop shell's product lifecycle, not an Agent spawn or a
    // manually injected checkout claim. The original RED used direct create.
    let request = ManagedCreateRequest::new(
        "ordinary-shell-create",
        "ordinary-shell",
        "local-shell-workspace",
        "local-shell",
        PermissionMode::Default,
        seed.checkout.canonicalize().unwrap(),
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "while IFS= read -r line; do :; done".into(),
        ],
        24,
        80,
    )
    .unwrap();
    let lifecycle = dure_session_runtime::CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        runtime.clone(),
        hmux.discovery.clone(),
    )
    .unwrap();
    let mut created = if matches!(observation, ShellObservation::DetachedCreate) {
        use hmux_client::recovery_journal::managed_create_ledger::ManagedCreateReconcileLedgerState;

        // Poll the real operation once, then lose its response channel before
        // a Host can complete. The accepted create still owns its lifecycle.
        let mut caller = Box::pin(lifecycle.create(request.clone()));
        poll_fn(|context| {
            assert!(caller.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(caller);
        let identity = ManagedCreateReconcileRequest::new(
            request.idempotency_key(),
            request.session_id(),
            request.workspace_id(),
        )
        .unwrap();
        wait_for_shell_ledger(&hmux.discovery, &identity, |state| {
            matches!(state, ManagedCreateReconcileLedgerState::Completed(_))
        })
        .await;
        let hmux_client::ManagedCreateIdentityResolution::Existing(created) =
            ManagedSessionCreator::new(&runtime)
                .with_discovery_root(&hmux.discovery)
                .reconcile_identity(identity)
                .unwrap()
        else {
            panic!("losing a response cannot stop or abandon a successful create");
        };
        *created
    } else {
        lifecycle.create(request.clone()).await.unwrap()
    };
    if advanced {
        hmux.stop(&shell_generation(created.session().descriptor()));
        drop(created);
        let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&hmux.discovery);
        let advanced = creator
            .create_or_reconcile_and_advance(request.clone())
            .unwrap();
        let ManagedCreateAdvanceResolution::Advanced(successor) = advanced else {
            panic!("the retired shell must advance through the runtime's actual lineage");
        };
        created = successor;
        // A failed stale-root caller owns neither the recovered successor nor
        // its original checkout claim. Error compensation must preserve both.
        assert!(lifecycle.create(request.clone()).await.is_err());
    }
    let close_identity = ManagedCreateReconcileRequest::new(
        created.receipt().idempotency_key(),
        created.receipt().session_id(),
        created.receipt().workspace_id(),
    )
    .unwrap();
    let descriptor = created.session().descriptor().clone();
    let shell = shell_generation(&descriptor);
    drop(created);
    let rejected_close = if matches!(observation, ShellObservation::AdvancedRejectedClose) {
        Some(
            close_admission::reject_stop_and_observe_origin(
                &state,
                &hmux,
                &request,
                &close_identity,
            )
            .await,
        )
    } else {
        None
    };
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
    );

    let preview = preview_stop(
        &state,
        "remove-with-ordinary-shell",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();
    let outcome = call_dispatch_stop(
        &state,
        "remove-with-ordinary-shell-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .map(|value| value["receipt"]["state"]["status"].clone())
    .map_err(|error| error.code);
    let provider_stops = stop_count.load(Ordering::SeqCst);
    let checkout_retained = seed.checkout.is_dir();
    let shell_generation = probe_local_process_generation(&descriptor.provider_process);
    // Retire the exact disposable runtime even when the required behavior is
    // missing. The outer guardian retains panic/unknown-outcome cleanup.
    hmux.stop(&shell);

    assert_eq!(
        shell_generation.unwrap(),
        LocalProcessGenerationStatus::Live
    );
    assert_eq!(
        (provider_stops, checkout_retained, outcome),
        (0, true, Err("checkout_use_in_use".into())),
        "a live ordinary shell must block removal before the Agent provider is stopped",
    );
    // Exact generation stop above is not product lifetime close. Retire the
    // root before releasing this shell's resource, then removal may proceed.
    if matches!(observation, ShellObservation::DetachedClose) {
        let binding = shell_checkout_identity(&hmux.discovery, &close_identity);
        let mut caller = Box::pin(lifecycle.close(close_identity.clone()));
        // Drive the actual close until its intent is durable. Polling the
        // response future manually makes loss at that boundary reproducible.
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                poll_fn(|context| {
                    assert!(caller.as_mut().poll(context).is_pending());
                    Poll::Ready(())
                })
                .await;
                if state
                    .store
                    .session_checkout(&binding)
                    .await
                    .unwrap()
                    .is_some_and(|record| record.admission != SessionCheckoutAdmissionV1::Open)
                {
                    return;
                }
            }
        })
        .await
        .expect("the close intent must be admitted before losing its caller");
        drop(caller);
        let cleaned = wait_for_shell_checkout_close(&state.store, &binding).await;
        eprintln!("close caller detached after admission; durable cleanup completed: {cleaned}");
    } else {
        let closed = lifecycle.close(close_identity.clone()).await.unwrap();
        assert_eq!(closed.chain().len(), if advanced { 2 } else { 1 });
    }
    // Retry the already-authorized removal, rather than creating a competing
    // close generation for the same Agent.
    let outcome = call_dispatch_stop(
        &state,
        "remove-after-shell-close-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .map(|value| value["receipt"]["state"]["status"].clone())
    .map_err(|error| error.code);
    let observed = (
        outcome,
        seed.checkout.exists(),
        stop_count.load(Ordering::SeqCst),
    );
    if matches!(observation, ShellObservation::DetachedClose) {
        // Reclaim the exact fixture on RED too, only after observing whether
        // the original operation finished without a caller or an explicit retry.
        lifecycle.close(close_identity).await.unwrap();
    }
    assert_eq!(observed, (Ok(serde_json::json!("succeeded")), false, 1));
    assert!(matches!(
        lifecycle.create(request).await,
        Err(dure_session_runtime::SessionCheckoutError::Closing)
    ));
    if let Some(admission) = rejected_close {
        assert_eq!(
            admission,
            SessionCheckoutAdmissionV1::Closing,
            "a failed successor stop must already exclude transfer of the origin's checkout claim"
        );
    }
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_managed_shell_cannot_start_after_checkout_removal_admission_real_hmux() {
    use dure_git_checkout::{
        GIT_CHECKOUT_USE_SCHEMA_VERSION_V1, GitCheckoutRemovalPolicyV1, GitCheckoutUseActionV1,
        GitCheckoutUseRequestV1, apply_git_checkout_use, capture_git_checkout_registration,
    };
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed =
        seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
    let marker = root.path().join("shell-started");
    let registration = capture_git_checkout_registration(&seed.checkout)
        .unwrap()
        .unwrap();
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: registration.repository_path,
        operation_id: OperationIdV1::new("remove-before-shell").unwrap(),
        action: GitCheckoutUseActionV1::AcquireRemovalPermit {
            instance: registration.instance,
            retiring_claim_ids: vec![seed.spawn_operation_id.clone()],
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
    })
    .unwrap();
    let hmux = real_hmux::RealHmux::install(root, &mut state);
    let runtime = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
    let lifecycle = dure_session_runtime::CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        runtime,
        hmux.discovery.clone(),
    )
    .unwrap();
    let request = ManagedCreateRequest::new(
        "fenced-shell-create",
        "fenced-shell",
        "local-shell-workspace",
        "local-shell",
        PermissionMode::Default,
        &seed.checkout,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf started > \"$1\"; exec /bin/cat".into(),
            "shell-fixture".into(),
            marker.to_str().unwrap().into(),
        ],
        24,
        80,
    )
    .unwrap();
    let outcome = lifecycle.create(request).await;
    // The identity-only close also retires an unlaunched reservation. Always
    // clean the disposable runtime before asserting the intended refusal.
    lifecycle
        .close(
            ManagedCreateReconcileRequest::new(
                "fenced-shell-create",
                "fenced-shell",
                "local-shell-workspace",
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        matches!(outcome, Err(dure_session_runtime::SessionCheckoutError::Checkout(error))
        if error.code == "checkout_use_phase_conflict")
    );
    assert!(
        !marker.exists(),
        "a prior removal permit must prevent provider launch"
    );
    assert!(seed.checkout.is_dir());
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_managed_shell_rejected_launch_does_not_strand_checkout_use_real_hmux() {
    failed_shell_launch_does_not_strand_checkout_use(FailedLaunchObservation::Awaited).await;
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_managed_shell_detached_caller_does_not_strand_checkout_use_real_hmux() {
    failed_shell_launch_does_not_strand_checkout_use(FailedLaunchObservation::Detached).await;
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_managed_shell_retry_recovers_interrupted_cleanup_real_hmux() {
    failed_shell_launch_does_not_strand_checkout_use(FailedLaunchObservation::CleanupInterrupted)
        .await;
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_managed_shell_retry_after_creator_process_loss_real_hmux() {
    failed_shell_launch_does_not_strand_checkout_use(FailedLaunchObservation::ProcessLost {
        retry_original: true,
    })
    .await;
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn ordinary_managed_shell_abandoned_creator_does_not_require_lost_request_real_hmux() {
    failed_shell_launch_does_not_strand_checkout_use(FailedLaunchObservation::ProcessLost {
        retry_original: false,
    })
    .await;
}

enum FailedLaunchObservation {
    Awaited,
    Detached,
    CleanupInterrupted,
    ProcessLost { retry_original: bool },
}

async fn wait_for_shell_ledger(
    root: &Path,
    identity: &ManagedCreateReconcileRequest,
    expected: impl Fn(
        &hmux_client::recovery_journal::managed_create_ledger::ManagedCreateReconcileLedgerState,
    ) -> bool,
) {
    use hmux_client::recovery_journal::managed_create_ledger;
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            if expected(&managed_create_ledger::reconcile_identity(root, identity).unwrap()) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the real runtime must reach the selected create checkpoint");
}

fn shell_checkout_identity(
    discovery: &Path,
    identity: &ManagedCreateReconcileRequest,
) -> SessionCheckoutIdentityV1 {
    SessionCheckoutIdentityV1 {
        runtime_namespace: discovery.canonicalize().unwrap().to_str().unwrap().into(),
        owner: dure_app::SessionCheckoutOwnerV1::Managed {
            workspace_id: identity.workspace_id().into(),
            session_id: identity.session_id().into(),
            idempotency_key: identity.idempotency_key().into(),
        },
    }
}

async fn wait_for_shell_checkout_close(
    store: &dure_app_sqlite::SqliteDomainStore,
    identity: &SessionCheckoutIdentityV1,
) -> bool {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if store
                .session_checkout(identity)
                .await
                .unwrap()
                .is_some_and(|record| record.admission == SessionCheckoutAdmissionV1::Closed)
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .is_ok()
}

async fn reopen_shell_lifecycle(
    root: &Path,
    runtime: &Path,
    discovery: &Path,
) -> dure_session_runtime::CheckoutSessionRuntime {
    let reopened = dure_app_sqlite::SqliteDomainStore::open(root.join("domain.sqlite"))
        .await
        .unwrap();
    dure_session_runtime::CheckoutSessionRuntime::at_root(
        reopened,
        runtime.into(),
        discovery.into(),
    )
    .unwrap()
}

async fn failed_shell_launch_does_not_strand_checkout_use(observation: FailedLaunchObservation) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed =
        seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
    let missing_program = root.path().join("missing-shell");
    assert!(!missing_program.exists());
    let hmux = real_hmux::RealHmux::install(root, &mut state);
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let runtime = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
    let lifecycle = dure_session_runtime::CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        runtime.clone(),
        hmux.discovery.clone(),
    )
    .unwrap();
    let request = ManagedCreateRequest::new(
        "rejected-shell-create",
        "rejected-shell",
        "local-shell-workspace",
        "local-shell",
        PermissionMode::Default,
        seed.checkout.canonicalize().unwrap(),
        vec![missing_program.to_str().unwrap().into()],
        24,
        80,
    )
    .unwrap();
    let identity = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let mut removal_preview = None;
    let mut cleanup_at_retry_return = None;
    let launch = if matches!(observation, FailedLaunchObservation::Detached) {
        use hmux_client::recovery_journal::managed_create_ledger::ManagedCreateReconcileLedgerState;
        let create = lifecycle.clone();
        let caller = tokio::spawn(async move { create.create(request).await });
        // Detach only after the actual launch owns the checkout, not while the
        // request is still queued. Ledger reads do not drive runtime cleanup.
        wait_for_shell_ledger(&hmux.discovery, &identity, |state| {
            matches!(
                state,
                ManagedCreateReconcileLedgerState::LaunchReleased { .. }
            )
        })
        .await;
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        wait_for_shell_ledger(&hmux.discovery, &identity, |state| {
            matches!(
                state,
                ManagedCreateReconcileLedgerState::AbandonedBeforeCompletion
            )
        })
        .await;
        let binding = shell_checkout_identity(&hmux.discovery, &identity);
        let cleaned = wait_for_shell_checkout_close(&state.store, &binding).await;
        eprintln!("create caller detached after launch; durable cleanup completed: {cleaned}");
        None
    } else if let FailedLaunchObservation::ProcessLost { retry_original } = observation {
        use hmux_client::recovery_journal::managed_create_ledger::{
            self, ManagedCreateReconcileLedgerState,
        };

        let mut child = process_fixture::create(&hmux.root, &request);
        tokio::select! {
            _ = wait_for_shell_ledger(&hmux.discovery, &identity, |state| {
                matches!(state, ManagedCreateReconcileLedgerState::LaunchReleased { .. })
            }) => {}
            status = child.wait() => panic!("creator exited before its launch checkpoint: {status:?}"),
        }
        assert!(child.try_wait().unwrap().is_none());
        // Signal only the owned child handle after observing its real runtime
        // checkpoint. The outer guardian retains the broker/Host evidence.
        child.kill().await.unwrap();
        assert!(!child.wait().await.unwrap().success());
        let recovered = if retry_original {
            Some(reopen_shell_lifecycle(&hmux.root, &runtime, &hmux.discovery).await)
        } else {
            None
        };
        if let Some(recovered) = &recovered {
            let initial = recovered.create(request.clone()).await;
            assert!(initial.is_err());
        }
        if matches!(
            managed_create_ledger::reconcile_identity(&hmux.discovery, &identity).unwrap(),
            ManagedCreateReconcileLedgerState::LaunchReleased { .. }
        ) {
            // Losing the product process does not prove that the independent
            // runtime launch has ended. A pending launch must retain protection.
            let preview = preview_stop(
                &state,
                "remove-after-shell-failure",
                &seed.spawn_operation_id,
            )
            .await
            .unwrap();
            let removal = call_dispatch_stop(
                &state,
                "remove-after-shell-failure-apply",
                "dispatch.stop.apply",
                apply_body(&preview),
            )
            .await;
            assert!(matches!(removal, Err(error) if error.code == "checkout_use_in_use"));
            assert!(seed.checkout.exists());
            assert_eq!(stop_count.load(Ordering::SeqCst), 0);
            removal_preview = Some(preview);
            eprintln!("orphaned runtime launch remains pending and protects its checkout");
        }
        process_fixture::reconcile_abandoned(&runtime, &hmux.discovery, &identity).await;
        match recovered {
            Some(recovered) => {
                let retry = recovered.create(request).await;
                assert!(
                    retry.is_err(),
                    "the missing executable cannot become usable"
                );
                Some(retry)
            }
            // No product call can recover a request lost before pane commit.
            // The confirmed checkout removal must discover its abandoned user.
            None => None,
        }
    } else if matches!(observation, FailedLaunchObservation::CleanupInterrupted) {
        use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

        // Interrupt only this fixture's durable product cleanup, after runtime
        // closure but before Git release. No claim or runtime state is injected.
        let database = hmux.root.join("domain.sqlite");
        let mut fault =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&database))
                .await
                .unwrap();
        sqlx::query(
            "CREATE TRIGGER interrupt_shell_cleanup BEFORE UPDATE OF admission \
             ON session_checkout_bindings WHEN NEW.admission = 'closing' \
             BEGIN SELECT RAISE(ABORT, 'injected_shell_cleanup_interruption'); END",
        )
        .execute(&mut fault)
        .await
        .unwrap();
        let interrupted = lifecycle.create(request.clone()).await;
        assert!(matches!(
            interrupted,
            Err(dure_session_runtime::SessionCheckoutError::Store(_))
        ));
        sqlx::query("DROP TRIGGER interrupt_shell_cleanup")
            .execute(&mut fault)
            .await
            .unwrap();
        fault.close().await.unwrap();

        // A fresh store/coordinator has only persisted identity and receipts,
        // as after reconnect; it must finish cleanup before returning the
        // original abandoned-create refusal. This is not process-kill proof.
        let recovered = reopen_shell_lifecycle(&hmux.root, &runtime, &hmux.discovery).await;
        let retry = recovered.create(request).await;
        assert!(
            retry.is_err(),
            "a retired identity cannot relaunch the missing executable"
        );
        cleanup_at_retry_return = Some(
            state
                .store
                .session_checkout(&shell_checkout_identity(&hmux.discovery, &identity))
                .await
                .unwrap()
                .unwrap()
                .admission,
        );
        Some(retry)
    } else {
        let launch = lifecycle.create(request).await;
        assert!(launch.is_err(), "the missing executable must not launch");
        Some(launch)
    };
    let resolution = ManagedSessionCreator::new(runtime)
        .with_discovery_root(&hmux.discovery)
        .reconcile_identity(identity.clone())
        .unwrap();
    eprintln!("failed shell launch: {launch:?}; runtime resolution: {resolution:?}");

    let preview = match removal_preview {
        // Retry the same authorized removal after pending launch recovery.
        // A new preview would compete with the already admitted close intent.
        Some(preview) => preview,
        None => preview_stop(
            &state,
            "remove-after-shell-failure",
            &seed.spawn_operation_id,
        )
        .await
        .unwrap(),
    };
    let outcome = call_dispatch_stop(
        &state,
        "remove-after-shell-failure-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .map(|value| value["receipt"]["state"]["status"].clone())
    .map_err(|error| error.code);
    let retained = seed.checkout.exists();
    let provider_stops = stop_count.load(Ordering::SeqCst);
    // Keep the fixture reclaimable on RED too; production must own this
    // compensation before returning a failed creation with no visible pane.
    lifecycle.close(identity).await.unwrap();
    if let Some(admission) = cleanup_at_retry_return {
        assert_eq!(
            admission,
            SessionCheckoutAdmissionV1::Closed,
            "retry must resume interrupted cleanup before a later removal hides it"
        );
    }
    assert_eq!(
        (outcome, retained, provider_stops),
        (Ok(serde_json::json!("succeeded")), false, 1),
        "a definitively rejected shell launch must not leave an invisible checkout user",
    );
}
