use super::*;

#[derive(Clone, Copy, Debug)]
enum LaunchProjectionChange {
    RemovedProvider,
    ReplacedProvider,
    MovedWorkspace,
}

const LAUNCH_CHANGES: [LaunchProjectionChange; 3] = [
    LaunchProjectionChange::RemovedProvider,
    LaunchProjectionChange::ReplacedProvider,
    LaunchProjectionChange::MovedWorkspace,
];

async fn change_launch_projection(
    root: &TempDir,
    state: &mut ServiceState,
    change: LaunchProjectionChange,
) {
    let root = root.path();
    assert_eq!(state.descriptor.database_path.parent(), Some(root));
    match change {
        LaunchProjectionChange::RemovedProvider => {
            fs::remove_file(root.join("codex-fixture")).unwrap();
        }
        LaunchProjectionChange::ReplacedProvider => {
            let provider = root.join("replacement-provider");
            fs::write(&provider, "#!/bin/sh\nexit 0\n").unwrap();
            fs::set_permissions(&provider, fs::Permissions::from_mode(0o700)).unwrap();
            state.agent_providers = Arc::new(provider_extension::test_agent_provider_registry(
                provider.to_str().unwrap(),
            ));
        }
        LaunchProjectionChange::MovedWorkspace => {
            let workspace_id = WorkspaceIdV1::new("workspace-1").unwrap();
            let mut workspace = state.store.workspace(&workspace_id).await.unwrap().unwrap();
            let moved = root.join("moved-workspace");
            fs::create_dir(&moved).unwrap();
            workspace.root_path = moved.to_str().unwrap().into();
            workspace.updated_at_ms += 1;
            state.store.upsert_workspace(&workspace).await.unwrap();
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum BoundPromptPhase {
    Pending,
    Uncertain,
    Written,
    Observed,
}

async fn seed_bound_prompt(
    state: &ServiceState,
    request: &DelegateOnceRequestV1,
    phase: BoundPromptPhase,
) -> DelegateOnceReceiptV1 {
    let created = state.store.create_delegate_once(request).await.unwrap();
    let session = WorkflowSessionGenerationV1 {
        session_id: dure_app::workflow_prepared_session_id(&created.dispatch_id).unwrap(),
        workspace_id: "workspace-1".into(),
        provider_id: request.provider_id.clone(),
        runner_principal: "worker-runner".into(),
        runner_instance: "worker-instance".into(),
        channel_epoch: "2".into(),
        host_instance_id: "worker-host".into(),
        terminal_epoch: "worker-terminal".into(),
    };
    let active = state
        .store
        .bind_delegate_once_session(&DelegateOnceSessionBindingRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: created.task_id.clone(),
            dispatch_id: created.dispatch_id.clone(),
            generation: created.generation,
            launch_idempotency_key: created.launch_idempotency_key.clone(),
            effective_launch_idempotency_key: created.launch_idempotency_key.clone(),
            session: session.clone(),
            bound_at_ms: 1_100,
        })
        .await
        .unwrap();
    if matches!(phase, BoundPromptPhase::Pending) {
        return active;
    }
    let prompt_key = active
        .prompt_delivery
        .as_ref()
        .unwrap()
        .idempotency_key
        .clone();
    let claimed = state
        .store
        .claim_delegate_once_prompt(&DelegateOncePromptClaimRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: active.task_id.clone(),
            dispatch_id: active.dispatch_id.clone(),
            generation: active.generation,
            delivery_idempotency_key: prompt_key.clone(),
            session: session.clone(),
            claimed_at_ms: 1_200,
        })
        .await
        .unwrap();
    assert!(claimed.claimed);
    if matches!(phase, BoundPromptPhase::Uncertain) {
        return claimed.receipt;
    }
    let written = state
        .store
        .record_delegate_once_prompt_outcome(&DelegateOncePromptOutcomeRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: active.task_id.clone(),
            dispatch_id: active.dispatch_id.clone(),
            generation: active.generation,
            delivery_idempotency_key: prompt_key.clone(),
            session: session.clone(),
            outcome: WorkflowPromptDeliveryOutcomeV1::WrittenToPty(
                WorkflowPromptDeliveryEvidenceV1::agent_prompt(
                    "worker-terminal",
                    "41",
                    "8",
                    Some("7".into()),
                ),
            ),
            recorded_at_ms: 1_300,
        })
        .await
        .unwrap();
    if matches!(phase, BoundPromptPhase::Written) {
        return written;
    }
    state
        .store
        .record_delegate_once_prompt_activity(&DelegateOncePromptActivityRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: active.task_id,
            dispatch_id: active.dispatch_id,
            generation: active.generation,
            delivery_idempotency_key: prompt_key,
            session,
            activity: WorkflowPromptActivityReceiptV1 {
                state: WorkflowPromptActivityStateV1::Observed,
                observed_output_seq: "9".into(),
                error_code: None,
            },
            observed_at_ms: 1_400,
        })
        .await
        .unwrap()
}

async fn assert_bound_recovery(phase: BoundPromptPhase) {
    for change in LAUNCH_CHANGES {
        let (root, mut state, _, _, _) = fixture_with_observation(vec![], vec![], vec![]).await;
        let request = request();
        let before = seed_bound_prompt(&state, &request, phase).await;
        change_launch_projection(&root, &mut state, change).await;
        let (reopened, launcher, deliverer, observer) =
            reopen_fixture_service_state_with_prompt_observation(
                &state,
                &state.descriptor.database_path,
            )
            .await;
        let recovered = receipt(&delegate_once(&reopened, request.clone()).await.unwrap());
        assert_eq!(recovered.status, WorkflowDispatchStateV1::Active);
        assert_eq!(recovered.task_id, before.task_id);
        assert_eq!(recovered.dispatch_id, before.dispatch_id);
        assert_eq!(recovered.run_id, before.run_id);
        assert_eq!(
            recovered.launch_idempotency_key,
            before.launch_idempotency_key
        );
        assert_eq!(recovered.session, before.session);
        assert_eq!(recovered.generation, before.generation);
        assert_eq!(
            recovered.effective_launch_idempotency_key,
            before.effective_launch_idempotency_key
        );
        assert!(launcher.requests().is_empty(), "{phase:?} / {change:?}");
        let deliveries = deliverer.requests();
        assert_eq!(
            deliveries.len(),
            usize::from(matches!(phase, BoundPromptPhase::Pending))
        );
        for delivery in &deliveries {
            assert_eq!(Some(&delivery.session), before.session.as_ref());
            assert_eq!(
                delivery.delivery_idempotency_key,
                before.prompt_delivery.as_ref().unwrap().idempotency_key
            );
        }
        let observations = observer.requests();
        assert_eq!(
            observations.len(),
            usize::from(matches!(
                phase,
                BoundPromptPhase::Pending | BoundPromptPhase::Written
            ))
        );
        for observation in &observations {
            assert_eq!(Some(&observation.session), before.session.as_ref());
            assert_eq!(observation.input_baseline_output_sequence, "8");
        }
        let prompt = recovered.prompt_delivery.as_ref().unwrap();
        if matches!(phase, BoundPromptPhase::Uncertain) {
            assert_eq!(prompt.state, WorkflowPromptDeliveryStateV1::Uncertain);
            assert_eq!(recovered, before);
        } else {
            assert_eq!(prompt.state, WorkflowPromptDeliveryStateV1::WrittenToPty);
            assert_eq!(
                prompt.evidence.as_ref().unwrap().activity().unwrap().state,
                WorkflowPromptActivityStateV1::Observed
            );
        }
        if matches!(phase, BoundPromptPhase::Observed) {
            assert_eq!(recovered, before);
        }
        if matches!(phase, BoundPromptPhase::Written) {
            let mut evidence = prompt.evidence.clone().unwrap();
            evidence.clear_activity();
            assert_eq!(
                Some(evidence),
                before.prompt_delivery.as_ref().unwrap().evidence
            );
        }
        assert_eq!(
            receipt(&delegate_once(&reopened, request.clone()).await.unwrap()),
            recovered
        );
        let mut changed_request = request;
        changed_request.task.instructions.push_str(" changed");
        assert_eq!(
            delegate_once(&reopened, changed_request)
                .await
                .unwrap_err()
                .code,
            "workflow_idempotency_conflict"
        );
        assert!(launcher.requests().is_empty());
        assert_eq!(deliverer.requests().len(), deliveries.len());
        assert_eq!(observer.requests().len(), observations.len());
        assert_eq!(
            reopened
                .store
                .delegate_once_receipt(&recovered.idempotency_key)
                .await
                .unwrap()
                .unwrap(),
            recovered
        );
        println!(
            "bound recovery: {phase:?} / {change:?}: exact identity, replay and conflict preserved (schema {})",
            reopened.store.schema_info().schema_version,
        );
    }
}

#[tokio::test]
async fn pending_prompt_recovery_uses_only_the_bound_session() {
    assert_bound_recovery(BoundPromptPhase::Pending).await;
}

#[tokio::test]
async fn uncertain_prompt_recovery_does_not_repeat_input() {
    assert_bound_recovery(BoundPromptPhase::Uncertain).await;
}

#[tokio::test]
async fn written_prompt_recovery_observes_without_redelivery() {
    assert_bound_recovery(BoundPromptPhase::Written).await;
}

#[tokio::test]
async fn observed_prompt_recovery_replays_without_launch_projections() {
    assert_bound_recovery(BoundPromptPhase::Observed).await;
}

#[tokio::test]
async fn unprepared_starting_recovery_requires_current_launch_inputs() {
    for change in LAUNCH_CHANGES {
        let (root, mut state, _, _, _) = fixture_with_observation(vec![], vec![], vec![]).await;
        let request = request();
        let starting = state.store.create_delegate_once(&request).await.unwrap();
        assert_eq!(starting.status, WorkflowDispatchStateV1::Starting);
        assert!(
            state
                .store
                .delegate_once_launch(&request.idempotency_key)
                .await
                .unwrap()
                .is_none()
        );
        change_launch_projection(&root, &mut state, change).await;
        let (mut reopened, _, deliverer, observer) =
            reopen_fixture_service_state_with_prompt_observation(
                &state,
                &state.descriptor.database_path,
            )
            .await;
        let launcher = FakeLauncher::new(vec![LaunchOutcome::Succeed]);
        reopened.credential_aware_workflow_launcher = Arc::new(launcher.clone());
        let result = delegate_once(&reopened, request.clone()).await;
        if matches!(change, LaunchProjectionChange::RemovedProvider) {
            assert_eq!(result.unwrap_err().code, "workflow_provider_unavailable");
            assert!(launcher.requests().is_empty());
            assert!(deliverer.requests().is_empty());
            assert!(observer.requests().is_empty());
            assert_eq!(
                reopened
                    .store
                    .delegate_once_receipt(&request.idempotency_key)
                    .await
                    .unwrap()
                    .unwrap(),
                starting
            );
        } else {
            let active = receipt(&result.unwrap());
            assert_eq!(active.status, WorkflowDispatchStateV1::Active);
            let launches = launcher.requests();
            assert_eq!(launches.len(), 1);
            let expected = match change {
                LaunchProjectionChange::ReplacedProvider => {
                    root.path().join("replacement-provider")
                }
                LaunchProjectionChange::MovedWorkspace => root.path().join("moved-workspace"),
                LaunchProjectionChange::RemovedProvider => unreachable!(),
            };
            let actual = match change {
                LaunchProjectionChange::ReplacedProvider => &launches[0].provider_executable,
                _ => &launches[0].working_directory,
            };
            assert_eq!(Path::new(actual), fs::canonicalize(expected).unwrap());
            assert_eq!(deliverer.requests().len(), 1);
            assert_eq!(observer.requests().len(), 1);
            assert_eq!(
                receipt(&delegate_once(&reopened, request).await.unwrap()),
                active
            );
            assert_eq!(launcher.requests().len(), 1);
            assert_eq!(deliverer.requests().len(), 1);
            assert_eq!(observer.requests().len(), 1);
        }
        println!("Starting recovery: {change:?}: current launch admission preserved");
    }
}
