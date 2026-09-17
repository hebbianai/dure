use dure_app::{
    AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1, AGENT_SPAWN_SCHEMA_VERSION_V1,
    AgentDispatchStopAuthorizeRequestV1, AgentDispatchStopPreviewV1, AgentDispatchStopRecordV1,
    AgentDispatchStopRuntimeFenceV1, AgentDispatchStopStateV1, AgentDispatchStopStore,
    AgentDispatchStopTerminalRequestV1, AgentDispatchStopTerminalTransitionV1,
    AgentDispatchStopWorkspacePlanV1, AgentExecutionProfileV1, AgentIdV1,
    AgentInteractionBindingV1, AgentInteractionProfileV1, AgentInteractionSessionIdV1,
    AgentProviderConversationPlanV1, AgentProviderRuntimeFenceV1, AgentRecordV1,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseAdvanceRequestV1, AgentRuntimeCloseAdvanceV1,
    AgentRuntimeCloseIntentV1, AgentRuntimeCloseStateV1, AgentRuntimeCloseStore,
    AgentRuntimeReplacementV1, AgentRuntimeSelectionV1, AgentRuntimeSourceStopPolicyV1,
    AgentRuntimeTransitionIntentV1, AgentRuntimeTransitionStateV1, AgentRuntimeTransitionStore,
    AgentSpawnAuthorityV1, AgentSpawnJournalEventBodyV1, AgentSpawnJournalEventV1,
    AgentSpawnJournalStore, AgentSpawnLaunchPlanV1, AgentSpawnPlanDraftV1,
    AgentSpawnPreviewRequestV1, AgentSpawnStageDispositionV1, AgentSpawnStageEvidenceV1,
    AgentSpawnStageInputsV1, AgentSpawnWorkspaceLeaseV1, AgentSpawnWorktreePolicyV1,
    AgentTimelineEpochV1, AgentTimelineStore, CURRENT_STORE_SCHEMA_VERSION, DomainStore,
    DomainStoreErrorV1, GIT_CHECKOUT_SCHEMA_VERSION_V1, GitCheckoutInstanceV1,
    GitCheckoutRemovalOutcomeV1, GitCheckoutRemovalPolicyV1, GitCheckoutRemovalReceiptV1,
    GitCheckoutRemovalRequestV1, OperationEventIdV1, OperationIdV1, ProjectIdV1, ProjectRecordV1,
    ProviderIdV1, ProviderPermissionModeV1, WorkspaceIdV1, WorkspaceRecordV1,
    create_agent_spawn_plan_v1, preview_agent_dispatch_stop_v1,
};
use tempfile::TempDir;

use super::SqliteDomainStore;

mod dormant;

struct Fixture {
    store: SqliteDomainStore,
    plan: dure_app::AgentDispatchStopPlanV1,
    spawn_receipt: dure_app::AgentSpawnJournalReceiptV1,
}

fn authorize_request(
    plan: &dure_app::AgentDispatchStopPlanV1,
) -> AgentDispatchStopAuthorizeRequestV1 {
    authorize_request_for(plan, "runtime-close-1", 210)
}

fn authorize_request_for(
    plan: &dure_app::AgentDispatchStopPlanV1,
    close_operation: &str,
    requested_at_ms: i64,
) -> AgentDispatchStopAuthorizeRequestV1 {
    AgentDispatchStopAuthorizeRequestV1 {
        schema_version: 1,
        operation_id: plan.operation_id().clone(),
        plan_token: plan.plan_token().clone(),
        expected_journal_revision: 1,
        runtime_close_intent: AgentRuntimeCloseIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new(close_operation).unwrap(),
            idempotency_key: format!("{close_operation}-key"),
            source: plan.runtime_selection().clone(),
            source_authority: plan.runtime_authority().clone(),
            stopped_transition: None,
            requested_at_ms,
        },
        authorized_at_ms: requested_at_ms + 10,
    }
}

fn retry_plan(
    fixture: &Fixture,
    operation: &str,
    planned_at_ms: i64,
) -> dure_app::AgentDispatchStopPlanV1 {
    plan_with(
        fixture,
        operation,
        planned_at_ms,
        fixture.plan.runtime_selection().clone(),
        fixture.plan.runtime_authority().clone(),
        fixture.plan.owned_checkout().unwrap().clone(),
    )
}

fn plan_with(
    fixture: &Fixture,
    operation: &str,
    planned_at_ms: i64,
    runtime_selection: AgentRuntimeSelectionV1,
    runtime_authority: AgentRuntimeBindingAuthorityV1,
    owned_checkout: GitCheckoutRemovalRequestV1,
) -> dure_app::AgentDispatchStopPlanV1 {
    preview_agent_dispatch_stop_v1(
        AgentDispatchStopPreviewV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new(operation).unwrap(),
            spawn_operation_id: fixture.spawn_receipt.operation_id.clone(),
            workspace_plan: AgentDispatchStopWorkspacePlanV1::RemoveOwned {
                checkout: owned_checkout,
            },
            planned_at_ms,
        },
        &fixture.spawn_receipt,
        runtime_selection,
        runtime_authority,
        None,
    )
    .unwrap()
}

fn preserve_plan(
    fixture: &Fixture,
    operation: &str,
    planned_at_ms: i64,
) -> dure_app::AgentDispatchStopPlanV1 {
    preview_agent_dispatch_stop_v1(
        AgentDispatchStopPreviewV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new(operation).unwrap(),
            spawn_operation_id: fixture.spawn_receipt.operation_id.clone(),
            workspace_plan: AgentDispatchStopWorkspacePlanV1::Preserve,
            planned_at_ms,
        },
        &fixture.spawn_receipt,
        fixture.plan.runtime_selection().clone(),
        fixture.plan.runtime_authority().clone(),
        None,
    )
    .unwrap()
}

fn preserve_plan_with_fence(
    fixture: &Fixture,
    operation: &str,
    planned_at_ms: i64,
    runtime_fence: AgentDispatchStopRuntimeFenceV1,
) -> dure_app::AgentDispatchStopPlanV1 {
    preview_agent_dispatch_stop_v1(
        AgentDispatchStopPreviewV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new(operation).unwrap(),
            spawn_operation_id: fixture.spawn_receipt.operation_id.clone(),
            workspace_plan: AgentDispatchStopWorkspacePlanV1::Preserve,
            planned_at_ms,
        },
        &fixture.spawn_receipt,
        fixture.plan.runtime_selection().clone(),
        fixture.plan.runtime_authority().clone(),
        Some(runtime_fence),
    )
    .unwrap()
}

async fn replace_runtime_and_plan(
    fixture: &Fixture,
    operation: &str,
    planned_at_ms: i64,
) -> dure_app::AgentDispatchStopPlanV1 {
    let source = fixture
        .store
        .agent_interaction_for_agent(fixture.plan.agent_id())
        .await
        .unwrap()
        .unwrap();
    let successor = fixture
        .store
        .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
            schema_version: 1,
            interaction_session_id: source.interaction_session_id.clone(),
            expected_binding_revision: source.binding_revision,
            source: source.runtime,
            source_execution_profile: source.execution_profile.clone(),
            target: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-successor".into(),
                provider_epoch: "provider-successor".into(),
            },
            target_execution_profile: source.execution_profile,
            provider_conversation_ref: Some("thread-successor".into()),
            replaced_at_ms: planned_at_ms - 1,
        })
        .await
        .unwrap();
    plan_with(
        fixture,
        operation,
        planned_at_ms,
        fixture.plan.runtime_selection().clone(),
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: successor },
        fixture.plan.owned_checkout().unwrap().clone(),
    )
}

async fn terminalize_source_retained(
    store: &SqliteDomainStore,
    plan: &dure_app::AgentDispatchStopPlanV1,
    close_operation: &str,
    requested_at_ms: i64,
) -> AgentDispatchStopRecordV1 {
    let (authorized, admitted) = store
        .authorize_agent_dispatch_stop(&authorize_request_for(
            plan,
            close_operation,
            requested_at_ms,
        ))
        .await
        .unwrap();
    let retained = store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::SourceRetained,
            advanced_at_ms: requested_at_ms + 20,
        })
        .await
        .unwrap();
    store
        .terminalize_agent_dispatch_stop(&AgentDispatchStopTerminalRequestV1 {
            schema_version: 1,
            operation_id: plan.operation_id().clone(),
            plan_token: plan.plan_token().clone(),
            expected_journal_revision: authorized.journal_revision(),
            transition: AgentDispatchStopTerminalTransitionV1::SourceRetained {
                runtime_close: Box::new(retained),
            },
            transitioned_at_ms: requested_at_ms + 30,
        })
        .await
        .unwrap()
}

fn spawn_event(
    plan: &dure_app::AgentSpawnPlanV1,
    sequence: u32,
    body: AgentSpawnJournalEventBodyV1,
) -> AgentSpawnJournalEventV1 {
    AgentSpawnJournalEventV1 {
        event_id: OperationEventIdV1::new(format!("spawn-event-{sequence}")).unwrap(),
        operation_id: plan.operation_id.clone(),
        sequence,
        plan_token: plan.plan_token.clone(),
        body,
        recorded_at_ms: 100 + i64::from(sequence),
    }
}

async fn fixture(path: &std::path::Path) -> Fixture {
    fixture_with_event_limit(path, 6).await
}

async fn fixture_with_event_limit(path: &std::path::Path, event_limit: usize) -> Fixture {
    let store = SqliteDomainStore::open(path).await.unwrap();
    let project_id = ProjectIdV1::new("project-1").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-1").unwrap();
    let agent_id = AgentIdV1::new("agent-1").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: "/repo".into(),
            display_name: "Project".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id: project_id.clone(),
            root_path: "/repo/.worktrees/agent-1".into(),
            base_commit_sha: Some("a".repeat(40)),
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: workspace_id.clone(),
            provider_id: provider_id.clone(),
            display_name: "Agent".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();

    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("thread-1".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-1".into(),
            provider_epoch: "provider-1".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 90,
        updated_at_ms: 90,
    };
    let selection = AgentRuntimeSelectionV1 {
        schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 90,
    };
    store.create_agent_interaction(&binding).await.unwrap();
    store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();

    let branch = "agent/agent-1";
    let spawn = create_agent_spawn_plan_v1(AgentSpawnPlanDraftV1 {
        schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
        operation_id: OperationIdV1::new("spawn-1").unwrap(),
        authority: AgentSpawnAuthorityV1 {
            backend_id: "backend-a".into(),
            backend_generation: "generation-1".into(),
            project_id: project_id.clone(),
            root_id: "root_0123456789abcdef0123456789abcdef".into(),
            repository_id: "repo_fedcba9876543210fedcba9876543210".into(),
        },
        request: AgentSpawnPreviewRequestV1 {
            schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
            idempotency_key: "spawn-request-1".into(),
            project_id,
            provider_id: provider_id.clone(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            agent_name: "agent-1".into(),
            worktree: AgentSpawnWorktreePolicyV1::Dedicated {
                base_commit_sha: "a".repeat(40),
                branch: branch.into(),
                branch_mode: Default::default(),
                checkout_path: None,
            },
            provider_conversation_ref: Default::default(),
            permission_mode: ProviderPermissionModeV1::Default,
            prompt_digest: None,
            setup_command: None,
            model: None,
            effort: None,
            interaction_preference: None,
        },
        agent_id: agent_id.clone(),
        workspace_id: workspace_id.clone(),
        launch: AgentSpawnLaunchPlanV1::StructuredProtocol,
        provider_launch_defaults: None,
    })
    .unwrap();
    let lease = AgentSpawnWorkspaceLeaseV1::for_dedicated(&workspace_id, branch).unwrap();
    let events = [
        spawn_event(
            &spawn,
            1,
            AgentSpawnJournalEventBodyV1::Planned {
                plan: Box::new(spawn.clone()),
            },
        ),
        spawn_event(
            &spawn,
            2,
            AgentSpawnJournalEventBodyV1::StagePrepared {
                attempt: 1,
                inputs: AgentSpawnStageInputsV1::Worktree {
                    workspace_id: workspace_id.clone(),
                    project_root_id: spawn.authority.root_id.clone(),
                    repository_id: spawn.authority.repository_id.clone(),
                    policy: spawn.request.worktree.clone(),
                },
            },
        ),
        spawn_event(
            &spawn,
            3,
            AgentSpawnJournalEventBodyV1::StageCommitted {
                attempt: 1,
                evidence: AgentSpawnStageEvidenceV1::Worktree {
                    workspace_id: workspace_id.clone(),
                    disposition: AgentSpawnStageDispositionV1::CreatedDureOwned,
                    lease: Some(lease),
                },
            },
        ),
        spawn_event(
            &spawn,
            4,
            AgentSpawnJournalEventBodyV1::StagePrepared {
                attempt: 1,
                inputs: AgentSpawnStageInputsV1::StructuredLaunch {
                    agent_id: agent_id.clone(),
                    workspace_id: workspace_id.clone(),
                    provider_id: provider_id.clone(),
                    execution_profile: AgentExecutionProfileV1::ProviderDefault,
                    provider_conversation_ref: Default::default(),
                },
            },
        ),
        spawn_event(
            &spawn,
            5,
            AgentSpawnJournalEventBodyV1::StageCommitted {
                attempt: 1,
                evidence: AgentSpawnStageEvidenceV1::StructuredLaunch {
                    binding: binding.clone(),
                },
            },
        ),
        spawn_event(&spawn, 6, AgentSpawnJournalEventBodyV1::Succeeded),
    ];
    let mut spawn_receipt = None;
    for event in events.into_iter().take(event_limit) {
        spawn_receipt = Some(store.append_agent_spawn_event(&event).await.unwrap());
    }
    let checkout = GitCheckoutRemovalRequestV1 {
        repository_path: "/repo".into(),
        instance: GitCheckoutInstanceV1 {
            schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
            canonical_path: "/repo/.worktrees/agent-1".into(),
            git_common_dir: "/repo/.git".into(),
            git_dir: "/repo/.git/worktrees/agent-1".into(),
            instance_token: "dwt1_0123456789abcdef0123456789abcdef".into(),
        },
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    };
    let spawn_receipt = spawn_receipt.unwrap();
    let plan = preview_agent_dispatch_stop_v1(
        AgentDispatchStopPreviewV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("stop-1").unwrap(),
            spawn_operation_id: spawn.operation_id.clone(),
            workspace_plan: AgentDispatchStopWorkspacePlanV1::RemoveOwned { checkout },
            planned_at_ms: 200,
        },
        &spawn_receipt,
        selection,
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
        None,
    )
    .unwrap();
    Fixture {
        store,
        plan,
        spawn_receipt,
    }
}

#[tokio::test]
async fn planned_stop_keeps_legacy_registration_after_spawn_progress_and_restart() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("domain.sqlite");
    let fixture = fixture_with_event_limit(&path, 3).await;
    let expected = fixture
        .store
        .plan_agent_dispatch_stop(&fixture.plan)
        .await
        .unwrap();
    let checkout = fixture.plan.owned_checkout().unwrap();
    let mut claimed = spawn_event(
        &fixture.spawn_receipt.plan,
        4,
        AgentSpawnJournalEventBodyV1::CheckoutClaimed {
            registration: dure_app::GitCheckoutRegistrationV1 {
                repository_path: checkout.repository_path.clone(),
                instance: checkout.instance.clone(),
            },
        },
    );
    claimed.recorded_at_ms = 250;
    fixture
        .store
        .append_agent_spawn_event(&claimed)
        .await
        .unwrap();
    drop(fixture.store);
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let restored = store
        .agent_dispatch_stop(expected.plan().operation_id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored, expected);
    assert!(restored.plan().spawn().checkout_registration.is_none());
}

#[tokio::test]
async fn registered_stop_round_trips_without_adopting_a_changed_checkout() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("domain.sqlite");
    let mut fixture = fixture_with_event_limit(&path, 3).await;
    let checkout = fixture.plan.owned_checkout().unwrap().clone();
    let registration = dure_app::GitCheckoutRegistrationV1 {
        repository_path: checkout.repository_path.clone(),
        instance: checkout.instance.clone(),
    };
    fixture.spawn_receipt = fixture
        .store
        .append_agent_spawn_event(&spawn_event(
            &fixture.spawn_receipt.plan,
            4,
            AgentSpawnJournalEventBodyV1::CheckoutClaimed {
                registration: registration.clone(),
            },
        ))
        .await
        .unwrap();
    let plan = retry_plan(&fixture, "registered-stop", 210);
    let expected = fixture.store.plan_agent_dispatch_stop(&plan).await.unwrap();
    assert_eq!(
        expected.plan().spawn().checkout_registration,
        Some(registration)
    );
    drop(fixture.store);
    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store
            .agent_dispatch_stop(plan.operation_id())
            .await
            .unwrap(),
        Some(expected)
    );

    fixture.store = store;
    let mut replacement = checkout;
    replacement.instance.instance_token = format!("dwt1_{}", "f".repeat(32));
    let other = plan_with(
        &fixture,
        "replacement-stop",
        211,
        plan.runtime_selection().clone(),
        plan.runtime_authority().clone(),
        replacement,
    );
    assert!(matches!(
        fixture.store.plan_agent_dispatch_stop(&other).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent dispatch stop checkout",
            ..
        })
    ));
}

#[tokio::test]
async fn planned_stop_round_trips_as_one_durable_record() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let Fixture { store, plan, .. } = fixture(&path).await;
    let expected = AgentDispatchStopRecordV1::planned(plan.clone());

    assert_eq!(
        store.plan_agent_dispatch_stop(&plan).await.unwrap(),
        expected
    );
    assert_eq!(
        store
            .agent_dispatch_stop(plan.operation_id())
            .await
            .unwrap(),
        Some(expected.clone())
    );
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .agent_dispatch_stop(plan.operation_id())
            .await
            .unwrap(),
        Some(expected)
    );
}

#[tokio::test]
async fn preserved_workspace_terminal_round_trips_without_checkout_storage() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let fixture = fixture(&path).await;
    let plan = preserve_plan(&fixture, "stop-preserve", 200);
    fixture.store.plan_agent_dispatch_stop(&plan).await.unwrap();
    let (authorized, admitted) = fixture
        .store
        .authorize_agent_dispatch_stop(&authorize_request_for(&plan, "runtime-close-preserve", 210))
        .await
        .unwrap();
    let stopped = fixture
        .store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: 230,
        })
        .await
        .unwrap();
    let terminal = fixture
        .store
        .terminalize_agent_dispatch_stop(&AgentDispatchStopTerminalRequestV1 {
            schema_version: 1,
            operation_id: plan.operation_id().clone(),
            plan_token: plan.plan_token().clone(),
            expected_journal_revision: authorized.journal_revision(),
            transition: AgentDispatchStopTerminalTransitionV1::Preserved {
                runtime_close: Box::new(stopped),
            },
            transitioned_at_ms: 240,
        })
        .await
        .unwrap();
    assert!(matches!(
        terminal.state(),
        AgentDispatchStopStateV1::WorkspacePreserved { .. }
    ));
    let stored: (String, Option<String>) = sqlx::query_as(
        "SELECT workspace_action_json, terminal_workspace_receipt_json FROM agent_dispatch_stops WHERE operation_id = ?1",
    )
    .bind(plan.operation_id().as_str())
    .fetch_one(&fixture.store.pool)
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&stored.0).unwrap(),
        serde_json::json!({ "workspaceDisposition": "preserve" })
    );
    assert!(stored.1.is_none());
    assert!(
        sqlx::query(
            "UPDATE agent_dispatch_stops SET workspace_action_json = '{}' WHERE operation_id = ?1",
        )
        .bind(plan.operation_id().as_str())
        .execute(&fixture.store.pool)
        .await
        .is_err(),
        "the schema must reject a workspace action without its disposition tag",
    );
    fixture.store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .agent_dispatch_stop(plan.operation_id())
            .await
            .unwrap(),
        Some(terminal)
    );
}

#[tokio::test]
async fn fresh_exact_plan_atomically_supersedes_only_the_stale_planned_blocker() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let fixture = fixture(&path).await;
    fixture
        .store
        .plan_agent_dispatch_stop(&fixture.plan)
        .await
        .unwrap();
    let successor = replace_runtime_and_plan(&fixture, "stop-0", 200).await;

    let fresh = fixture
        .store
        .plan_agent_dispatch_stop(&successor)
        .await
        .unwrap();
    let superseded = fixture
        .store
        .agent_dispatch_stop(fixture.plan.operation_id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(superseded.state(), &AgentDispatchStopStateV1::Superseded);
    assert_eq!(superseded.journal_revision(), 2);
    assert_eq!(
        fixture
            .store
            .plan_agent_dispatch_stop(&fixture.plan)
            .await
            .unwrap(),
        superseded,
        "exact operation replay precedes current-runtime and active-plan checks"
    );
    assert_eq!(
        fixture
            .store
            .agent_dispatch_stop_for_spawn_operation(&fixture.spawn_receipt.operation_id)
            .await
            .unwrap(),
        Some(fresh),
        "the active successor wins even when its operation sorts before the predecessor"
    );
    assert!(
        fixture
            .store
            .agent_dispatch_stop_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        fixture
            .store
            .authorize_agent_dispatch_stop(&authorize_request(&fixture.plan))
            .await,
        Err(DomainStoreErrorV1::InvalidEventStream { .. })
    ));
    assert!(
        fixture
            .store
            .agent_runtime_close(&OperationIdV1::new("runtime-close-1").unwrap())
            .await
            .unwrap()
            .is_none(),
        "a superseded plan cannot admit its frozen child close"
    );

    let terminal =
        terminalize_source_retained(&fixture.store, &successor, "runtime-close-successor", 210)
            .await;
    assert_eq!(
        fixture
            .store
            .agent_dispatch_stop_for_spawn_operation(&fixture.spawn_receipt.operation_id)
            .await
            .unwrap(),
        Some(terminal.clone()),
        "an effect-terminal successor wins a same-time tie with superseded history"
    );
    fixture.store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .agent_dispatch_stop(fixture.plan.operation_id())
            .await
            .unwrap(),
        Some(superseded)
    );
    assert_eq!(
        reopened
            .agent_dispatch_stop_for_spawn_operation(&fixture.spawn_receipt.operation_id)
            .await
            .unwrap(),
        Some(terminal)
    );
}

#[tokio::test]
async fn failed_successor_insert_rolls_back_superseding_the_old_plan() {
    let temp_dir = TempDir::new().unwrap();
    let fixture = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let planned = fixture
        .store
        .plan_agent_dispatch_stop(&fixture.plan)
        .await
        .unwrap();
    let successor = replace_runtime_and_plan(&fixture, "stop-successor", 300).await;
    sqlx::query(
        r#"
        CREATE TRIGGER fail_agent_dispatch_stop_successor_insert
        BEFORE INSERT ON agent_dispatch_stops
        WHEN NEW.operation_id = 'stop-successor'
        BEGIN
            SELECT RAISE(ABORT, 'injected successor insert failure');
        END
        "#,
    )
    .execute(&fixture.store.pool)
    .await
    .unwrap();

    assert!(matches!(
        fixture.store.plan_agent_dispatch_stop(&successor).await,
        Err(DomainStoreErrorV1::Storage { code: "sqlite", .. })
    ));
    assert_eq!(
        fixture
            .store
            .agent_dispatch_stop(fixture.plan.operation_id())
            .await
            .unwrap(),
        Some(planned.clone())
    );
    assert_eq!(
        fixture
            .store
            .active_agent_dispatch_stop(fixture.plan.agent_id())
            .await
            .unwrap(),
        Some(planned),
        "the transaction must not strand the old plan after insert rollback"
    );
    assert!(
        fixture
            .store
            .agent_dispatch_stop(successor.operation_id())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn unfenced_plan_cannot_supersede_a_transition_fenced_plan() {
    let temp_dir = TempDir::new().unwrap();
    let fixture = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let transition = fixture
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: OperationIdV1::new("runtime-transition-plan-fence").unwrap(),
            idempotency_key: "runtime-transition-plan-fence-key".into(),
            source: fixture.plan.runtime_selection().clone(),
            source_authority: fixture.plan.runtime_authority().clone(),
            source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: AgentProviderConversationPlanV1::resume("thread-1").unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 201,
        })
        .await
        .unwrap();
    let fenced = preserve_plan_with_fence(
        &fixture,
        "stop-transition-fenced",
        220,
        AgentDispatchStopRuntimeFenceV1::Transition {
            record: Box::new(transition),
        },
    );
    let planned = fixture
        .store
        .plan_agent_dispatch_stop(&fenced)
        .await
        .unwrap();
    let unfenced = preserve_plan(&fixture, "stop-transition-unfenced", 230);

    assert!(matches!(
        fixture.store.plan_agent_dispatch_stop(&unfenced).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        fixture
            .store
            .agent_dispatch_stop(fenced.operation_id())
            .await
            .unwrap(),
        Some(planned.clone()),
        "rejecting a false-stable successor must not supersede the fenced plan"
    );
    assert_eq!(
        fixture
            .store
            .active_agent_dispatch_stop(fenced.agent_id())
            .await
            .unwrap(),
        Some(planned)
    );
    assert!(
        fixture
            .store
            .agent_dispatch_stop(unfenced.operation_id())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn unfenced_plan_cannot_supersede_an_effective_close_fenced_plan() {
    let temp_dir = TempDir::new().unwrap();
    let fixture = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let close = fixture
        .store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("runtime-close-plan-fence").unwrap(),
            idempotency_key: "runtime-close-plan-fence-key".into(),
            source: fixture.plan.runtime_selection().clone(),
            source_authority: fixture.plan.runtime_authority().clone(),
            stopped_transition: None,
            requested_at_ms: 201,
        })
        .await
        .unwrap();
    let fenced = preserve_plan_with_fence(
        &fixture,
        "stop-close-fenced",
        220,
        AgentDispatchStopRuntimeFenceV1::Close {
            record: Box::new(close),
        },
    );
    let planned = fixture
        .store
        .plan_agent_dispatch_stop(&fenced)
        .await
        .unwrap();
    let unfenced = preserve_plan(&fixture, "stop-close-unfenced", 230);

    assert!(matches!(
        fixture.store.plan_agent_dispatch_stop(&unfenced).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        fixture
            .store
            .agent_dispatch_stop(fenced.operation_id())
            .await
            .unwrap(),
        Some(planned.clone()),
        "rejecting a false-stable successor must not supersede the fenced plan"
    );
    assert_eq!(
        fixture
            .store
            .active_agent_dispatch_stop(fenced.agent_id())
            .await
            .unwrap(),
        Some(planned)
    );
    assert!(
        fixture
            .store
            .agent_dispatch_stop(unfenced.operation_id())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn concurrent_fresh_plans_choose_one_winner_without_supersession_churn() {
    let temp_dir = TempDir::new().unwrap();
    let fixture = fixture(&temp_dir.path().join("domain.sqlite")).await;
    fixture
        .store
        .plan_agent_dispatch_stop(&fixture.plan)
        .await
        .unwrap();
    let first = replace_runtime_and_plan(&fixture, "stop-successor-a", 300).await;
    let second = plan_with(
        &fixture,
        "stop-successor-b",
        300,
        first.runtime_selection().clone(),
        first.runtime_authority().clone(),
        first.owned_checkout().unwrap().clone(),
    );

    let (first_result, second_result) = tokio::join!(
        fixture.store.plan_agent_dispatch_stop(&first),
        fixture.store.plan_agent_dispatch_stop(&second),
    );
    let (winner, loser) = match (first_result, second_result) {
        (Ok(winner), Err(error)) => (winner, (second.operation_id(), error)),
        (Err(error), Ok(winner)) => (winner, (first.operation_id(), error)),
        outcomes => panic!("expected one exact planning winner, got {outcomes:?}"),
    };
    assert!(matches!(
        loser.1,
        DomainStoreErrorV1::IdentityConflict { .. }
    ));
    assert!(
        fixture
            .store
            .agent_dispatch_stop(loser.0)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fixture
            .store
            .active_agent_dispatch_stop(fixture.plan.agent_id())
            .await
            .unwrap(),
        Some(winner)
    );
    assert_eq!(
        fixture
            .store
            .agent_dispatch_stop(fixture.plan.operation_id())
            .await
            .unwrap()
            .unwrap()
            .state(),
        &AgentDispatchStopStateV1::Superseded
    );
}

#[tokio::test]
async fn authorized_stop_is_never_superseded_by_another_plan() {
    let temp_dir = TempDir::new().unwrap();
    let fixture = fixture(&temp_dir.path().join("domain.sqlite")).await;
    fixture
        .store
        .plan_agent_dispatch_stop(&fixture.plan)
        .await
        .unwrap();
    let (authorized, _) = fixture
        .store
        .authorize_agent_dispatch_stop(&authorize_request(&fixture.plan))
        .await
        .unwrap();
    let successor = retry_plan(&fixture, "stop-after-authorize", 300);

    assert!(matches!(
        fixture.store.plan_agent_dispatch_stop(&successor).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        fixture
            .store
            .agent_dispatch_stop(fixture.plan.operation_id())
            .await
            .unwrap(),
        Some(authorized)
    );
    assert!(
        fixture
            .store
            .agent_dispatch_stop(successor.operation_id())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn failed_parent_authorization_rolls_back_the_new_child_close() {
    let temp_dir = TempDir::new().unwrap();
    let Fixture { store, plan, .. } = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let planned = store.plan_agent_dispatch_stop(&plan).await.unwrap();
    let request = authorize_request(&plan);
    sqlx::query(
        r#"
        CREATE TRIGGER fail_agent_dispatch_stop_authorize
        BEFORE UPDATE ON agent_dispatch_stops
        BEGIN
            SELECT RAISE(ABORT, 'injected parent authorization failure');
        END
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(matches!(
        store.authorize_agent_dispatch_stop(&request).await,
        Err(DomainStoreErrorV1::Storage { code: "sqlite", .. })
    ));
    assert!(
        store
            .agent_runtime_close(&request.runtime_close_intent.operation_id)
            .await
            .unwrap()
            .is_none(),
        "a failed parent CAS must not leave an admitted child"
    );
    assert_eq!(
        store
            .agent_dispatch_stop(plan.operation_id())
            .await
            .unwrap(),
        Some(planned)
    );

    sqlx::query("DROP TRIGGER fail_agent_dispatch_stop_authorize")
        .execute(&store.pool)
        .await
        .unwrap();
    let (authorized, child) = store.authorize_agent_dispatch_stop(&request).await.unwrap();
    assert!(matches!(
        authorized.state(),
        AgentDispatchStopStateV1::Authorized { .. }
    ));
    assert_eq!(child.state, AgentRuntimeCloseStateV1::Admitted);
    assert_eq!(
        store.authorize_agent_dispatch_stop(&request).await.unwrap(),
        (authorized, child),
        "a lost authorization response must replay both exact records"
    );
}

#[tokio::test]
async fn transition_convergence_commits_only_with_stop_authorization() {
    let temp_dir = TempDir::new().unwrap();
    let Fixture {
        store,
        plan: stable_plan,
        spawn_receipt,
    } = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let transition = store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: OperationIdV1::new("stop-transition-fence").unwrap(),
            idempotency_key: "stop-transition-fence-key".into(),
            source: stable_plan.runtime_selection().clone(),
            source_authority: stable_plan.runtime_authority().clone(),
            source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: AgentProviderConversationPlanV1::resume("thread-1").unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 201,
        })
        .await
        .unwrap();
    let plan = preview_agent_dispatch_stop_v1(
        AgentDispatchStopPreviewV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("stop-transition-atomic").unwrap(),
            spawn_operation_id: spawn_receipt.operation_id.clone(),
            workspace_plan: AgentDispatchStopWorkspacePlanV1::Preserve,
            planned_at_ms: 220,
        },
        &spawn_receipt,
        stable_plan.runtime_selection().clone(),
        stable_plan.runtime_authority().clone(),
        Some(AgentDispatchStopRuntimeFenceV1::Transition {
            record: Box::new(transition.clone()),
        }),
    )
    .unwrap();
    let planned = store.plan_agent_dispatch_stop(&plan).await.unwrap();
    let request = authorize_request_for(&plan, "runtime-close-transition-atomic", 220);

    let mut stale = request.clone();
    stale.expected_journal_revision += 1;
    assert!(matches!(
        store.authorize_agent_dispatch_stop(&stale).await,
        Err(DomainStoreErrorV1::RevisionConflict { .. })
    ));
    assert_eq!(
        store
            .agent_runtime_transition(&transition.intent.operation_id)
            .await
            .unwrap(),
        Some(transition.clone()),
        "a rejected parent CAS must roll back transition convergence"
    );

    sqlx::query(
        r#"
        CREATE TRIGGER fail_transition_fenced_stop_authorize
        BEFORE UPDATE ON agent_dispatch_stops
        BEGIN
            SELECT RAISE(ABORT, 'injected transition-fenced authorization failure');
        END
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(matches!(
        store.authorize_agent_dispatch_stop(&request).await,
        Err(DomainStoreErrorV1::Storage { code: "sqlite", .. })
    ));
    assert_eq!(
        store
            .agent_runtime_transition(&transition.intent.operation_id)
            .await
            .unwrap(),
        Some(transition.clone())
    );
    assert!(
        store
            .agent_runtime_close(&request.runtime_close_intent.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .agent_dispatch_stop(plan.operation_id())
            .await
            .unwrap(),
        Some(planned)
    );

    sqlx::query("DROP TRIGGER fail_transition_fenced_stop_authorize")
        .execute(&store.pool)
        .await
        .unwrap();
    let (authorized, child) = store.authorize_agent_dispatch_stop(&request).await.unwrap();
    assert!(matches!(
        authorized.state(),
        AgentDispatchStopStateV1::Authorized { .. }
    ));
    assert_eq!(child.state, AgentRuntimeCloseStateV1::Admitted);
    assert_eq!(
        store
            .agent_runtime_transition(&transition.intent.operation_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::SourceRetained
    );
}

#[tokio::test]
async fn succeeded_stop_hydrates_and_exact_terminal_replay_converges() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let Fixture { store, plan, .. } = fixture(&path).await;
    store.plan_agent_dispatch_stop(&plan).await.unwrap();
    let (authorized, admitted) = store
        .authorize_agent_dispatch_stop(&authorize_request(&plan))
        .await
        .unwrap();
    let stopped = store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: 230,
        })
        .await
        .unwrap();
    let request = AgentDispatchStopTerminalRequestV1 {
        schema_version: 1,
        operation_id: plan.operation_id().clone(),
        plan_token: plan.plan_token().clone(),
        expected_journal_revision: authorized.journal_revision(),
        transition: AgentDispatchStopTerminalTransitionV1::Succeeded {
            runtime_close: Box::new(stopped.clone()),
            workspace: GitCheckoutRemovalReceiptV1 {
                schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                outcome: GitCheckoutRemovalOutcomeV1::Removed,
                instance: plan.owned_checkout().unwrap().instance.clone(),
            },
        },
        transitioned_at_ms: 240,
    };
    let terminal = store
        .terminalize_agent_dispatch_stop(&request)
        .await
        .unwrap();
    assert!(matches!(
        terminal.state(),
        AgentDispatchStopStateV1::Succeeded { .. }
    ));
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .agent_dispatch_stop(plan.operation_id())
            .await
            .unwrap(),
        Some(terminal.clone())
    );
    assert_eq!(
        reopened
            .agent_dispatch_stop_for_spawn_operation(&plan.spawn().operation_id)
            .await
            .unwrap(),
        Some(terminal.clone())
    );
    let replay = AgentDispatchStopTerminalRequestV1 {
        transition: AgentDispatchStopTerminalTransitionV1::Succeeded {
            runtime_close: Box::new(stopped),
            workspace: GitCheckoutRemovalReceiptV1 {
                schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                outcome: GitCheckoutRemovalOutcomeV1::AlreadyAbsent,
                instance: plan.owned_checkout().unwrap().instance.clone(),
            },
        },
        ..request
    };
    assert_eq!(
        reopened
            .terminalize_agent_dispatch_stop(&replay)
            .await
            .unwrap(),
        terminal,
        "a lost terminal response converges even when Git now reports already absent"
    );
    let terminal_child = reopened
        .agent_runtime_close(&OperationIdV1::new("runtime-close-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened
            .authorize_agent_dispatch_stop(&authorize_request(&plan))
            .await
            .unwrap(),
        (terminal, terminal_child),
        "an authorization replay after completion must hydrate the terminal parent"
    );
}

#[tokio::test]
async fn recovery_contains_only_authorized_parents_and_retained_terminal_hydrates() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let Fixture { store, plan, .. } = fixture(&path).await;
    store.plan_agent_dispatch_stop(&plan).await.unwrap();
    assert!(
        store
            .agent_dispatch_stop_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    let (authorized, admitted) = store
        .authorize_agent_dispatch_stop(&authorize_request(&plan))
        .await
        .unwrap();
    assert_eq!(
        store
            .agent_dispatch_stop_recovery_candidates()
            .await
            .unwrap(),
        vec![plan.agent_id().clone()]
    );
    let retained = store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::SourceRetained,
            advanced_at_ms: 230,
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .agent_dispatch_stop(plan.operation_id())
            .await
            .unwrap(),
        Some(authorized.clone()),
        "a terminal child must not implicitly terminalize its parent"
    );
    let terminal = store
        .terminalize_agent_dispatch_stop(&AgentDispatchStopTerminalRequestV1 {
            schema_version: 1,
            operation_id: plan.operation_id().clone(),
            plan_token: plan.plan_token().clone(),
            expected_journal_revision: authorized.journal_revision(),
            transition: AgentDispatchStopTerminalTransitionV1::SourceRetained {
                runtime_close: Box::new(retained),
            },
            transitioned_at_ms: 240,
        })
        .await
        .unwrap();
    assert!(matches!(
        terminal.state(),
        AgentDispatchStopStateV1::SourceRetained { .. }
    ));
    assert!(
        store
            .agent_dispatch_stop_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .active_agent_dispatch_stop(plan.agent_id())
            .await
            .unwrap()
            .is_none()
    );
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .agent_dispatch_stop(plan.operation_id())
            .await
            .unwrap(),
        Some(terminal)
    );
}

#[tokio::test]
async fn workspace_replaced_terminal_hydrates_from_the_exact_child() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let Fixture { store, plan, .. } = fixture(&path).await;
    store.plan_agent_dispatch_stop(&plan).await.unwrap();
    let (authorized, admitted) = store
        .authorize_agent_dispatch_stop(&authorize_request(&plan))
        .await
        .unwrap();
    let stopped = store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: 230,
        })
        .await
        .unwrap();
    let terminal = store
        .terminalize_agent_dispatch_stop(&AgentDispatchStopTerminalRequestV1 {
            schema_version: 1,
            operation_id: plan.operation_id().clone(),
            plan_token: plan.plan_token().clone(),
            expected_journal_revision: authorized.journal_revision(),
            transition: AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
                runtime_close: Box::new(stopped),
            },
            transitioned_at_ms: 240,
        })
        .await
        .unwrap();
    assert!(matches!(
        terminal.state(),
        AgentDispatchStopStateV1::WorkspaceReplaced { .. }
    ));
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .agent_dispatch_stop(plan.operation_id())
            .await
            .unwrap(),
        Some(terminal)
    );
}

#[tokio::test]
async fn active_attempt_is_unique_and_spawn_lookup_prefers_active_then_latest_terminal() {
    let temp_dir = TempDir::new().unwrap();
    let fixture = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let first = fixture
        .store
        .plan_agent_dispatch_stop(&fixture.plan)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .store
            .plan_agent_dispatch_stop(&fixture.plan)
            .await
            .unwrap(),
        first,
        "an exact plan replay must not create another row"
    );
    let second_plan = retry_plan(&fixture, "stop-2", 300);
    assert!(matches!(
        fixture.store.plan_agent_dispatch_stop(&second_plan).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    let first_terminal =
        terminalize_source_retained(&fixture.store, &fixture.plan, "runtime-close-1", 210).await;
    assert_eq!(
        fixture
            .store
            .agent_dispatch_stop_for_spawn_operation(&fixture.spawn_receipt.operation_id)
            .await
            .unwrap(),
        Some(first_terminal)
    );

    let second = fixture
        .store
        .plan_agent_dispatch_stop(&second_plan)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .store
            .agent_dispatch_stop_for_spawn_operation(&fixture.spawn_receipt.operation_id)
            .await
            .unwrap(),
        Some(second),
        "an active retry takes precedence over terminal history"
    );
    let second_terminal =
        terminalize_source_retained(&fixture.store, &second_plan, "runtime-close-2", 310).await;
    assert_eq!(
        fixture
            .store
            .agent_dispatch_stop_for_spawn_operation(&fixture.spawn_receipt.operation_id)
            .await
            .unwrap(),
        Some(second_terminal),
        "without an active attempt the newest terminal plan wins"
    );
}

#[tokio::test]
async fn non_current_runtime_selection_is_refused_without_reserving_an_attempt() {
    let temp_dir = TempDir::new().unwrap();
    let fixture = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let non_current = AgentRuntimeSelectionV1 {
        revision: 2,
        selected_by_operation_id: Some(OperationIdV1::new("runtime-transition-2").unwrap()),
        updated_at_ms: 100,
        ..fixture.plan.runtime_selection().clone()
    };
    let mismatched = plan_with(
        &fixture,
        "stop-non-current",
        300,
        non_current,
        fixture.plan.runtime_authority().clone(),
        fixture.plan.owned_checkout().unwrap().clone(),
    );

    assert!(matches!(
        fixture.store.plan_agent_dispatch_stop(&mismatched).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    fixture
        .store
        .plan_agent_dispatch_stop(&fixture.plan)
        .await
        .expect("a refused runtime mismatch must not reserve the active attempt");
}

#[tokio::test]
async fn non_current_runtime_authority_is_refused_without_reserving_an_attempt() {
    let temp_dir = TempDir::new().unwrap();
    let fixture = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { mut binding } =
        fixture.plan.runtime_authority().clone()
    else {
        unreachable!();
    };
    binding.runtime.runtime_generation = "runtime-2".into();
    let mismatched = plan_with(
        &fixture,
        "stop-non-current-authority",
        300,
        fixture.plan.runtime_selection().clone(),
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
        fixture.plan.owned_checkout().unwrap().clone(),
    );

    assert!(matches!(
        fixture.store.plan_agent_dispatch_stop(&mismatched).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    fixture
        .store
        .plan_agent_dispatch_stop(&fixture.plan)
        .await
        .expect("a refused authority mismatch must not reserve the active attempt");
}

#[tokio::test]
async fn checkout_from_another_workspace_is_refused_without_reserving_an_attempt() {
    let temp_dir = TempDir::new().unwrap();
    let fixture = fixture(&temp_dir.path().join("domain.sqlite")).await;
    fixture
        .store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-2").unwrap(),
            project_id: ProjectIdV1::new("project-1").unwrap(),
            root_path: "/repo/.worktrees/agent-2".into(),
            base_commit_sha: Some("a".repeat(40)),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
    let mut foreign_checkout = fixture.plan.owned_checkout().unwrap().clone();
    foreign_checkout.instance.canonical_path = "/repo/.worktrees/agent-2".into();
    foreign_checkout.instance.git_dir = "/repo/.git/worktrees/agent-2".into();
    let mismatched = plan_with(
        &fixture,
        "stop-foreign-checkout",
        300,
        fixture.plan.runtime_selection().clone(),
        fixture.plan.runtime_authority().clone(),
        foreign_checkout,
    );

    assert!(matches!(
        fixture.store.plan_agent_dispatch_stop(&mismatched).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    fixture
        .store
        .plan_agent_dispatch_stop(&fixture.plan)
        .await
        .expect("a refused checkout mismatch must not reserve the active attempt");
}

#[tokio::test]
async fn corrupt_frozen_input_is_refused_at_the_typed_reconstruction_boundary() {
    let temp_dir = TempDir::new().unwrap();
    let Fixture { store, plan, .. } = fixture(&temp_dir.path().join("domain.sqlite")).await;
    store.plan_agent_dispatch_stop(&plan).await.unwrap();
    sqlx::query("UPDATE agent_dispatch_stops SET runtime_selection_json = '{}'")
        .execute(&store.pool)
        .await
        .unwrap();

    assert!(matches!(
        store.agent_dispatch_stop(plan.operation_id()).await,
        Err(DomainStoreErrorV1::Storage {
            code: "serialization",
            ..
        })
    ));
}

async fn rewrite_current_stop_table_as_schema_34(store: &SqliteDomainStore) {
    for index in [
        "agent_dispatch_stops_active_agent_idx",
        "agent_dispatch_stops_active_spawn_idx",
        "agent_dispatch_stops_spawn_history_idx",
        "agent_dispatch_stops_recovery_idx",
    ] {
        sqlx::query(&format!("DROP INDEX {index}"))
            .execute(&store.pool)
            .await
            .unwrap();
    }
    sqlx::query("ALTER TABLE agent_dispatch_stops RENAME TO agent_dispatch_stops_v35_seed")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(crate::schema::CREATE_AGENT_DISPATCH_STOPS_V34)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO agent_dispatch_stops (
            operation_id, agent_id, spawn_operation_id, plan_token, state,
            journal_revision, runtime_selection_json, runtime_authority_json,
            owned_checkout_json, runtime_close_operation_id,
            terminal_workspace_receipt_json, planned_at_ms, authorized_at_ms,
            updated_at_ms
        )
        SELECT
            operation_id, agent_id, spawn_operation_id, plan_token, state,
            journal_revision, runtime_selection_json, runtime_authority_json,
            json_extract(workspace_action_json, '$.ownedCheckout'),
            runtime_close_operation_id, terminal_workspace_receipt_json,
            planned_at_ms, authorized_at_ms, updated_at_ms
        FROM agent_dispatch_stops_v35_seed
        WHERE json_extract(
            workspace_action_json,
            '$.workspaceDisposition'
        ) = 'remove_owned'
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query("DROP TABLE agent_dispatch_stops_v35_seed")
        .execute(&store.pool)
        .await
        .unwrap();
    for statement in [
        crate::schema::CREATE_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX,
        crate::schema::CREATE_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX,
        crate::schema::CREATE_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX,
        crate::schema::CREATE_AGENT_DISPATCH_STOPS_RECOVERY_INDEX,
    ] {
        sqlx::query(statement).execute(&store.pool).await.unwrap();
    }
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 34, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn schema_34_migration_preserves_every_legacy_stop_state_and_plan_token() {
    for target_state in [
        "planned",
        "superseded",
        "authorized",
        "succeeded",
        "source_retained",
        "workspace_replaced",
    ] {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join(format!("{target_state}.sqlite"));
        let fixture = fixture(&path).await;
        let planned = fixture
            .store
            .plan_agent_dispatch_stop(&fixture.plan)
            .await
            .unwrap();
        let expected = if target_state == "planned" {
            planned
        } else if target_state == "superseded" {
            let successor = replace_runtime_and_plan(&fixture, "stop-successor", 300).await;
            fixture
                .store
                .plan_agent_dispatch_stop(&successor)
                .await
                .unwrap();
            fixture
                .store
                .agent_dispatch_stop(fixture.plan.operation_id())
                .await
                .unwrap()
                .unwrap()
        } else {
            let (authorized, admitted) = fixture
                .store
                .authorize_agent_dispatch_stop(&authorize_request(&fixture.plan))
                .await
                .unwrap();
            if target_state == "authorized" {
                authorized
            } else if target_state == "source_retained" {
                let retained = fixture
                    .store
                    .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
                        schema_version: 1,
                        operation_id: admitted.intent.operation_id.clone(),
                        expected_journal_revision: admitted.journal_revision,
                        advance: AgentRuntimeCloseAdvanceV1::SourceRetained,
                        advanced_at_ms: 230,
                    })
                    .await
                    .unwrap();
                fixture
                    .store
                    .terminalize_agent_dispatch_stop(&AgentDispatchStopTerminalRequestV1 {
                        schema_version: 1,
                        operation_id: fixture.plan.operation_id().clone(),
                        plan_token: fixture.plan.plan_token().clone(),
                        expected_journal_revision: authorized.journal_revision(),
                        transition: AgentDispatchStopTerminalTransitionV1::SourceRetained {
                            runtime_close: Box::new(retained),
                        },
                        transitioned_at_ms: 240,
                    })
                    .await
                    .unwrap()
            } else {
                let stopped = fixture
                    .store
                    .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
                        schema_version: 1,
                        operation_id: admitted.intent.operation_id.clone(),
                        expected_journal_revision: admitted.journal_revision,
                        advance: AgentRuntimeCloseAdvanceV1::Stopped,
                        advanced_at_ms: 230,
                    })
                    .await
                    .unwrap();
                let transition = if target_state == "succeeded" {
                    AgentDispatchStopTerminalTransitionV1::Succeeded {
                        runtime_close: Box::new(stopped),
                        workspace: GitCheckoutRemovalReceiptV1 {
                            schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                            outcome: GitCheckoutRemovalOutcomeV1::Removed,
                            instance: fixture.plan.owned_checkout().unwrap().instance.clone(),
                        },
                    }
                } else {
                    assert_eq!(target_state, "workspace_replaced");
                    AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
                        runtime_close: Box::new(stopped),
                    }
                };
                fixture
                    .store
                    .terminalize_agent_dispatch_stop(&AgentDispatchStopTerminalRequestV1 {
                        schema_version: 1,
                        operation_id: fixture.plan.operation_id().clone(),
                        plan_token: fixture.plan.plan_token().clone(),
                        expected_journal_revision: authorized.journal_revision(),
                        transition,
                        transitioned_at_ms: 240,
                    })
                    .await
                    .unwrap()
            }
        };
        let legacy_token = fixture.plan.plan_token().as_str().to_string();
        rewrite_current_stop_table_as_schema_34(&fixture.store).await;
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT plan_token FROM agent_dispatch_stops WHERE operation_id = ?1",
            )
            .bind(fixture.plan.operation_id().as_str())
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap(),
            legacy_token,
        );
        fixture.store.close().await;

        let migrated = SqliteDomainStore::open(&path).await.unwrap();
        assert_eq!(
            migrated
                .agent_dispatch_stop(fixture.plan.operation_id())
                .await
                .unwrap(),
            Some(expected),
            "schema-34 {target_state} must rehydrate through its exact legacy plan",
        );
        let migrated_row: (String, String) = sqlx::query_as(
            "SELECT plan_token, workspace_action_json FROM agent_dispatch_stops WHERE operation_id = ?1",
        )
        .bind(fixture.plan.operation_id().as_str())
        .fetch_one(&migrated.pool)
        .await
        .unwrap();
        assert_eq!(migrated_row.0, legacy_token);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&migrated_row.1).unwrap()["workspaceDisposition"],
            "remove_owned",
        );
        let recovery = migrated
            .agent_dispatch_stop_recovery_candidates()
            .await
            .unwrap();
        assert_eq!(
            recovery == vec![fixture.plan.agent_id().clone()],
            target_state == "authorized",
        );
    }
}

#[tokio::test]
async fn schema_32_migrates_additively_to_dispatch_stop_storage() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    sqlx::query("DROP TABLE agent_dispatch_stops")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 32, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    let table: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_dispatch_stops'",
    )
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(table, 1);
}

#[tokio::test]
async fn schema_33_rebuild_preserves_rows_and_recreates_all_stop_indexes() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let fixture = fixture(&path).await;
    let planned = fixture
        .store
        .plan_agent_dispatch_stop(&fixture.plan)
        .await
        .unwrap();
    crate::migration_test_support::downgrade_dispatch_stop_fixture_to_v33(&fixture.store.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 33, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
    )
    .execute(&fixture.store.pool)
    .await
    .unwrap();
    fixture.store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    assert_eq!(
        migrated
            .agent_dispatch_stop(fixture.plan.operation_id())
            .await
            .unwrap(),
        Some(planned)
    );
    let table_sql: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_dispatch_stops'",
    )
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert!(table_sql.contains("'superseded'"));
    let index_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
              'agent_dispatch_stops_active_agent_idx',
              'agent_dispatch_stops_active_spawn_idx',
              'agent_dispatch_stops_spawn_history_idx',
              'agent_dispatch_stops_recovery_idx'
          )
        "#,
    )
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(index_count, 4);
}

#[tokio::test]
async fn workflow_only_schema_33_converges_to_dispatch_stop_storage() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    sqlx::query("DROP TABLE agent_dispatch_stops")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 33, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    let table: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_dispatch_stops'",
    )
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(table, 1);
}
