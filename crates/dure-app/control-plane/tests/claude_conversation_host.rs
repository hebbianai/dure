#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentClientMessageIdV1, AgentExecutionProfileV1, AgentIdV1,
    AgentInteractionBindingV1, AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1,
    AgentRecordV1, AgentStartTurnIntentV1, AgentTimelineEpochV1, AgentTimelineReadDirectionV1,
    AgentTimelineReadRequestV1, AgentTimelineReadV1, AgentTimelineStore, AgentTurnIdV1,
    DomainStore, ProjectIdV1, ProjectRecordV1, ProviderIdV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use dure_control_plane::agent_conversation::AgentConversationService;
use dure_control_plane::agent_conversation_api::{
    AgentConversationApi, AgentConversationRuntimeRegistry, START_TURN_OPERATION,
};
use dure_control_plane::claude_conversation_host::{
    ClaudeConversationAttachEffectV1, ClaudeConversationAttachmentV1, ClaudeConversationHost,
};
use dure_control_plane::claude_sdk_host_client::ClaudeDch1QueryIdentity;
use dure_control_plane::claude_sdk_host_supervisor::ClaudeSdkHostSupervisorConfiguration;
use sqlx::{Connection, SqliteConnection};

fn binding(index: usize) -> AgentInteractionBindingV1 {
    AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new(format!(
            "interaction-claude-shared-{index}"
        ))
        .unwrap(),
        agent_id: AgentIdV1::new(format!("agent-claude-shared-{index}")).unwrap(),
        provider_id: ProviderIdV1::new("claude").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: matches!(index, 1 | 3 | 4)
            .then(|| format!("session-resume-{index}")),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: format!("runtime-claude-shared-{index}"),
            provider_epoch: format!("query-claude-shared-{index}"),
        },
        timeline_epoch: AgentTimelineEpochV1::new(format!("timeline-claude-shared-{index}"))
            .unwrap(),
        binding_revision: 1,
        history_complete: !matches!(index, 1 | 3),
        created_at_ms: 10 + index as i64,
        updated_at_ms: 10 + index as i64,
    }
}

async fn seed(store: &SqliteDomainStore, root: &Path) {
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-claude-shared").unwrap(),
            root_path: root.to_string_lossy().into_owned(),
            display_name: "Claude shared host".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    for index in 1..=4 {
        store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: WorkspaceIdV1::new(format!("workspace-claude-shared-{index}"))
                    .unwrap(),
                project_id: ProjectIdV1::new("project-claude-shared").unwrap(),
                root_path: root.to_string_lossy().into_owned(),
                base_commit_sha: None,
                created_at_ms: 2 + index as i64,
                updated_at_ms: 2 + index as i64,
            })
            .await
            .unwrap();
        store
            .upsert_agent(&AgentRecordV1 {
                agent_id: AgentIdV1::new(format!("agent-claude-shared-{index}")).unwrap(),
                workspace_id: WorkspaceIdV1::new(format!("workspace-claude-shared-{index}"))
                    .unwrap(),
                provider_id: ProviderIdV1::new("claude").unwrap(),
                display_name: format!("Claude {index}"),
                created_at_ms: 5 + index as i64,
                updated_at_ms: 5 + index as i64,
            })
            .await
            .unwrap();
        store
            .create_agent_interaction(&binding(index))
            .await
            .unwrap();
    }
}

async fn wait_for_assistant(
    service: &AgentConversationService<SqliteDomainStore>,
    index: usize,
) -> AgentTimelineReadV1 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let read = service
            .read(&AgentTimelineReadRequestV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: binding(index).interaction_session_id,
                direction: AgentTimelineReadDirectionV1::Tail,
                cursor: None,
                limit: 32,
            })
            .await
            .unwrap();
        if matches!(&read, AgentTimelineReadV1::Page { page } if page.rows.iter().any(|row| {
            matches!(
                &row.item.body,
                dure_app::AgentTimelineItemBodyV1::Message {
                    role: dure_app::AgentTimelineMessageRoleV1::Assistant,
                    ..
                }
            )
        })) {
            return read;
        }
        assert!(
            Instant::now() < deadline,
            "assistant event was not committed"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the channel-pinned Node executable and Claude driver dependencies"]
async fn two_conversations_share_one_node_host_and_one_dch1_connection() {
    let node = PathBuf::from(std::env::var_os("DURE_NODE_BIN").expect("DURE_NODE_BIN"))
        .canonicalize()
        .unwrap();
    let entrypoint = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude-conversation-host-fixture.mjs")
        .canonicalize()
        .unwrap();
    let temporary = tempfile::Builder::new()
        .prefix("dure-claude-chat-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let state_root = temporary.path().join("host-state");
    let runtime_root = temporary.path().join("runtime");
    fs::create_dir(&state_root).unwrap();
    fs::create_dir(&runtime_root).unwrap();
    fs::set_permissions(&state_root, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&runtime_root, fs::Permissions::from_mode(0o700)).unwrap();
    let store = Arc::new(
        SqliteDomainStore::open(temporary.path().join("timeline.sqlite3"))
            .await
            .unwrap(),
    );
    seed(&store, temporary.path()).await;
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let configuration = ClaudeSdkHostSupervisorConfiguration::new(
        node,
        entrypoint,
        &state_root,
        &runtime_root,
        "host-shared-conversation-1",
        Vec::new(),
    )
    .unwrap();
    let host = Arc::new(
        ClaudeConversationHost::new(
            configuration,
            "control-plane-shared-conversation-1",
            Arc::clone(&service),
            Arc::clone(&registry),
        )
        .unwrap(),
    );

    let mut receipts = Vec::new();
    for index in 1..=2 {
        let config = temporary.path().join(format!("credential-profile-{index}"));
        fs::create_dir(&config).unwrap();
        let selected = index == 1;
        receipts.push(
            host.attach(ClaudeConversationAttachmentV1 {
                binding: binding(index),
                cwd: temporary.path().to_path_buf(),
                environment: BTreeMap::from([(
                    "CLAUDE_CONFIG_DIR".into(),
                    config.to_string_lossy().into_owned(),
                )]),
                permission_mode: if selected {
                    dure_app::ProviderPermissionModeV1::SkipPermissions
                } else {
                    dure_app::ProviderPermissionModeV1::Default
                },
                model: selected.then(|| {
                    dure_app::AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()
                }),
                effort: selected
                    .then(|| dure_app::AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
                process: None,
                relay_id: format!("relay-claude-shared-{index}"),
                replacement_authority: None,
            })
            .await
            .unwrap(),
        );
    }
    assert_eq!(receipts[0].host_process_id, receipts[1].host_process_id);
    assert!(receipts[0].binding.history_complete);
    assert_ne!(receipts[0].identity, receipts[1].identity);
    assert_eq!(host.host_launch_count().unwrap(), 1);
    assert_eq!(host.client_attach_count(), 1);

    let incomplete = host
        .attach(ClaudeConversationAttachmentV1 {
            binding: binding(3),
            cwd: temporary.path().to_path_buf(),
            environment: BTreeMap::from([("DURE_TEST_HISTORY_INCOMPLETE".into(), "1".into())]),
            permission_mode: dure_app::ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            process: None,
            relay_id: "relay-claude-shared-3".into(),
            replacement_authority: None,
        })
        .await
        .unwrap();
    assert!(!incomplete.binding.history_complete);
    let incomplete_page = service
        .read(&AgentTimelineReadRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: binding(3).interaction_session_id,
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 32,
        })
        .await
        .unwrap();
    let AgentTimelineReadV1::Page { page } = incomplete_page else {
        panic!("incomplete hydration timeline unexpectedly reset");
    };
    assert!(!page.binding.history_complete);
    assert!(!page.rows.is_empty());
    assert!(page.rows.iter().all(|row| matches!(
        row.item.body,
        dure_app::AgentTimelineItemBodyV1::Lifecycle { .. }
            | dure_app::AgentTimelineItemBodyV1::ProviderEvidence { .. }
    )));

    let resumed = service
        .read(&AgentTimelineReadRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: binding(1).interaction_session_id,
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 32,
        })
        .await
        .unwrap();
    let AgentTimelineReadV1::Page { page } = resumed else {
        panic!("resumed timeline unexpectedly reset");
    };
    assert!(page.binding.history_complete);
    assert!(matches!(
        &page.rows[0].item.body,
        dure_app::AgentTimelineItemBodyV1::Message { markdown, .. }
            if markdown == "prior question"
    ));
    assert!(matches!(
        &page.rows[1].item.body,
        dure_app::AgentTimelineItemBodyV1::Message { markdown, .. }
            if markdown == "prior answer"
    ));
    assert!(matches!(
        &page.rows[2].item.body,
        dure_app::AgentTimelineItemBodyV1::ProviderEvidence { .. }
    ));

    let api = AgentConversationApi::new(Arc::clone(&service), Arc::clone(&registry));
    for index in 1..=2 {
        let response = api
            .dispatch(
                START_TURN_OPERATION,
                &serde_json::to_value(AgentStartTurnIntentV1 {
                    schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                    interaction_session_id: binding(index).interaction_session_id,
                    runtime: binding(index).runtime,
                    turn_id: AgentTurnIdV1::new(format!("turn-claude-shared-{index}")).unwrap(),
                    client_message_id: AgentClientMessageIdV1::new(format!(
                        "message-claude-shared-{index}"
                    ))
                    .unwrap(),
                    input: format!("hello from {index}"),
                    requested_at_ms: 20 + index as i64,
                })
                .unwrap(),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response["receipt"]["state"], "accepted");
        assert!(!response.to_string().contains("credential-profile"));
    }

    for index in 1..=2 {
        let read = wait_for_assistant(&service, index).await;
        let AgentTimelineReadV1::Page { page } = read else {
            panic!("timeline unexpectedly reset");
        };
        assert!(page.rows.iter().any(|row| {
            matches!(
                &row.item.body,
                dure_app::AgentTimelineItemBodyV1::Message { markdown, .. }
                    if markdown == &format!("hello from {index}")
            )
        }));
    }

    let mismatch = host
        .attach(ClaudeConversationAttachmentV1 {
            binding: binding(1),
            cwd: temporary.path().to_path_buf(),
            environment: BTreeMap::from([(
                "CLAUDE_CONFIG_DIR".into(),
                temporary
                    .path()
                    .join("credential-profile-1")
                    .to_string_lossy()
                    .into_owned(),
            )]),
            permission_mode: dure_app::ProviderPermissionModeV1::SkipPermissions,
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
            effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("high").unwrap()),
            process: None,
            relay_id: "relay-claude-shared-1".into(),
            replacement_authority: None,
        })
        .await
        .unwrap_err();
    assert_eq!(mismatch.reason(), "identity_conflict");

    let reattached = host
        .attach(ClaudeConversationAttachmentV1 {
            binding: binding(1),
            cwd: temporary.path().to_path_buf(),
            environment: BTreeMap::from([(
                "CLAUDE_CONFIG_DIR".into(),
                temporary
                    .path()
                    .join("credential-profile-1")
                    .to_string_lossy()
                    .into_owned(),
            )]),
            permission_mode: dure_app::ProviderPermissionModeV1::SkipPermissions,
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
            effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
            process: None,
            relay_id: "relay-claude-shared-1".into(),
            replacement_authority: None,
        })
        .await
        .unwrap();
    assert_eq!(reattached, receipts[0]);
    assert_eq!(host.host_launch_count().unwrap(), 1);
    assert_eq!(host.client_attach_count(), 1);
    let AgentTimelineReadV1::Page { page } = service
        .read(&AgentTimelineReadRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: binding(1).interaction_session_id,
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 32,
        })
        .await
        .unwrap()
    else {
        panic!("reattached timeline unexpectedly reset");
    };
    assert_eq!(
        page.rows
            .iter()
            .filter(|row| matches!(
                row.item.body,
                dure_app::AgentTimelineItemBodyV1::Message { .. }
            ))
            .count(),
        4
    );

    let ghost_binding = binding(4);
    let ghost_config = temporary.path().join("credential-profile-4");
    fs::create_dir(&ghost_config).unwrap();
    host.attach(ClaudeConversationAttachmentV1 {
        binding: ghost_binding.clone(),
        cwd: temporary.path().to_path_buf(),
        environment: BTreeMap::from([(
            "CLAUDE_CONFIG_DIR".into(),
            ghost_config.to_string_lossy().into_owned(),
        )]),
        permission_mode: dure_app::ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        process: None,
        relay_id: "relay-claude-shared-4".into(),
        replacement_authority: None,
    })
    .await
    .unwrap();
    let mut corruption = SqliteConnection::connect(&format!(
        "sqlite://{}",
        store.database_path().to_string_lossy()
    ))
    .await
    .unwrap();
    sqlx::query(
        "UPDATE agent_interaction_sessions SET provider_conversation_ref = ?1 WHERE interaction_session_id = ?2",
    )
    .bind("session-resume-4-conflict")
    .bind(ghost_binding.interaction_session_id.as_str())
    .execute(&mut corruption)
    .await
    .unwrap();
    corruption.close().await.unwrap();
    let failed_refresh = host
        .attach(ClaudeConversationAttachmentV1 {
            binding: ghost_binding.clone(),
            cwd: temporary.path().to_path_buf(),
            environment: BTreeMap::from([(
                "CLAUDE_CONFIG_DIR".into(),
                ghost_config.to_string_lossy().into_owned(),
            )]),
            permission_mode: dure_app::ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            process: None,
            relay_id: "relay-claude-shared-4".into(),
            replacement_authority: None,
        })
        .await
        .unwrap_err();
    assert_eq!(failed_refresh.reason(), "binding_refresh_conflict");
    assert!(matches!(
        failed_refresh.attach_effect(),
        ClaudeConversationAttachEffectV1::QueryRetired(_)
    ));
    let command_error = api
        .dispatch(
            START_TURN_OPERATION,
            &serde_json::to_value(AgentStartTurnIntentV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: ghost_binding.interaction_session_id.clone(),
                runtime: ghost_binding.runtime.clone(),
                turn_id: AgentTurnIdV1::new("turn-claude-shared-4-after-retire").unwrap(),
                client_message_id: AgentClientMessageIdV1::new(
                    "message-claude-shared-4-after-retire",
                )
                .unwrap(),
                input: "must not reach a retired Query".into(),
                requested_at_ms: 51,
            })
            .unwrap(),
        )
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(
        command_error.code(),
        "agent_conversation_runtime_unavailable"
    );

    let retired_without_target = host
        .retire(&binding(1), &receipts[0].identity, None)
        .await
        .unwrap();
    assert_eq!(retired_without_target.allowed_target, None);
    let same_host_target = ClaudeDch1QueryIdentity {
        runtime_generation: "runtime-claude-shared-1-successor".into(),
        query_epoch: "query-claude-shared-1-successor".into(),
        relay_id: "relay-claude-shared-1-successor".into(),
    };
    let retargeted = host
        .reconcile_proven_retirement(&binding(1), &receipts[0].identity, Some(&same_host_target))
        .await
        .unwrap();
    assert_eq!(retargeted.allowed_target.as_ref(), Some(&same_host_target));

    let absent_binding = binding(3);
    let absent_identity = ClaudeDch1QueryIdentity {
        runtime_generation: absent_binding.runtime.runtime_generation.clone(),
        query_epoch: absent_binding.runtime.provider_epoch.clone(),
        relay_id: "relay-claude-shared-3".into(),
    };
    let fresh_host_target = ClaudeDch1QueryIdentity {
        runtime_generation: "runtime-claude-shared-3-successor".into(),
        query_epoch: "query-claude-shared-3-successor".into(),
        relay_id: "relay-claude-shared-3-successor".into(),
    };
    let recovered = host
        .reconcile_proven_retirement(&absent_binding, &absent_identity, Some(&fresh_host_target))
        .await
        .unwrap();
    assert_eq!(recovered.allowed_target.as_ref(), Some(&fresh_host_target));

    drop(api);
    drop(host);
    store.close().await;
}
