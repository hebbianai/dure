use super::*;
use crate::{
    AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1, AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
    AGENT_SPAWN_SCHEMA_VERSION_V1, AgentInteractionBindingV1, AgentInteractionSessionIdV1,
    AgentProviderConversationPlanV1, AgentProviderRuntimeFenceV1,
    AgentRuntimeCloseAdvanceRequestV1, AgentRuntimeCloseAdvanceV1, AgentRuntimeCloseIntentV1,
    AgentRuntimeSourceStopPolicyV1, AgentRuntimeTransitionIntentV1, AgentSpawnJournalStateV1,
    AgentSpawnLaunchPlanV1, AgentSpawnPlanDraftV1, AgentSpawnPreviewRequestV1,
    AgentSpawnRecoveryDirectiveV1, AgentSpawnStageDispositionV1, AgentSpawnStageEvidenceV1,
    AgentSpawnStageInputsV1, AgentSpawnStageReceiptV1, AgentSpawnStageV1,
    AgentSpawnWorktreePolicyV1, AgentTimelineEpochV1, GIT_CHECKOUT_SCHEMA_VERSION_V1,
    GitCheckoutInstanceV1, GitCheckoutRemovalOutcomeV1, GitCheckoutRemovalPolicyV1, ProjectIdV1,
    ProviderIdV1, ProviderPermissionModeV1, advance_agent_runtime_close_v1,
    create_agent_spawn_plan_v1,
};

#[derive(Clone)]
struct Fixture {
    preview: AgentDispatchStopPreviewV1,
    spawn: AgentSpawnJournalReceiptV1,
    selection: AgentRuntimeSelectionV1,
    authority: AgentRuntimeBindingAuthorityV1,
    checkout: GitCheckoutRemovalRequestV1,
}

fn fixture() -> Fixture {
    let agent_id = AgentIdV1::new("agent-1").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-1").unwrap();
    let spawn = create_agent_spawn_plan_v1(AgentSpawnPlanDraftV1 {
        schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
        operation_id: OperationIdV1::new("spawn-1").unwrap(),
        authority: AgentSpawnAuthorityV1 {
            backend_id: "backend-a".into(),
            backend_generation: "generation-1".into(),
            project_id: ProjectIdV1::new("dure").unwrap(),
            root_id: "root_0123456789abcdef0123456789abcdef".into(),
            repository_id: "repo_fedcba9876543210fedcba9876543210".into(),
        },
        request: AgentSpawnPreviewRequestV1 {
            schema_version: 1,
            idempotency_key: "request-1".into(),
            project_id: ProjectIdV1::new("dure").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            agent_name: "codex-1".into(),
            worktree: AgentSpawnWorktreePolicyV1::Dedicated {
                base_commit_sha: "a".repeat(40),
                branch: "agent/codex-1".into(),
                branch_mode: Default::default(),
                checkout_path: None,
            },
            provider_conversation_ref: Default::default(),
            permission_mode: ProviderPermissionModeV1::Default,
            prompt_digest: Some(crate::AgentSpawnPromptDigestV1::sha256("secret prompt")),
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
    let lease = AgentSpawnWorkspaceLeaseV1::for_dedicated(&workspace_id, "agent/codex-1").unwrap();
    let spawn = AgentSpawnJournalReceiptV1 {
        schema_version: 1,
        operation_id: spawn.operation_id.clone(),
        plan: spawn,
        state: AgentSpawnJournalStateV1::Succeeded,
        checkout_registration: None,
        last_sequence: 3,
        completed: vec![AgentSpawnStageReceiptV1 {
            stage: AgentSpawnStageV1::Worktree,
            attempt: 1,
            inputs: AgentSpawnStageInputsV1::Worktree {
                workspace_id: workspace_id.clone(),
                project_root_id: "root_0123456789abcdef0123456789abcdef".into(),
                repository_id: "repo_fedcba9876543210fedcba9876543210".into(),
                policy: AgentSpawnWorktreePolicyV1::Dedicated {
                    base_commit_sha: "a".repeat(40),
                    branch: "agent/codex-1".into(),
                    branch_mode: Default::default(),
                    checkout_path: None,
                },
            },
            evidence: AgentSpawnStageEvidenceV1::Worktree {
                workspace_id,
                disposition: AgentSpawnStageDispositionV1::CreatedDureOwned,
                lease: Some(lease),
            },
        }],
        recovery: AgentSpawnRecoveryDirectiveV1::None,
        terminal_code: None,
        created_at_ms: 1,
        updated_at_ms: 10,
    };
    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        agent_id: agent_id.clone(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("thread-1".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-1".into(),
            provider_epoch: "provider-1".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    Fixture {
        preview: AgentDispatchStopPreviewV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("stop-1").unwrap(),
            spawn_operation_id: OperationIdV1::new("spawn-1").unwrap(),
            workspace_plan: AgentDispatchStopWorkspacePlanV1::RemoveOwned {
                checkout: GitCheckoutRemovalRequestV1 {
                    repository_path: "/repo".into(),
                    instance: GitCheckoutInstanceV1 {
                        schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                        canonical_path: "/repo/.worktrees/codex-1".into(),
                        git_common_dir: "/repo/.git".into(),
                        git_dir: "/repo/.git/worktrees/codex-1".into(),
                        instance_token: "dwt1_0123456789abcdef0123456789abcdef".into(),
                    },
                    policy: GitCheckoutRemovalPolicyV1::RequireClean,
                },
            },
            planned_at_ms: 20,
        },
        spawn,
        selection: AgentRuntimeSelectionV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            agent_id,
            provider_id: ProviderIdV1::new("codex").unwrap(),
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        },
        authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
        checkout: GitCheckoutRemovalRequestV1 {
            repository_path: "/repo".into(),
            instance: GitCheckoutInstanceV1 {
                schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                canonical_path: "/repo/.worktrees/codex-1".into(),
                git_common_dir: "/repo/.git".into(),
                git_dir: "/repo/.git/worktrees/codex-1".into(),
                instance_token: "dwt1_0123456789abcdef0123456789abcdef".into(),
            },
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
    }
}

fn plan(fixture: &Fixture) -> AgentDispatchStopPlanV1 {
    let mut preview = fixture.preview.clone();
    preview.workspace_plan = AgentDispatchStopWorkspacePlanV1::RemoveOwned {
        checkout: fixture.checkout.clone(),
    };
    preview_agent_dispatch_stop_v1(
        preview,
        &fixture.spawn,
        fixture.selection.clone(),
        fixture.authority.clone(),
        None,
    )
    .unwrap()
}

#[test]
fn checkout_membership_is_part_of_both_stop_consents() {
    for workspace_plan in [
        AgentDispatchStopWorkspacePlanV1::Preserve,
        fixture().preview.workspace_plan,
    ] {
        let mut fixture = fixture();
        fixture.preview.workspace_plan = workspace_plan;
        let preview = |fixture: &Fixture| {
            preview_agent_dispatch_stop_v1(
                fixture.preview.clone(),
                &fixture.spawn,
                fixture.selection.clone(),
                fixture.authority.clone(),
                None,
            )
            .unwrap()
        };
        let legacy = preview(&fixture);
        fixture.spawn.checkout_registration = Some(GitCheckoutRegistrationV1 {
            repository_path: fixture.checkout.repository_path.clone(),
            instance: fixture.checkout.instance.clone(),
        });
        let registered = preview(&fixture);
        assert_ne!(registered.plan_token(), legacy.plan_token());
        fixture
            .spawn
            .checkout_registration
            .as_mut()
            .unwrap()
            .instance
            .instance_token = format!("dwt1_{}", "f".repeat(32));
        assert_ne!(preview(&fixture).plan_token(), registered.plan_token());
    }
}

fn close_intent(
    plan: &AgentDispatchStopPlanV1,
    operation: &str,
    at: i64,
) -> AgentRuntimeCloseIntentV1 {
    AgentRuntimeCloseIntentV1 {
        schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
        operation_id: OperationIdV1::new(operation).unwrap(),
        idempotency_key: format!("{operation}-key"),
        source: plan.runtime_selection.clone(),
        source_authority: plan.runtime_authority.clone(),
        stopped_transition: None,
        requested_at_ms: at,
    }
}

fn authorize(planned: &AgentDispatchStopRecordV1) -> AgentDispatchStopRecordV1 {
    let runtime_close_intent = close_intent(&planned.plan, "runtime-close-1", 30);
    let runtime_close = AgentRuntimeCloseRecordV1::admitted(runtime_close_intent.clone()).unwrap();
    authorize_agent_dispatch_stop_v1(
        planned,
        &AgentDispatchStopAuthorizeRequestV1 {
            schema_version: 1,
            operation_id: planned.plan.operation_id.clone(),
            plan_token: planned.plan.plan_token.clone(),
            expected_journal_revision: 1,
            runtime_close_intent,
            authorized_at_ms: 30,
        },
        &runtime_close,
    )
    .unwrap()
    .0
}

fn close(
    plan: &AgentDispatchStopPlanV1,
    outcome: AgentRuntimeCloseAdvanceV1,
) -> AgentRuntimeCloseRecordV1 {
    let admitted =
        AgentRuntimeCloseRecordV1::admitted(close_intent(plan, "runtime-close-1", 30)).unwrap();
    advance_agent_runtime_close_v1(
        &admitted,
        &AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: 1,
            advance: outcome,
            advanced_at_ms: 40,
        },
    )
    .unwrap()
}

fn terminal_request(
    record: &AgentDispatchStopRecordV1,
    transition: AgentDispatchStopTerminalTransitionV1,
) -> AgentDispatchStopTerminalRequestV1 {
    AgentDispatchStopTerminalRequestV1 {
        schema_version: 1,
        operation_id: record.plan.operation_id.clone(),
        plan_token: record.plan.plan_token.clone(),
        expected_journal_revision: record.journal_revision,
        transition,
        transitioned_at_ms: 50,
    }
}

fn assert_terminal_reconstructs(
    terminal: &AgentDispatchStopRecordV1,
    request: &AgentDispatchStopTerminalRequestV1,
) {
    let runtime_close = transition_runtime_close(&request.transition);
    let planned = AgentDispatchStopRecordV1::planned(terminal.plan.clone());
    let authorize_request = AgentDispatchStopAuthorizeRequestV1 {
        schema_version: 1,
        operation_id: planned.plan.operation_id.clone(),
        plan_token: planned.plan.plan_token.clone(),
        expected_journal_revision: 1,
        runtime_close_intent: runtime_close.intent.clone(),
        authorized_at_ms: runtime_close.created_at_ms,
    };
    let (authorized, _) =
        authorize_agent_dispatch_stop_v1(&planned, &authorize_request, runtime_close).unwrap();
    assert_eq!(
        terminalize_agent_dispatch_stop_v1(&authorized, request).unwrap(),
        *terminal
    );
    assert_eq!(
        authorize_agent_dispatch_stop_v1(terminal, &authorize_request, runtime_close)
            .unwrap()
            .0,
        *terminal
    );
}

#[test]
fn preview_is_deterministic_reconstructable_and_binds_workspace_disposition() {
    let fixture = fixture();
    let stop_plan = plan(&fixture);
    assert_eq!(stop_plan.planned_at_ms(), fixture.preview.planned_at_ms);
    assert_eq!(stop_plan.plan_token, plan(&fixture).plan_token);
    assert_eq!(
        stop_plan.plan_token.as_str(),
        "sha256:8d59f29150f443b2bea1cc6b3e63e1cfbf5b0a5bd148a7576fb7b1c504ea2c3e"
    );

    let mut changed = fixture.clone();
    changed.checkout.instance.instance_token = "dwt1_1123456789abcdef0123456789abcdef".into();
    assert_ne!(stop_plan.plan_token, plan(&changed).plan_token);
    let mut changed = fixture.clone();
    changed.checkout.policy = GitCheckoutRemovalPolicyV1::DiscardChanges;
    assert_ne!(stop_plan.plan_token, plan(&changed).plan_token);
    let mut changed = fixture.clone();
    changed.selection.updated_at_ms = 11;
    assert_ne!(stop_plan.plan_token, plan(&changed).plan_token);
    let mut changed = fixture.clone();
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } = &mut changed.authority
    else {
        unreachable!()
    };
    binding.runtime.runtime_generation = "runtime-2".into();
    assert_ne!(stop_plan.plan_token, plan(&changed).plan_token);

    let mut preserve_preview = fixture.preview.clone();
    preserve_preview.workspace_plan = AgentDispatchStopWorkspacePlanV1::Preserve;
    let preserve_plan = preview_agent_dispatch_stop_v1(
        preserve_preview,
        &fixture.spawn,
        fixture.selection.clone(),
        fixture.authority.clone(),
        None,
    )
    .unwrap();
    assert_ne!(stop_plan.plan_token(), preserve_plan.plan_token());
    assert_eq!(preserve_plan.owned_checkout(), None);

    let mut adopted = fixture.clone();
    let AgentSpawnStageEvidenceV1::Worktree {
        disposition, lease, ..
    } = &mut adopted.spawn.completed[0].evidence
    else {
        unreachable!()
    };
    *disposition = AgentSpawnStageDispositionV1::AdoptedExisting;
    *lease = None;
    let mut remove_owned = adopted.preview.clone();
    remove_owned.workspace_plan = AgentDispatchStopWorkspacePlanV1::RemoveOwned {
        checkout: adopted.checkout.clone(),
    };
    assert!(
        preview_agent_dispatch_stop_v1(
            remove_owned,
            &adopted.spawn,
            adopted.selection.clone(),
            adopted.authority.clone(),
            None,
        )
        .is_err()
    );

    let mut preserve = adopted.preview;
    preserve.workspace_plan = AgentDispatchStopWorkspacePlanV1::Preserve;
    let adopted_preserve = preview_agent_dispatch_stop_v1(
        preserve,
        &adopted.spawn,
        adopted.selection,
        adopted.authority,
        None,
    )
    .unwrap();
    assert!(adopted_preserve.workspace_plan().is_preserve());
    assert_ne!(stop_plan.plan_token(), adopted_preserve.plan_token());
}

#[test]
fn preview_rejects_a_plan_older_than_its_runtime_fence() {
    let fixture = fixture();
    let close = AgentRuntimeCloseRecordV1::admitted(AgentRuntimeCloseIntentV1 {
        schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
        operation_id: OperationIdV1::new("runtime-close-later").unwrap(),
        idempotency_key: "runtime-close-later-key".into(),
        source: fixture.selection.clone(),
        source_authority: fixture.authority.clone(),
        stopped_transition: None,
        requested_at_ms: 21,
    })
    .unwrap();
    let transition = AgentRuntimeTransitionRecordV1::admitted(AgentRuntimeTransitionIntentV1 {
        schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        operation_id: OperationIdV1::new("runtime-transition-later").unwrap(),
        idempotency_key: "runtime-transition-later-key".into(),
        source: fixture.selection.clone(),
        source_authority: fixture.authority.clone(),
        source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: AgentProviderConversationPlanV1::resume("thread-1").unwrap(),
        target_interaction_profile: AgentInteractionProfileV1::NativeCli,
        target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
        target_launch_selection: None,
        requested_at_ms: 21,
    })
    .unwrap();

    for fence in [
        AgentDispatchStopRuntimeFenceV1::Close {
            record: Box::new(close),
        },
        AgentDispatchStopRuntimeFenceV1::Transition {
            record: Box::new(transition),
        },
    ] {
        assert!(matches!(
            preview_agent_dispatch_stop_v1(
                fixture.preview.clone(),
                &fixture.spawn,
                fixture.selection.clone(),
                fixture.authority.clone(),
                Some(fence),
            ),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "plannedAtMs",
                ..
            })
        ));
    }
}

#[test]
fn planned_is_inert_and_authorization_is_exact_replayable_cas() {
    let fixture = fixture();
    let planned = AgentDispatchStopRecordV1::planned(plan(&fixture));
    assert!(!planned.effects_are_authorized());
    let runtime_close_intent = close_intent(&planned.plan, "runtime-close-1", 30);
    let runtime_close = AgentRuntimeCloseRecordV1::admitted(runtime_close_intent.clone()).unwrap();
    let request = AgentDispatchStopAuthorizeRequestV1 {
        schema_version: 1,
        operation_id: planned.plan.operation_id.clone(),
        plan_token: planned.plan.plan_token.clone(),
        expected_journal_revision: 1,
        runtime_close_intent,
        authorized_at_ms: 30,
    };
    let (authorized, admitted) =
        authorize_agent_dispatch_stop_v1(&planned, &request, &runtime_close).unwrap();
    assert!(authorized.effects_are_authorized());
    assert!(matches!(
        authorized.state,
        AgentDispatchStopStateV1::Authorized {
            ref runtime_close_operation_id
        } if runtime_close_operation_id == &admitted.intent.operation_id
    ));
    assert_eq!(admitted, runtime_close);
    assert_eq!(
        authorize_agent_dispatch_stop_v1(&authorized, &request, &admitted)
            .unwrap()
            .0,
        authorized
    );

    let mut later_replay = request.clone();
    later_replay.authorized_at_ms = 31;
    assert_eq!(
        authorize_agent_dispatch_stop_v1(&authorized, &later_replay, &admitted)
            .unwrap()
            .0,
        authorized
    );
    let mut wrong_revision = request;
    wrong_revision.expected_journal_revision = 7;
    assert!(matches!(
        authorize_agent_dispatch_stop_v1(&authorized, &wrong_revision, &admitted),
        Err(DomainStoreErrorV1::RevisionConflict { .. })
    ));

    let planned = AgentDispatchStopRecordV1::planned(plan(&fixture));
    let stopped = close(&planned.plan, AgentRuntimeCloseAdvanceV1::Stopped);
    let (_, reused) = authorize_agent_dispatch_stop_v1(
        &planned,
        &AgentDispatchStopAuthorizeRequestV1 {
            schema_version: 1,
            operation_id: planned.plan.operation_id.clone(),
            plan_token: planned.plan.plan_token.clone(),
            expected_journal_revision: 1,
            runtime_close_intent: stopped.intent.clone(),
            authorized_at_ms: 40,
        },
        &stopped,
    )
    .unwrap();
    assert_eq!(reused, stopped);
}

#[test]
fn only_a_different_exact_runtime_plan_can_supersede_planned() {
    let fixture = fixture();
    let planned = AgentDispatchStopRecordV1::planned(plan(&fixture));

    let mut same_runtime = fixture.clone();
    same_runtime.preview.operation_id = OperationIdV1::new("stop-same-runtime").unwrap();
    same_runtime.preview.planned_at_ms = 21;
    assert!(matches!(
        supersede_agent_dispatch_stop_v1(&planned, &plan(&same_runtime)),
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));

    let mut successor = same_runtime;
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } = &mut successor.authority
    else {
        unreachable!()
    };
    binding.runtime.runtime_generation = "runtime-2".into();
    binding.runtime.provider_epoch = "provider-2".into();
    binding.binding_revision = 2;
    binding.updated_at_ms = 21;
    let successor = plan(&successor);
    let superseded = supersede_agent_dispatch_stop_v1(&planned, &successor).unwrap();

    assert_eq!(superseded.state, AgentDispatchStopStateV1::Superseded);
    assert_eq!(superseded.journal_revision, 2);
    assert_eq!(superseded.updated_at_ms, successor.planned_at_ms());
    assert!(!superseded.effects_are_authorized());
    assert!(superseded.workspace_was_preserved());
    assert!(!superseded.projection_is_finalizable());
    assert_eq!(
        replay_superseded_agent_dispatch_stop_v1(&planned, superseded.updated_at_ms).unwrap(),
        superseded
    );
    assert!(matches!(
        supersede_agent_dispatch_stop_v1(&authorize(&planned), &successor),
        Err(DomainStoreErrorV1::InvalidEventStream { .. })
    ));
}

#[test]
fn clock_regression_does_not_block_exact_supersession() {
    let mut stale = fixture();
    stale.preview.planned_at_ms = 30;
    let planned = AgentDispatchStopRecordV1::planned(plan(&stale));
    let mut successor = stale;
    successor.preview.operation_id = OperationIdV1::new("stop-clock-regression").unwrap();
    successor.preview.planned_at_ms = 21;
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } = &mut successor.authority
    else {
        unreachable!()
    };
    binding.runtime.runtime_generation = "runtime-2".into();
    binding.runtime.provider_epoch = "provider-2".into();
    binding.binding_revision = 2;
    binding.updated_at_ms = 21;

    let superseded = supersede_agent_dispatch_stop_v1(&planned, &plan(&successor)).unwrap();

    assert_eq!(superseded.state, AgentDispatchStopStateV1::Superseded);
    assert_eq!(superseded.updated_at_ms, 30);
    assert_eq!(superseded.journal_revision, 2);
}

#[test]
fn authorization_requires_the_actual_child_to_match_the_requested_intent() {
    let fixture = fixture();
    let planned = AgentDispatchStopRecordV1::planned(plan(&fixture));
    let requested = close_intent(&planned.plan, "runtime-close-1", 30);
    let actual =
        AgentRuntimeCloseRecordV1::admitted(close_intent(&planned.plan, "runtime-close-2", 30))
            .unwrap();
    let request = AgentDispatchStopAuthorizeRequestV1 {
        schema_version: 1,
        operation_id: planned.plan.operation_id.clone(),
        plan_token: planned.plan.plan_token.clone(),
        expected_journal_revision: 1,
        runtime_close_intent: requested,
        authorized_at_ms: 30,
    };

    assert!(matches!(
        authorize_agent_dispatch_stop_v1(&planned, &request, &actual),
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[test]
fn success_requires_exact_proofs_and_converges_after_lost_removal_response() {
    let fixture = fixture();
    let authorized = authorize(&AgentDispatchStopRecordV1::planned(plan(&fixture)));
    let workspace = GitCheckoutRemovalReceiptV1 {
        schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
        outcome: GitCheckoutRemovalOutcomeV1::Removed,
        instance: authorized.plan.owned_checkout().unwrap().instance.clone(),
    };
    let request = terminal_request(
        &authorized,
        AgentDispatchStopTerminalTransitionV1::Succeeded {
            runtime_close: Box::new(close(&authorized.plan, AgentRuntimeCloseAdvanceV1::Stopped)),
            workspace: workspace.clone(),
        },
    );
    let succeeded = terminalize_agent_dispatch_stop_v1(&authorized, &request).unwrap();
    assert!(matches!(
        succeeded.state,
        AgentDispatchStopStateV1::Succeeded { .. }
    ));
    assert!(succeeded.projection_is_finalizable());
    assert_eq!(
        terminalize_agent_dispatch_stop_v1(&succeeded, &request).unwrap(),
        succeeded
    );
    let mut absent_retry = request.clone();
    let AgentDispatchStopTerminalTransitionV1::Succeeded {
        workspace: retry_workspace,
        ..
    } = &mut absent_retry.transition
    else {
        unreachable!()
    };
    retry_workspace.outcome = GitCheckoutRemovalOutcomeV1::AlreadyAbsent;
    absent_retry.transitioned_at_ms = 60;
    assert_eq!(
        terminalize_agent_dispatch_stop_v1(&succeeded, &absent_retry).unwrap(),
        succeeded
    );

    let mut wrong_workspace = workspace;
    wrong_workspace.instance.instance_token = "dwt1_1123456789abcdef0123456789abcdef".into();
    assert!(
        terminalize_agent_dispatch_stop_v1(
            &authorized,
            &terminal_request(
                &authorized,
                AgentDispatchStopTerminalTransitionV1::Succeeded {
                    runtime_close: Box::new(close(
                        &authorized.plan,
                        AgentRuntimeCloseAdvanceV1::Stopped,
                    )),
                    workspace: wrong_workspace,
                },
            ),
        )
        .is_err()
    );

    let mut wrong_token = terminal_request(
        &authorized,
        AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
            runtime_close: Box::new(close(&authorized.plan, AgentRuntimeCloseAdvanceV1::Stopped)),
        },
    );
    wrong_token.plan_token = AgentDispatchStopPlanTokenV1(
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into(),
    );
    assert!(matches!(
        terminalize_agent_dispatch_stop_v1(&authorized, &wrong_token),
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[test]
fn preserve_finishes_from_only_the_exact_runtime_close_and_refuses_checkout_outcomes() {
    let fixture = fixture();
    let mut preview = fixture.preview.clone();
    preview.workspace_plan = AgentDispatchStopWorkspacePlanV1::Preserve;
    let preserve_plan = preview_agent_dispatch_stop_v1(
        preview,
        &fixture.spawn,
        fixture.selection,
        fixture.authority,
        None,
    )
    .unwrap();
    let authorized = authorize(&AgentDispatchStopRecordV1::planned(preserve_plan));
    let stopped = close(&authorized.plan, AgentRuntimeCloseAdvanceV1::Stopped);
    let preserved_request = terminal_request(
        &authorized,
        AgentDispatchStopTerminalTransitionV1::Preserved {
            runtime_close: Box::new(stopped.clone()),
        },
    );
    let preserved = terminalize_agent_dispatch_stop_v1(&authorized, &preserved_request).unwrap();

    assert!(matches!(
        preserved.state(),
        AgentDispatchStopStateV1::WorkspacePreserved { .. }
    ));
    assert!(preserved.workspace_was_preserved());
    assert!(preserved.projection_is_finalizable());
    assert_terminal_reconstructs(&preserved, &preserved_request);

    assert!(
        terminalize_agent_dispatch_stop_v1(
            &authorized,
            &terminal_request(
                &authorized,
                AgentDispatchStopTerminalTransitionV1::Succeeded {
                    runtime_close: Box::new(stopped.clone()),
                    workspace: GitCheckoutRemovalReceiptV1 {
                        schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                        outcome: GitCheckoutRemovalOutcomeV1::Removed,
                        instance: fixture.checkout.instance,
                    },
                },
            ),
        )
        .is_err()
    );
    assert!(
        terminalize_agent_dispatch_stop_v1(
            &authorized,
            &terminal_request(
                &authorized,
                AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
                    runtime_close: Box::new(stopped),
                },
            ),
        )
        .is_err()
    );
}

#[test]
fn success_rejects_non_v1_checkout_receipt_schemas() {
    let fixture = fixture();
    let authorized = authorize(&AgentDispatchStopRecordV1::planned(plan(&fixture)));
    let runtime_close = close(&authorized.plan, AgentRuntimeCloseAdvanceV1::Stopped);
    let workspace = GitCheckoutRemovalReceiptV1 {
        schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
        outcome: GitCheckoutRemovalOutcomeV1::Removed,
        instance: authorized.plan.owned_checkout().unwrap().instance.clone(),
    };

    let mut receipt_schema_changed = workspace.clone();
    receipt_schema_changed.schema_version += 1;
    let result = terminalize_agent_dispatch_stop_v1(
        &authorized,
        &terminal_request(
            &authorized,
            AgentDispatchStopTerminalTransitionV1::Succeeded {
                runtime_close: Box::new(runtime_close.clone()),
                workspace: receipt_schema_changed,
            },
        ),
    );
    assert!(matches!(
        result,
        Err(DomainStoreErrorV1::InvalidRecord {
            field: "workspace.schemaVersion",
            ..
        })
    ));

    let mut instance_schema_changed = workspace;
    instance_schema_changed.instance.schema_version += 1;
    let result = terminalize_agent_dispatch_stop_v1(
        &authorized,
        &terminal_request(
            &authorized,
            AgentDispatchStopTerminalTransitionV1::Succeeded {
                runtime_close: Box::new(runtime_close),
                workspace: instance_schema_changed,
            },
        ),
    );
    assert!(matches!(
        result,
        Err(DomainStoreErrorV1::InvalidRecord {
            field: "workspace.instance.schemaVersion",
            ..
        })
    ));
}

#[test]
fn every_terminal_state_reconstructs_and_authorize_replay_converges() {
    let fixture = fixture();

    let authorized = authorize(&AgentDispatchStopRecordV1::planned(plan(&fixture)));
    let succeeded_request = terminal_request(
        &authorized,
        AgentDispatchStopTerminalTransitionV1::Succeeded {
            runtime_close: Box::new(close(&authorized.plan, AgentRuntimeCloseAdvanceV1::Stopped)),
            workspace: GitCheckoutRemovalReceiptV1 {
                schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                outcome: GitCheckoutRemovalOutcomeV1::Removed,
                instance: authorized.plan.owned_checkout().unwrap().instance.clone(),
            },
        },
    );
    let succeeded = terminalize_agent_dispatch_stop_v1(&authorized, &succeeded_request).unwrap();
    assert_terminal_reconstructs(&succeeded, &succeeded_request);

    let authorized = authorize(&AgentDispatchStopRecordV1::planned(plan(&fixture)));
    let retained_request = terminal_request(
        &authorized,
        AgentDispatchStopTerminalTransitionV1::SourceRetained {
            runtime_close: Box::new(close(
                &authorized.plan,
                AgentRuntimeCloseAdvanceV1::SourceRetained,
            )),
        },
    );
    let retained = terminalize_agent_dispatch_stop_v1(&authorized, &retained_request).unwrap();
    assert_terminal_reconstructs(&retained, &retained_request);

    let authorized = authorize(&AgentDispatchStopRecordV1::planned(plan(&fixture)));
    let replaced_request = terminal_request(
        &authorized,
        AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
            runtime_close: Box::new(close(&authorized.plan, AgentRuntimeCloseAdvanceV1::Stopped)),
        },
    );
    let replaced = terminalize_agent_dispatch_stop_v1(&authorized, &replaced_request).unwrap();
    assert_terminal_reconstructs(&replaced, &replaced_request);
}

#[test]
fn retained_source_and_replaced_checkout_preserve_without_retryable_failures() {
    let fixture = fixture();
    let authorized = authorize(&AgentDispatchStopRecordV1::planned(plan(&fixture)));
    let retained = terminalize_agent_dispatch_stop_v1(
        &authorized,
        &terminal_request(
            &authorized,
            AgentDispatchStopTerminalTransitionV1::SourceRetained {
                runtime_close: Box::new(close(
                    &authorized.plan,
                    AgentRuntimeCloseAdvanceV1::SourceRetained,
                )),
            },
        ),
    )
    .unwrap();
    assert!(retained.workspace_was_preserved());
    assert!(!retained.projection_is_finalizable());

    let authorized = authorize(&AgentDispatchStopRecordV1::planned(plan(&fixture)));
    let replaced = terminalize_agent_dispatch_stop_v1(
        &authorized,
        &terminal_request(
            &authorized,
            AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
                runtime_close: Box::new(close(
                    &authorized.plan,
                    AgentRuntimeCloseAdvanceV1::Stopped,
                )),
            },
        ),
    )
    .unwrap();
    assert!(matches!(
        replaced.state,
        AgentDispatchStopStateV1::WorkspaceReplaced { .. }
    ));
    assert!(replaced.workspace_was_preserved());
    assert!(replaced.projection_is_finalizable());
}

#[test]
fn terminal_transition_rejects_pre_authorization_and_another_child_attempt() {
    let fixture = fixture();
    let planned = AgentDispatchStopRecordV1::planned(plan(&fixture));
    let retained = AgentDispatchStopTerminalTransitionV1::SourceRetained {
        runtime_close: Box::new(close(
            &planned.plan,
            AgentRuntimeCloseAdvanceV1::SourceRetained,
        )),
    };
    assert!(
        terminalize_agent_dispatch_stop_v1(&planned, &terminal_request(&planned, retained),)
            .is_err()
    );

    let authorized = authorize(&planned);
    let mut another = close(&authorized.plan, AgentRuntimeCloseAdvanceV1::Stopped);
    another.intent.operation_id = OperationIdV1::new("runtime-close-2").unwrap();
    assert!(
        terminalize_agent_dispatch_stop_v1(
            &authorized,
            &terminal_request(
                &authorized,
                AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
                    runtime_close: Box::new(another),
                },
            ),
        )
        .is_err()
    );
}
