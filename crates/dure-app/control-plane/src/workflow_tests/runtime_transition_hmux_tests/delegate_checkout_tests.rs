use super::*;
use crate::workspace_git::{GitWorkspaceAcquirer, WorkspaceAcquireRequest, WorkspaceAcquirer};
use dure_app::{AgentSpawnWorktreePolicyV1, GitCheckoutRegistrationV1};
use dure_git_checkout::{
    GitCheckoutRemovalOperation, GitCheckoutRemovalRequestV1, read_git_checkout_claims,
};

mod legacy_removal;
mod registration_lifecycle;
mod structured_removal;

struct DelegateCheckout {
    _repository: TempDir,
    state: ServiceState,
    hmux: RealHmux,
    coordinator: WorkflowSessionGenerationV1,
    registration: GitCheckoutRegistrationV1,
    coordinator_claim: OperationIdV1,
}

impl DelegateCheckout {
    async fn new() -> Self {
        let (root, mut state, _, prompt) = fixture(Vec::new()).await;
        let repository = crate::workspace_git::tests::repository().await;
        let coordinator_claim = OperationIdV1::new("coordinator-registration").unwrap();
        let workspace = GitWorkspaceAcquirer::default()
            .acquire(WorkspaceAcquireRequest {
                project_root: repository.path().to_path_buf(),
                workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
                registration_id: coordinator_claim.clone(),
                registration: None,
                policy: AgentSpawnWorktreePolicyV1::Dedicated {
                    base_commit_sha: crate::workspace_git::resolve_base_commit(
                        repository.path(),
                        None,
                    )
                    .await
                    .unwrap(),
                    branch: "agent/delegate-checkout".into(),
                    branch_mode: Default::default(),
                    checkout_path: None,
                },
            })
            .await
            .unwrap();
        fs::write(
            root.path().join("codex-fixture"),
            format!(
                "#!/bin/sh\nprintf 'started\\n' >> '{}'\nexec /bin/cat\n",
                root.path().join("provider-starts").display(),
            ),
        )
        .unwrap();
        let hmux = RealHmux::install(root, &mut state);
        // This fixture exercises actual launch/claim admission, not provider
        // prompt semantics. Preserve the existing deterministic prompt ports.
        state.workflow_prompt_deliverer = Arc::new(prompt);
        state.workflow_prompt_activity_observer = Arc::new(FakePromptActivityObserver::new(vec![
            ActivityOutcome::Observed("9"),
        ]));
        let coordinator = state
            .credential_aware_workflow_launcher
            .launch_with_provider_state(
                WorkflowSessionLaunchRequestV1 {
                    runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                    launch_idempotency_key: "real-coordinator-create".into(),
                    session_id: "real-coordinator".into(),
                    workspace_id: "workspace-1".into(),
                    provider_id: ProviderIdV1::new("codex").unwrap(),
                    provider_conversation_ref: None,
                    permission_mode: ProviderPermissionModeV1::Default,
                    provider_executable: hmux.root.join("codex-fixture").to_str().unwrap().into(),
                    provider_arguments: Vec::new(),
                    provider_resume: None,
                    initial_prompt: None,
                    working_directory: workspace.root.to_str().unwrap().into(),
                    prelaunch_command: None,
                },
                ProviderStateEnvironment::default(),
                None,
            )
            .await
            .unwrap()
            .session;
        bind_source_conversation(
            &state,
            &AgentIdV1::new("checkout-coordinator").unwrap(),
            &coordinator,
            None,
        )
        .await;
        let mut record = state
            .store
            .workspace(&WorkspaceIdV1::new("workspace-1").unwrap())
            .await
            .unwrap()
            .unwrap();
        record.root_path = workspace.root.to_str().unwrap().into();
        state.store.upsert_workspace(&record).await.unwrap();
        Self {
            _repository: repository,
            state,
            hmux,
            coordinator,
            registration: workspace.registration.unwrap(),
            coordinator_claim,
        }
    }

    fn removal(&self) -> GitCheckoutRemovalOperation {
        GitCheckoutRemovalOperation::new(
            &GitCheckoutRemovalRequestV1 {
                repository_path: self.registration.repository_path.clone(),
                instance: self.registration.instance.clone(),
                policy: dure_app::GitCheckoutRemovalPolicyV1::RequireClean,
            },
            &OperationIdV1::new("remove-coordinator-checkout").unwrap(),
        )
        .unwrap()
        .retiring_registration(&self.coordinator_claim)
    }

    fn request(&self) -> DelegateOnceRequestV1 {
        let mut request = request();
        request.coordinator.agent_id = AgentIdV1::new("checkout-coordinator").unwrap();
        request.coordinator.session_id = self.coordinator.session_id.clone();
        request
    }

    async fn delegate(&self) -> Result<Value, BackendDispatchError> {
        delegate_once(&self.state, self.request()).await
    }

    async fn close_worker(&self, receipt: &DelegateOnceReceiptV1) {
        let worker = receipt.session.as_ref().unwrap();
        let runtime = dure_session_runtime::CheckoutSessionRuntime::at_root(
            self.state.store.as_ref().clone(),
            self.state.hmux_identity.runtime_executable_path.clone(),
            self.hmux.discovery.clone(),
        )
        .unwrap();
        runtime
            .close(
                hmux_client::ManagedCreateReconcileRequest::new(
                    &receipt.launch_idempotency_key,
                    &worker.session_id,
                    &worker.workspace_id,
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let remaining = read_git_checkout_claims(&self.registration).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].claim_id, self.coordinator_claim);
        self.removal().admit().unwrap().abort().unwrap();
        assert_eq!(
            hmux_client::probe_local_session_exact(
                &hmux_client::LocalSessionCatalog::new(&self.hmux.discovery),
                &self.hmux.session(&self.coordinator),
            ),
            hmux_client::SessionProbeStatus::Healthy,
            "closing the worker must preserve its coordinator",
        );
    }
}

async fn reconnect_after_binding_loss(stop_coordinator: bool) {
    let mut fixture = DelegateCheckout::new().await;
    let database = fixture.hmux.root.join("domain.sqlite");
    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(&database),
    )
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_worker_binding BEFORE UPDATE OF state ON workflow_dispatch_launches
        WHEN NEW.state = 'active'
        BEGIN SELECT RAISE(ABORT, 'fault-injected worker binding'); END",
    )
    .execute(&fault_pool)
    .await
    .unwrap();
    let failed = fixture.delegate().await.unwrap_err();
    assert_eq!(failed.code, "workflow_store_failed", "{failed:?}");
    let pending = fixture
        .state
        .store
        .delegate_once_receipt(&fixture.request().idempotency_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.status, WorkflowDispatchStateV1::Starting);
    let launched = fixture.hmux.requests()[1].clone();
    let catalog = hmux_client::LocalSessionCatalog::new(&fixture.hmux.discovery);
    let selector = hmux_client::SessionSelector::new(
        &launched.session_id,
        Some(launched.workspace_id.clone()),
    );
    let before = catalog.find(&selector).unwrap();
    assert_eq!(
        hmux_client::probe_local_session_exact(&catalog, &before),
        hmux_client::SessionProbeStatus::Healthy,
    );
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    assert_eq!(claims.len(), 2);
    if stop_coordinator {
        fixture.hmux.stop(&fixture.coordinator);
    } else {
        let mut workspace = fixture
            .state
            .store
            .workspace(&WorkspaceIdV1::new("workspace-1").unwrap())
            .await
            .unwrap()
            .unwrap();
        workspace.root_path = fixture.hmux.root.to_str().unwrap().into();
        fixture
            .state
            .store
            .upsert_workspace(&workspace)
            .await
            .unwrap();
    }
    sqlx::query("DROP TRIGGER fail_worker_binding")
        .execute(&fault_pool)
        .await
        .unwrap();
    fault_pool.close().await;
    let (mut reopened, _, prompt, _) =
        reopen_fixture_service_state_with_prompt_observation(&fixture.state, &database).await;
    // The real launcher is stateless apart from the fixture's request observer.
    reopened.credential_aware_workflow_launcher =
        Arc::clone(&fixture.state.credential_aware_workflow_launcher);
    fixture.state = reopened;
    let recovered = fixture.delegate().await;
    let after = catalog.find(&selector).unwrap();
    let health = hmux_client::probe_local_session_exact(&catalog, &after);
    let retained_claims = read_git_checkout_claims(&fixture.registration).unwrap();
    let deliveries = prompt.requests();
    let starts = fs::read_to_string(fixture.hmux.root.join("provider-starts")).unwrap();
    if let Ok(recovered) = &recovered {
        assert_eq!(fixture.delegate().await.unwrap(), *recovered);
        assert_eq!(prompt.requests().len(), 1);
    }
    dure_session_runtime::CheckoutSessionRuntime::at_root(
        fixture.state.store.as_ref().clone(),
        fixture.state.hmux_identity.runtime_executable_path.clone(),
        fixture.hmux.discovery.clone(),
    )
    .unwrap()
    .close(
        hmux_client::ManagedCreateReconcileRequest::new(
            &pending.launch_idempotency_key,
            &launched.session_id,
            &launched.workspace_id,
        )
        .unwrap(),
    )
    .await
    .unwrap();
    fixture.hmux.stop(&fixture.coordinator);
    assert_eq!(health, hmux_client::SessionProbeStatus::Healthy);
    assert!(before.same_generation(&after));
    assert_eq!(before.provider_process, after.provider_process);
    assert_eq!(claims, retained_claims);
    assert_eq!(
        starts.lines().count(),
        2,
        "reconnect must not start another provider"
    );
    let recovered =
        recovered.expect("a created independent worker must survive coordinator changes");
    let active = receipt(&recovered);
    assert_eq!(active.status, WorkflowDispatchStateV1::Active);
    assert_eq!(
        active.session.unwrap().host_instance_id,
        before.host_instance_id
    );
    assert_eq!(deliveries.len(), 1);
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn delegated_worker_backend_removal_releases_its_checkout_real_hmux() {
    backend_removal(false, None).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn delegated_worker_backend_removal_after_selection_releases_its_checkout_real_hmux() {
    backend_removal(true, None).await;
}

#[derive(Clone, Copy)]
enum RemovalFault {
    ResourceCheckpoint,
    CompletionReceipt,
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn delegated_worker_backend_removal_recovers_interrupted_cleanup_real_hmux() {
    for fault in [
        RemovalFault::ResourceCheckpoint,
        RemovalFault::CompletionReceipt,
    ] {
        backend_removal(true, Some(fault)).await;
    }
}

async fn backend_removal(replace_native: bool, fault: Option<RemovalFault>) {
    let mut fixture = DelegateCheckout::new().await;
    let active = receipt(&fixture.delegate().await.unwrap());
    let worker = active.session.as_ref().unwrap();
    let agent_id = AgentIdV1::new("backend-delegate-worker").unwrap();
    fixture.adopt_worker(worker).await;
    assert_eq!(inspect(&fixture.state, &agent_id).await["state"], "stable");
    let replacement = if replace_native {
        Some(replace_worker_native(&fixture, &agent_id, worker).await)
    } else {
        None
    };

    if let Some(fault) = fault {
        recover_interrupted_removal(&mut fixture, &agent_id, fault).await;
    }

    // Permanent pane removal, unlike resumable stop, must finish its resource.
    let stopped = crate::agent_runtime_remove_apply::apply(
        &fixture.state,
        "remove-delegate-worker",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await
    .unwrap();
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    let lifecycle = fixture.hmux.session(worker).lifecycle;
    let projection = inspect(&fixture.state, &agent_id).await;
    let removal = match fixture.removal().admit() {
        Ok(permit) => {
            permit.abort().unwrap();
            Ok(())
        }
        Err(error) => Err(error.code),
    };
    let claims_after_current_chain_close = if let Some(replacement) = replacement {
        let catalog = hmux_client::LocalSessionCatalog::new(&fixture.hmux.discovery);
        let current = catalog
            .find(&hmux_client::SessionSelector::new(
                replacement.session_id(),
                Some(replacement.workspace_id().to_owned()),
            ))
            .unwrap();
        assert_eq!(current.lifecycle, hmux_client::SessionLifecycle::Exited);
        // The replacement can be retired repeatedly without selecting a new
        // resource or reviving its already removed Agent owner.
        dure_session_runtime::CheckoutSessionRuntime::at_root(
            fixture.state.store.as_ref().clone(),
            fixture.state.hmux_identity.runtime_executable_path.clone(),
            fixture.hmux.discovery.clone(),
        )
        .unwrap()
        .close(replacement)
        .await
        .unwrap();
        Some(
            read_git_checkout_claims(&fixture.registration)
                .unwrap()
                .len(),
        )
    } else {
        None
    };

    // Retire the exact disposable root even when the observation fails; this
    // cleanup is not the product removal path under test.
    cleanup_adopted_checkout(&fixture, &agent_id, &active).await;
    fixture.close_worker(&active).await;
    fixture.hmux.stop(&fixture.coordinator);
    assert_eq!(stopped, json!({ "schemaVersion": 1, "stopped": true }));
    assert_eq!(lifecycle, hmux_client::SessionLifecycle::Exited);
    assert_eq!(projection["state"], "closed");
    assert_eq!(
        claims.len(),
        1,
        "backend pane removal must end its independent checkout use: {removal:?}; \
         claims after current-chain close={claims_after_current_chain_close:?}",
    );
    assert_eq!(claims[0].claim_id, fixture.coordinator_claim);
    assert_eq!(removal, Ok(()));
}

impl DelegateCheckout {
    async fn adopt_worker(&self, worker: &WorkflowSessionGenerationV1) {
        ensure_binding(
            &self.state,
            BindingEnsureBody {
                schema_version: 1,
                agent_id: AgentIdV1::new("backend-delegate-worker").unwrap(),
                session_id: worker.session_id.clone(),
                workspace_id: worker.workspace_id.clone(),
                display_name: "Backend worker".into(),
                worktree_path: self.registration.instance.canonical_path.clone(),
                stop_fence: HmuxStopFence {
                    runner_principal: worker.runner_principal.clone(),
                    runner_instance: worker.runner_instance.clone(),
                    channel_epoch: worker.channel_epoch.clone(),
                    host_instance_id: worker.host_instance_id.clone(),
                    terminal_epoch: worker.terminal_epoch.clone(),
                },
            },
        )
        .await
        .unwrap();
    }
}

async fn recover_interrupted_removal(
    fixture: &mut DelegateCheckout,
    agent_id: &AgentIdV1,
    fault: RemovalFault,
) {
    make_fixture_mutation_authority(&mut fixture.state);
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(fixture.state.store.database_path()),
    )
    .await
    .unwrap();
    let trigger = match fault {
        RemovalFault::ResourceCheckpoint => {
            "CREATE TRIGGER fail_removal_checkpoint BEFORE UPDATE OF admission ON session_checkout_bindings \
             WHEN NEW.admission = 'closed' AND json_extract(NEW.binding_json, '$.identity.owner.kind') = 'agent' \
             BEGIN SELECT RAISE(ABORT, 'fault-injected Agent resource checkpoint'); END"
        }
        RemovalFault::CompletionReceipt => {
            "CREATE TRIGGER fail_removal_checkpoint BEFORE UPDATE OF removal_json ON agent_runtime_closes \
             WHEN json_extract(NEW.removal_json, '$.completedAtMs') IS NOT NULL \
             BEGIN SELECT RAISE(ABORT, 'fault-injected Agent removal receipt'); END"
        }
    };
    sqlx::query(trigger).execute(&pool).await.unwrap();
    let failed = crate::agent_runtime_remove_apply::apply(
        &fixture.state,
        "remove-delegate-worker",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await;
    assert!(
        failed.is_err(),
        "the finalization fault must be observed: {failed:?}"
    );
    let close = fixture
        .state
        .store
        .effective_agent_runtime_close(agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(close.state, dure_app::AgentRuntimeCloseStateV1::Stopped);
    assert_eq!(
        read_git_checkout_claims(&fixture.registration)
            .unwrap()
            .len(),
        1
    );
    let resource = fixture
        .state
        .store
        .agent_runtime_checkout(agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        resource.admission,
        match fault {
            RemovalFault::ResourceCheckpoint => dure_app::SessionCheckoutAdmissionV1::Closing,
            RemovalFault::CompletionReceipt => dure_app::SessionCheckoutAdmissionV1::Closed,
        }
    );
    assert!(
        fixture
            .state
            .store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .contains(agent_id)
    );
    sqlx::query("DROP TRIGGER fail_removal_checkpoint")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let starts = fixture.hmux.requests().len();
    let (restarted, launcher) =
        reopen_fixture_service_state(&fixture.state, fixture.state.store.database_path()).await;
    let restarted = Arc::new(restarted);
    let recovery = tokio::spawn(crate::agent_runtime_recovery::run(Arc::clone(&restarted)));
    let completed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if restarted
                .store
                .agent_runtime_removal(&close.intent.operation_id)
                .await
                .unwrap()
                .is_some_and(|removal| removal.completed_at_ms.is_some())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    recovery.abort();
    let _ = recovery.await;
    completed.expect("fresh recovery service must finish cleanup without another removal request");
    assert!(launcher.requests().is_empty());
    assert_eq!(fixture.hmux.requests().len(), starts);
    assert!(
        restarted
            .store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    fixture.state =
        Arc::try_unwrap(restarted).unwrap_or_else(|_| panic!("recovery retained its service"));
}

async fn cleanup_adopted_checkout(
    fixture: &DelegateCheckout,
    agent_id: &AgentIdV1,
    active: &DelegateOnceReceiptV1,
) {
    // Only fixture compensation: verify the selected native provider's exact
    // exit before retiring the retained root and its transferred resource.
    let authority = fixture
        .state
        .store
        .agent_checkpoint_binding_authority(agent_id)
        .await
        .unwrap()
        .unwrap();
    let generation = WorkflowSessionGenerationV1::from_checkpoint_authority(
        &authority,
        &ProviderIdV1::new("codex").unwrap(),
    );
    assert_eq!(
        fixture.hmux.session(&generation).lifecycle,
        hmux_client::SessionLifecycle::Exited
    );
    let source = active.session.as_ref().unwrap();
    dure_session_runtime::CheckoutSessionRuntime::at_root(
        fixture.state.store.as_ref().clone(),
        fixture.state.hmux_identity.runtime_executable_path.clone(),
        fixture.hmux.discovery.clone(),
    )
    .unwrap()
    .close(
        hmux_client::ManagedCreateReconcileRequest::new(
            &active.launch_idempotency_key,
            &source.session_id,
            &source.workspace_id,
        )
        .unwrap(),
    )
    .await
    .unwrap();
    if let Some(resource) = fixture
        .state
        .store
        .agent_runtime_checkout(agent_id)
        .await
        .unwrap()
    {
        fixture
            .state
            .store
            .begin_session_checkout_close(&resource.binding.identity)
            .await
            .unwrap();
        if let Some(registration) = &resource.binding.registration {
            dure_git_checkout::release_git_checkout_registration(
                registration,
                &resource.binding.claim_id,
                &OperationIdV1::new("qa-release-adopted-worker").unwrap(),
            )
            .unwrap();
        }
        fixture
            .state
            .store
            .finish_session_checkout_close(&resource.binding.identity)
            .await
            .unwrap();
    }
}

fn report_worker_state(
    fixture: &DelegateCheckout,
    worker: &WorkflowSessionGenerationV1,
    conversation: Option<&str>,
) {
    let fence = hmux_client::SessionFence {
        workspace_id: worker.workspace_id.clone(),
        session_id: worker.session_id.clone(),
        runner_principal: worker.runner_principal.clone(),
        runner_instance: worker.runner_instance.clone(),
        channel_epoch: worker.channel_epoch.parse().unwrap(),
        host_instance_id: worker.host_instance_id.clone(),
        terminal_epoch: worker.terminal_epoch.clone(),
    };
    hmux_client::ManagedAgentStateReporter::new(
        &fixture.state.hmux_identity.runtime_executable_path,
        &fixture.hmux.root,
    )
    .with_discovery_root(&fixture.hmux.discovery)
    .report_agent_state_for_fence(
        hmux_client::ManagedAttachRequest::new(&worker.session_id, &worker.workspace_id).unwrap(),
        hmux_client::AgentStateReport {
            identity_only: conversation.is_some(),
            activity: hmux_client::AgentRuntimeActivity::Waiting,
            attention: hmux_client::AgentRuntimeAttention::None,
            turn_completed: false,
            turn_completion_id: None,
            causality: None,
            working_ttl_ms: None,
            conversation_identity: conversation.map(|conversation| {
                hmux_client::ProviderConversationIdentity {
                    provider_id: "codex".into(),
                    conversation_id: conversation.into(),
                    expected_fence: Some(fence.clone()),
                }
            }),
            expected_observation: None,
        },
        fence,
    )
    .unwrap();
}

async fn replace_worker_native(
    fixture: &DelegateCheckout,
    agent_id: &AgentIdV1,
    worker: &WorkflowSessionGenerationV1,
) -> hmux_client::ManagedCreateReconcileRequest {
    report_worker_state(fixture, worker, Some(CONVERSATION));
    agent_runtime_transition_apply::apply(
        &fixture.state,
        "change-worker-effort",
        agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            expected_source_revision: Some(1),
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Discard,
            target_execution_profile: None,
            target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
                model: None,
                effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("high").unwrap()),
                permission_mode: None,
            }),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        inspect(&fixture.state, agent_id).await["receipt"]["selectionRevision"],
        2
    );
    let request = fixture.hmux.requests().last().unwrap().clone();
    assert_ne!(request.session_id, worker.session_id);
    hmux_client::ManagedCreateReconcileRequest::new(
        &request.launch_idempotency_key,
        &request.session_id,
        &request.workspace_id,
    )
    .unwrap()
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn delegated_worker_recovers_binding_after_coordinator_stop_real_hmux() {
    reconnect_after_binding_loss(true).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn delegated_worker_recovers_binding_after_workspace_change_real_hmux() {
    reconnect_after_binding_loss(false).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn delegated_worker_cannot_launch_before_prepared_input_commits_real_hmux() {
    let fixture = DelegateCheckout::new().await;
    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(fixture.hmux.root.join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_worker_preparation BEFORE UPDATE OF prepared_launch_json
        ON workflow_dispatch_launches
        BEGIN SELECT RAISE(ABORT, 'fault-injected worker preparation'); END",
    )
    .execute(&fault_pool)
    .await
    .unwrap();
    let failed = fixture.delegate().await.unwrap_err();
    assert_eq!(failed.code, "workflow_store_failed");
    assert_eq!(fixture.hmux.requests().len(), 1);
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].claim_id, fixture.coordinator_claim);
    assert!(
        fixture
            .state
            .store
            .delegate_once_launch(&fixture.request().idempotency_key)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("DROP TRIGGER fail_worker_preparation")
        .execute(&fault_pool)
        .await
        .unwrap();
    fault_pool.close().await;
    let recovered = receipt(&fixture.delegate().await.unwrap());
    assert_eq!(recovered.status, WorkflowDispatchStateV1::Active);
    fixture.close_worker(&recovered).await;
    fixture.hmux.stop(&fixture.coordinator);
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn delegated_worker_blocks_coordinator_checkout_removal_real_hmux() {
    let fixture = DelegateCheckout::new().await;
    let result = fixture.delegate().await.unwrap();
    let active = receipt(&result);
    assert_eq!(active.status, WorkflowDispatchStateV1::Active);
    assert_eq!(receipt(&fixture.delegate().await.unwrap()), active);
    assert_eq!(
        fixture.hmux.requests().len(),
        2,
        "replay cannot launch a third provider"
    );
    let worker = active.session.as_ref().unwrap();
    let worker_before = fixture.hmux.session(worker);
    let catalog = hmux_client::LocalSessionCatalog::new(&fixture.hmux.discovery);
    let health_before = hmux_client::probe_local_session_exact(&catalog, &worker_before);
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    let admitted = fixture.removal().admit();
    let outcome = match admitted {
        Ok(permit) => {
            permit.abort().unwrap();
            Ok(())
        }
        Err(error) => Err(error.code),
    };
    let worker_after = fixture.hmux.session(worker);
    let health_after = hmux_client::probe_local_session_exact(&catalog, &worker_after);
    fixture.hmux.stop(worker);
    assert!(
        fixture.removal().admit().is_err(),
        "a generation-only stop remains resumable"
    );
    fixture.close_worker(&active).await;
    fixture.hmux.stop(&fixture.coordinator);
    eprintln!("delegated checkout claims={claims:?}; removal admission={outcome:?}");
    assert_eq!(health_before, hmux_client::SessionProbeStatus::Healthy);
    assert_eq!(health_after, hmux_client::SessionProbeStatus::Healthy);
    assert_eq!(
        worker_before.host_instance_id,
        worker_after.host_instance_id
    );
    assert_eq!(
        outcome,
        Err("checkout_use_in_use"),
        "an independent live worker must outlive its coordinator's retiring registration"
    );
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn delegated_worker_cannot_start_after_checkout_removal_admission_real_hmux() {
    let fixture = DelegateCheckout::new().await;
    let permit = fixture.removal().admit().unwrap();
    let outcome = fixture.delegate().await;
    let worker = outcome
        .as_ref()
        .ok()
        .and_then(|result| receipt(result).session);
    let live_worker = worker.as_ref().map(|worker| fixture.hmux.session(worker));
    let launch_attempts = fixture.hmux.requests().len();
    if let Some(worker) = worker {
        fixture.hmux.stop(&worker);
    }
    permit.abort().unwrap();
    let resumed = receipt(&fixture.delegate().await.unwrap());
    fixture.close_worker(&resumed).await;
    fixture.hmux.stop(&fixture.coordinator);
    eprintln!("fenced delegate result={outcome:?}; worker={live_worker:?}");
    assert!(
        live_worker.is_none(),
        "a prior removal permit must prevent a new provider launch"
    );
    assert_eq!(
        launch_attempts, 1,
        "only the coordinator may have reached the launcher"
    );
    assert!(matches!(outcome, Err(error) if error.code == "checkout_use_phase_conflict"));
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn delegated_worker_failed_launch_releases_only_its_checkout_claim_real_hmux() {
    let mut fixture = DelegateCheckout::new().await;
    // Select a separate failing executable for the worker. Rewriting the
    // coordinator's script can truncate it before its shell reads the body.
    let worker_program = fixture.hmux.root.join("failed-worker-fixture");
    fs::write(&worker_program, "#!/missing/qa-interpreter\n").unwrap();
    fs::set_permissions(&worker_program, fs::Permissions::from_mode(0o700)).unwrap();
    fixture.state.agent_providers = Arc::new(provider_extension::test_agent_provider_registry(
        worker_program.to_str().unwrap(),
    ));
    let outcome = fixture.delegate().await;
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    let coordinator_authority = fixture
        .state
        .store
        .agent_checkpoint_binding_authority(&AgentIdV1::new("checkout-coordinator").unwrap())
        .await
        .unwrap()
        .unwrap();
    probe_runtime_binding(&fixture.state.runtime_adapters, coordinator_authority)
        .await
        .expect("failed worker launch must preserve the coordinator");
    let retry = fixture.delegate().await.unwrap();
    assert_eq!(receipt(&retry).status, WorkflowDispatchStateV1::StartFailed);
    assert_eq!(
        fixture.hmux.requests().len(),
        2,
        "a retired creation cannot launch again"
    );
    let admission = fixture.removal().admit();
    let removal_allowed = match admission {
        Ok(permit) => {
            permit.abort().unwrap();
            true
        }
        Err(_) => false,
    };
    fixture.hmux.stop(&fixture.coordinator);
    eprintln!("failed delegate result={outcome:?}; retained claims={claims:?}");
    if let Ok(result) = outcome {
        assert_eq!(
            receipt(&result).status,
            WorkflowDispatchStateV1::StartFailed
        );
    }
    assert_eq!(
        claims.len(),
        1,
        "a failed independent launch must not strand an invisible claim"
    );
    assert_eq!(claims[0].claim_id, fixture.coordinator_claim);
    assert!(removal_allowed);
}
