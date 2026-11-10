use super::*;

async fn move_plan(store: &SqliteDomainStore) -> AgentRuntimeTransitionIntentV1 {
    let mut plan = intent("move-project", "move-project-key");
    plan.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
    let source_agent = store.agent(&plan.source.agent_id).await.unwrap().unwrap();
    let source_workspace = store
        .workspace(&source_agent.workspace_id)
        .await
        .unwrap()
        .unwrap();
    plan.workspace_move = Some(dure_app::AgentRuntimeWorkspaceMoveV1 {
        source_agent,
        source_workspace,
        source_checkout: None,
        target_project: ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-2").unwrap(),
            root_path: "/workspace/other".into(),
            display_name: "Other".into(),
            created_at_ms: 110,
            updated_at_ms: 110,
        },
        target_workspace: WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-2").unwrap(),
            project_id: ProjectIdV1::new("project-2").unwrap(),
            root_path: "/workspace/other".into(),
            base_commit_sha: None,
            created_at_ms: 110,
            updated_at_ms: 110,
        },
        registered_root_id: "root-2".into(),
        observed_root_id: "observed-root-2".into(),
        registered_repository_id: "repository-2".into(),
    });
    plan
}

async fn start_target(store: &SqliteDomainStore, plan: &AgentRuntimeTransitionIntentV1) {
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let identity = dure_app::agent_runtime_native_launch_identity_v1(&plan.operation_id);
    let AgentRuntimeBindingAuthorityV1::NativeCli { mut authority } = native_authority() else {
        panic!()
    };
    authority.binding.session_id = identity.session_id;
    authority.binding.binding_generation += 1;
    authority.binding.bound_at_ms = 130;
    authority.runtime_workspace_id = "workspace-2".into();
    authority.host_instance_id = "host-2".into();
    authority.terminal_epoch = "terminal-2".into();
    authority.updated_at_ms = 130;
    store
        .upsert_agent_checkpoint_binding_authority(&authority)
        .await
        .unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                workspace: None,
                authority: Box::new(AgentRuntimeBindingAuthorityV1::NativeCli { authority }),
                launch_idempotency_key: Some(identity.launch_idempotency_key),
            },
            130,
        ))
        .await
        .unwrap();
}

#[tokio::test]
async fn workspace_move_publishes_only_with_runtime_commit_and_replays_after_reopen() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = move_plan(&store).await;
    let movement = plan.workspace_move.as_ref().unwrap();
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    start_target(&store, &plan).await;
    assert_eq!(
        store.agent(&plan.source.agent_id).await.unwrap(),
        Some(movement.source_agent.clone())
    );
    let request = advance(
        &plan.operation_id,
        3,
        AgentRuntimeTransitionAdvanceV1::Committed,
        140,
    );
    let committed = store
        .advance_agent_runtime_transition(&request)
        .await
        .unwrap();
    assert_eq!(
        store
            .agent(&plan.source.agent_id)
            .await
            .unwrap()
            .unwrap()
            .workspace_id,
        movement.target_workspace.workspace_id
    );
    assert_eq!(
        store
            .workspace(&movement.source_workspace.workspace_id)
            .await
            .unwrap(),
        Some(movement.source_workspace.clone())
    );
    assert_eq!(
        store
            .agent_runtime_selection(&plan.source.agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        2
    );
    drop(store);
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .admit_agent_runtime_transition(&plan)
            .await
            .unwrap(),
        committed
    );
    assert_eq!(
        reopened
            .advance_agent_runtime_transition(&request)
            .await
            .unwrap(),
        committed
    );
    assert_eq!(
        reopened
            .agent(&plan.source.agent_id)
            .await
            .unwrap()
            .unwrap()
            .workspace_id,
        movement.target_workspace.workspace_id
    );
}

#[tokio::test]
async fn workspace_move_commit_failure_rolls_back_workspace_and_selection_together() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = move_plan(&store).await;
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    start_target(&store, &plan).await;
    sqlx::query("CREATE TRIGGER fail_move_commit BEFORE UPDATE ON agent_runtime_transitions WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END")
        .execute(&store.pool).await.unwrap();
    assert!(
        store
            .advance_agent_runtime_transition(&advance(
                &plan.operation_id,
                3,
                AgentRuntimeTransitionAdvanceV1::Committed,
                140
            ))
            .await
            .is_err()
    );
    assert_eq!(
        store.agent(&plan.source.agent_id).await.unwrap(),
        Some(plan.workspace_move.as_ref().unwrap().source_agent.clone())
    );
    assert_eq!(
        store
            .agent_runtime_selection(&plan.source.agent_id)
            .await
            .unwrap(),
        Some(plan.source.clone())
    );
    assert_eq!(
        store
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::TargetStarted
    );
}

#[tokio::test]
async fn workspace_move_rejects_a_source_or_destination_changed_after_preview() {
    for target_changed in [false, true] {
        let root = TempDir::new().unwrap();
        let store = initialized_store(&database_path(&root)).await;
        store
            .initialize_agent_runtime_selection(&native_selection())
            .await
            .unwrap();
        let plan = move_plan(&store).await;
        let movement = plan.workspace_move.as_ref().unwrap();
        if target_changed {
            let mut target = movement.target_project.clone();
            target.root_path = "/workspace/replaced".into();
            store.upsert_project(&target).await.unwrap();
        } else {
            let mut source = movement.source_workspace.clone();
            source.root_path = "/workspace/replaced".into();
            source.updated_at_ms += 1;
            store.upsert_workspace(&source).await.unwrap();
        }
        assert!(store.admit_agent_runtime_transition(&plan).await.is_err());
        assert!(
            store
                .agent_runtime_transition(&plan.operation_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .workspace(&movement.target_workspace.workspace_id)
                .await
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test]
async fn workspace_move_retains_the_original_checkout_claim_across_commit_and_reconnect() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    let selection = native_selection();
    store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let checkout = super::checkout_handoff::checkout();
    store.prepare_session_checkout(&checkout).await.unwrap();
    let retained = store
        .adopt_agent_runtime_checkout(&selection, &native_authority(), &checkout)
        .await
        .unwrap()
        .unwrap();
    let mut plan = move_plan(&store).await;
    plan.workspace_move.as_mut().unwrap().source_checkout = Some(retained.binding.clone());
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    start_target(&store, &plan).await;
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            3,
            AgentRuntimeTransitionAdvanceV1::Committed,
            140,
        ))
        .await
        .unwrap();
    assert_eq!(
        store
            .agent_runtime_checkout(&selection.agent_id)
            .await
            .unwrap(),
        Some(retained.clone())
    );
    assert_ne!(
        retained.binding.working_directory,
        plan.workspace_move
            .as_ref()
            .unwrap()
            .target_workspace
            .root_path
    );
    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .agent_runtime_checkout(&selection.agent_id)
            .await
            .unwrap(),
        Some(retained)
    );
}

#[tokio::test]
async fn workspace_move_refuses_a_changed_or_closing_checkout_at_admission_and_commit() {
    for after_start in [false, true] {
        for closing in [false, true] {
            let root = TempDir::new().unwrap();
            let store = initialized_store(&database_path(&root)).await;
            let selection = native_selection();
            store
                .initialize_agent_runtime_selection(&selection)
                .await
                .unwrap();
            let checkout = super::checkout_handoff::checkout();
            store.prepare_session_checkout(&checkout).await.unwrap();
            let retained = store
                .adopt_agent_runtime_checkout(&selection, &native_authority(), &checkout)
                .await
                .unwrap()
                .unwrap();
            let mut plan = move_plan(&store).await;
            plan.workspace_move.as_mut().unwrap().source_checkout = Some(retained.binding.clone());
            if after_start {
                store.admit_agent_runtime_transition(&plan).await.unwrap();
                start_target(&store, &plan).await;
            }
            if closing {
                store
                    .begin_session_checkout_close(&retained.binding.identity)
                    .await
                    .unwrap();
            } else {
                // Simulate an independently changed registration while keeping
                // the Agent and selected runtime records unchanged.
                sqlx::query("UPDATE agents SET checkout_owner_id = NULL WHERE agent_id = ?1")
                    .bind(selection.agent_id.as_str())
                    .execute(&store.pool)
                    .await
                    .unwrap();
            }
            if after_start {
                assert!(
                    store
                        .advance_agent_runtime_transition(&advance(
                            &plan.operation_id,
                            3,
                            AgentRuntimeTransitionAdvanceV1::Committed,
                            140
                        ))
                        .await
                        .is_err()
                );
            } else {
                assert!(store.admit_agent_runtime_transition(&plan).await.is_err());
            }
            assert_eq!(
                store
                    .agent(&selection.agent_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .workspace_id,
                plan.workspace_move
                    .as_ref()
                    .unwrap()
                    .source_workspace
                    .workspace_id
            );
        }
    }
}

async fn structured_move_target(
    store: &SqliteDomainStore,
) -> (
    AgentRuntimeTransitionIntentV1,
    AgentRuntimeBindingAuthorityV1,
) {
    let mut plan = move_plan(store).await;
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { mut binding } = structured_authority()
    else {
        panic!()
    };
    binding.created_at_ms = 90;
    binding.updated_at_ms = 100;
    plan.source.interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
    plan.target_interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
    plan.source_authority = AgentRuntimeBindingAuthorityV1::StructuredProtocol {
        binding: binding.clone(),
    };
    store.create_agent_interaction(&binding).await.unwrap();
    store
        .initialize_agent_runtime_selection(&plan.source)
        .await
        .unwrap();
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let target = store
        .replace_agent_interaction_runtime(&dure_app::AgentRuntimeReplacementV1 {
            schema_version: 1,
            interaction_session_id: binding.interaction_session_id,
            expected_binding_revision: binding.binding_revision,
            source: binding.runtime,
            source_execution_profile: binding.execution_profile.clone(),
            target: AgentProviderRuntimeFenceV1 {
                runtime_generation: "moved-runtime".into(),
                provider_epoch: "moved-epoch".into(),
            },
            target_execution_profile: binding.execution_profile,
            provider_conversation_ref: binding.provider_conversation_ref,
            replaced_at_ms: 130,
        })
        .await
        .unwrap();
    (
        plan,
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: target },
    )
}

#[tokio::test]
async fn structured_workspace_move_requires_exact_target_placement_and_reopens_atomically() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    let (plan, authority) = structured_move_target(&store).await;
    let movement = plan.workspace_move.as_ref().unwrap();
    for workspace in [None, Some(movement.source_workspace.clone())] {
        assert!(
            store
                .advance_agent_runtime_transition(&advance(
                    &plan.operation_id,
                    2,
                    AgentRuntimeTransitionAdvanceV1::TargetStarted {
                        authority: Box::new(authority.clone()),
                        launch_idempotency_key: None,
                        workspace
                    },
                    130
                ))
                .await
                .is_err()
        );
        assert_eq!(
            store.agent(&plan.source.agent_id).await.unwrap(),
            Some(movement.source_agent.clone())
        );
    }
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                authority: Box::new(authority),
                launch_idempotency_key: None,
                workspace: Some(movement.target_workspace.clone()),
            },
            130,
        ))
        .await
        .unwrap();
    let committed = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            3,
            AgentRuntimeTransitionAdvanceV1::Committed,
            140,
        ))
        .await
        .unwrap();
    assert_eq!(
        store
            .agent(&plan.source.agent_id)
            .await
            .unwrap()
            .unwrap()
            .workspace_id,
        movement.target_workspace.workspace_id
    );
    drop(store);
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap(),
        Some(committed.clone())
    );
    assert_eq!(
        committed.target_workspace,
        Some(movement.target_workspace.clone())
    );
    assert_eq!(
        reopened
            .agent_runtime_selection(&plan.source.agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        plan.source.revision + 1
    );
}

#[tokio::test]
async fn structured_workspace_move_transfers_failed_placement_to_source_folder_repair() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let (plan, authority) = structured_move_target(&store).await;
    let movement = plan.workspace_move.as_ref().unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                authority: Box::new(authority.clone()),
                launch_idempotency_key: None,
                workspace: Some(movement.target_workspace.clone()),
            },
            130,
        ))
        .await
        .unwrap();
    let failure = AgentRuntimeTargetFailureV1 {
        kind: AgentRuntimeTargetFailureKindV1::TargetInvalid,
        provider_code: "destination_changed".into(),
    };
    let replacement_authority = AgentRuntimeReplacementAuthorityUpdateV1::Replace {
        authority: Some(Box::new(dure_app::AgentRuntimeReplacementAuthorityV1(
            authority,
        ))),
    };
    // Dropping a failed target's placement would make later cleanup ambiguous.
    assert!(
        store
            .advance_agent_runtime_transition(&advance(
                &plan.operation_id,
                3,
                AgentRuntimeTransitionAdvanceV1::RepairRequired {
                    failure: failure.clone(),
                    replacement_authority: replacement_authority.clone(),
                    replacement_workspace: None
                },
                140
            ))
            .await
            .is_err()
    );
    let failed = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            3,
            AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure,
                replacement_authority,
                replacement_workspace: Some(movement.target_workspace.clone()),
            },
            140,
        ))
        .await
        .unwrap();
    let mut successor_intent = plan.clone();
    successor_intent.operation_id = OperationIdV1::new("restore-source").unwrap();
    successor_intent.idempotency_key = "restore-source-key".into();
    successor_intent.workspace_move = None;
    successor_intent.requested_at_ms = 150;
    let result = store
        .supersede_agent_runtime_transition(&AgentRuntimeTransitionSupersedeRequestV1 {
            schema_version: 1,
            operation_id: plan.operation_id.clone(),
            expected_journal_revision: failed.journal_revision,
            successor_intent,
            superseded_at_ms: 150,
        })
        .await
        .unwrap();
    let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(successor) = result else {
        panic!()
    };
    assert_eq!(
        successor.replacement_workspace,
        Some(movement.target_workspace.clone())
    );
    assert!(successor.target_workspace.is_none());
    assert!(successor.intent.workspace_move.is_none());
    let superseded = store
        .agent_runtime_transition(&plan.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert!(superseded.replacement_workspace.is_none());
    assert!(superseded.replacement_authority.is_none());
    assert_eq!(
        store.agent(&plan.source.agent_id).await.unwrap(),
        Some(movement.source_agent.clone())
    );
}

#[tokio::test]
async fn schema_52_upgrade_preserves_legacy_move_and_fences_old_journal_readers() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    let plan = move_plan(&store).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let record = store.admit_agent_runtime_transition(&plan).await.unwrap();
    let before: String = sqlx::query_scalar(
        "SELECT record_json FROM agent_runtime_transitions WHERE operation_id = ?1",
    )
    .bind(plan.operation_id.as_str())
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(
        serde_json::from_str::<serde_json::Value>(&before)
            .unwrap()
            .get("targetWorkspace")
            .is_none()
    );
    assert!(!before.contains("replacementWorkspace"));
    sqlx::query(
        "UPDATE store_metadata SET schema_version=52, min_reader_version=1, min_writer_version=1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;
    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap(),
        Some(record)
    );
    let after: String = sqlx::query_scalar(
        "SELECT record_json FROM agent_runtime_transitions WHERE operation_id = ?1",
    )
    .bind(plan.operation_id.as_str())
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    let schema = migrated.schema_info();
    assert_eq!(
        (
            schema.schema_version,
            schema.min_reader_version,
            schema.min_writer_version
        ),
        (54, 53, 53)
    );
    // These are the exact persisted admission checks used by a schema52 host.
    assert!(schema.min_reader_version > 52 && schema.min_writer_version > 52);
    assert!(std::fs::read_dir(root.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("schema-52-to-53")
    }));
    migrated.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(reopened.schema_info(), schema);
}
