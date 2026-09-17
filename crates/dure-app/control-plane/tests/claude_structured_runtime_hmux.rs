#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dure_app::{
    AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1, AGENT_TIMELINE_SCHEMA_VERSION_V1,
    AgentClientMessageIdV1, AgentExecutionProfileV1, AgentIdV1, AgentInteractionProfileV1,
    AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1, AgentRecordV1,
    AgentRuntimeReplacementV1, AgentRuntimeSelectionV1, AgentRuntimeTransitionStore,
    AgentStartTurnIntentV1, AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1,
    AgentTimelineReadV1, AgentTurnIdV1, DomainStore, PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
    ProjectIdV1, ProjectRecordV1, ProviderCredentialProfileDirectoryNameV1,
    ProviderCredentialProfileRegistrationV1, ProviderCredentialProfileStore,
    ProviderCredentialProfileV1, ProviderIdV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use dure_control_plane::agent_conversation::AgentConversationService;
use dure_control_plane::agent_conversation_api::{
    AgentConversationApi, AgentConversationRuntimeRegistry, START_TURN_OPERATION,
};
use dure_control_plane::claude_conversation_host::ClaudeConversationHost;
use dure_control_plane::claude_sdk_host_supervisor::ClaudeSdkHostSupervisorConfiguration;
use dure_control_plane::claude_structured_runtime::{
    ClaudeStructuredLaunchRequestV1, ClaudeStructuredOpenRequestV1,
    ClaudeStructuredRuntimeConfiguration, ClaudeStructuredRuntimeManager,
};
use dure_control_plane::provider_credential_profile::ProviderCredentialProfileRegistry;
use hmux_client::{
    LocalProcessGenerationStatus, LocalSessionCatalog, ProcessDescriptor, SessionDescriptor,
    probe_local_process_generation,
};
use sha2::{Digest, Sha256};

fn required_executable(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required")))
        .canonicalize()
        .unwrap()
}

fn owner_directory(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn kill_exact_process(process: &ProcessDescriptor) {
    if probe_local_process_generation(process).unwrap() == LocalProcessGenerationStatus::Absent {
        return;
    }
    let status = Command::new("/bin/kill")
        .args(["-KILL", &process.process_id.to_string()])
        .status()
        .unwrap();
    assert!(
        status.success(),
        "exact fixture process did not accept SIGKILL"
    );
}

fn wait_for_process_absence(process: &ProcessDescriptor) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if probe_local_process_generation(process).unwrap() == LocalProcessGenerationStatus::Absent
        {
            return;
        }
        assert!(Instant::now() < deadline, "fixture process stayed live");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn shared_sdk_host_process_id(state_root: &Path) -> u32 {
    let mut process_ids = fs::read_dir(state_root)
        .unwrap()
        .flatten()
        .filter_map(|entry| fs::read(entry.path().join("host.json")).ok())
        .filter_map(|source| serde_json::from_slice::<serde_json::Value>(&source).ok())
        .filter_map(|marker| marker["pid"].as_u64())
        .map(|process_id| u32::try_from(process_id).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(process_ids.len(), 1, "expected one shared Claude SDK Host");
    process_ids.remove(0)
}

fn process_is_live(process_id: u32) -> bool {
    (unsafe { libc::kill(process_id as libc::pid_t, 0) }) == 0
}

async fn wait_for_process_exit_state(process_id: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let output = Command::new("/bin/ps")
            .args(["-p", &process_id.to_string(), "-o", "state="])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&output.stdout);
        if state.trim().is_empty() || state.trim_start().starts_with('Z') {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "crashed shared SDK Host did not reach an exited state"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

struct ExactSessionGuard(Option<SessionDescriptor>);

impl Drop for ExactSessionGuard {
    fn drop(&mut self) {
        let Some(descriptor) = self.0.as_ref() else {
            return;
        };
        for process in [&descriptor.provider_process, &descriptor.host_process] {
            if probe_local_process_generation(process).ok()
                == Some(LocalProcessGenerationStatus::Live)
            {
                let _ = unsafe { libc::kill(process.process_id as libc::pid_t, libc::SIGKILL) };
            }
        }
    }
}

async fn register_managed_credential_profile(
    store: &SqliteDomainStore,
    home: &Path,
) -> AgentExecutionProfileV1 {
    let provider_id = ProviderIdV1::new("claude").unwrap();
    let reference_id = "acc-managed-runtime";
    let profile_directory_name =
        ProviderCredentialProfileDirectoryNameV1::new(&provider_id, "claude-managed-runtime")
            .unwrap();
    let metadata =
        fs::symlink_metadata(home.join("accounts").join(profile_directory_name.as_str())).unwrap();
    let credential_generation = format!(
        "credential-v1-{:x}",
        Sha256::digest(
            format!(
                "provider-credential-profile/v1\0{}\0{reference_id}\0{}\0{}",
                provider_id.as_str(),
                metadata.dev(),
                metadata.ino(),
            )
            .as_bytes(),
        )
    );
    let registration = ProviderCredentialProfileRegistrationV1 {
        profile: ProviderCredentialProfileV1 {
            schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
            provider_id,
            reference_id: reference_id.into(),
            credential_generation: credential_generation.clone(),
        },
        profile_directory_name,
        profile_device: metadata.dev(),
        profile_inode: metadata.ino(),
    };
    store
        .register_provider_credential_profile(None, &registration)
        .await
        .unwrap();
    AgentExecutionProfileV1::CredentialReference {
        reference_id: reference_id.into(),
        credential_generation: Some(credential_generation),
    }
}

async fn seed(store: &SqliteDomainStore, workspace: &Path) {
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-claude-managed-runtime").unwrap(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "Claude managed runtime".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-claude-managed-runtime").unwrap(),
            project_id: ProjectIdV1::new("project-claude-managed-runtime").unwrap(),
            root_path: workspace.to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: AgentIdV1::new("agent-claude-managed-runtime").unwrap(),
            workspace_id: WorkspaceIdV1::new("workspace-claude-managed-runtime").unwrap(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            display_name: "Claude managed runtime".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
}

async fn wait_for_assistant(
    service: &AgentConversationService<SqliteDomainStore>,
    interaction_session_id: &AgentInteractionSessionIdV1,
    expected_markdown: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let read = service
            .read(&AgentTimelineReadRequestV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: interaction_session_id.clone(),
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
                    markdown,
                    ..
                } if markdown == expected_markdown
            )
        })) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "assistant event was not committed"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_turn_idle(
    service: &AgentConversationService<SqliteDomainStore>,
    interaction_session_id: &AgentInteractionSessionIdV1,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let read = service
            .read(&AgentTimelineReadRequestV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: interaction_session_id.clone(),
                direction: AgentTimelineReadDirectionV1::Tail,
                cursor: None,
                limit: 1,
            })
            .await
            .unwrap();
        if matches!(&read, AgentTimelineReadV1::Page { page } if page.active_turn.is_none()) {
            return;
        }
        assert!(Instant::now() < deadline, "provider turn stayed active");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires built Hmux, the pinned Node executable, and Claude driver dependencies"]
async fn replacement_manager_reconciles_one_hmux_relay_and_replaces_one_credential_runtime() {
    let node = required_executable("DURE_NODE_BIN");
    let hmux_runtime = required_executable("DURE_HMUX_RUNTIME_BIN");
    let relay = PathBuf::from(env!("CARGO_BIN_EXE_dure-claude-process-relay"))
        .canonicalize()
        .unwrap();
    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let driver = manifest_root.join("provider-drivers/claude");
    let entrypoint = driver
        .join("shared-sdk-host-entrypoint.mjs")
        .canonicalize()
        .unwrap();
    let installer = driver
        .join("claude-runtime-install.mjs")
        .canonicalize()
        .unwrap();
    let fake_claude = manifest_root
        .join("tests/fixtures/fake-claude-agent-sdk-cli.mjs")
        .canonicalize()
        .unwrap();
    let temporary = tempfile::Builder::new()
        .prefix("dure-claude-managed-runtime-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let discovery_root = temporary.path().join("discovery");
    let host_state_root = temporary.path().join("host-state");
    let relay_state_root = temporary.path().join("relay-state");
    let runtime_root = temporary.path().join("runtime");
    let accounts_root = temporary.path().join("accounts");
    let managed_profile = accounts_root.join("claude-managed-runtime");
    for directory in [
        &discovery_root,
        &host_state_root,
        &relay_state_root,
        &accounts_root,
        &managed_profile,
    ] {
        owner_directory(directory);
    }
    let install = Command::new(&node)
        .args([
            installer.as_os_str(),
            "--runtime-root".as_ref(),
            runtime_root.as_os_str(),
            "--source".as_ref(),
            fake_claude.as_os_str(),
        ])
        .current_dir(&driver)
        .output()
        .unwrap();
    assert!(
        install.status.success(),
        "runtime adoption failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let store = Arc::new(
        SqliteDomainStore::open(temporary.path().join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    seed(&store, temporary.path()).await;
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let host_configuration = ClaudeSdkHostSupervisorConfiguration::new(
        node.clone(),
        entrypoint.clone(),
        host_state_root.clone(),
        runtime_root.clone(),
        "host-managed-runtime-1",
        Vec::new(),
    )
    .unwrap();
    let host = Arc::new(
        ClaudeConversationHost::new(
            host_configuration,
            "client-managed-runtime-1",
            Arc::clone(&service),
            Arc::clone(&registry),
        )
        .unwrap(),
    );
    let credential_profiles = Arc::new(ProviderCredentialProfileRegistry::new(
        temporary.path().to_path_buf(),
        Arc::clone(&store),
    ));
    let configuration = ClaudeStructuredRuntimeConfiguration::new(
        "backend-managed-runtime-1",
        hmux_runtime.clone(),
        discovery_root.clone(),
        relay.clone(),
        relay_state_root.clone(),
        BTreeMap::from([
            (
                "HOME".into(),
                temporary.path().to_string_lossy().into_owned(),
            ),
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            (
                "HEBBIAN_TEST_EXPECT_CLAUDE_PERMISSION_MODE".into(),
                "skip_permissions".into(),
            ),
            (
                "HEBBIAN_TEST_EXPECT_CLAUDE_MODEL".into(),
                "claude-opus-4-1".into(),
            ),
            ("HEBBIAN_TEST_EXPECT_CLAUDE_EFFORT".into(), "xhigh".into()),
        ]),
    )
    .unwrap();
    let manager = ClaudeStructuredRuntimeManager::new(
        configuration,
        credential_profiles,
        Arc::clone(&service),
        Arc::clone(&host),
        Arc::clone(&store),
    );

    let opened = manager
        .open(ClaudeStructuredOpenRequestV1 {
            agent_id: AgentIdV1::new("agent-claude-managed-runtime").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: None,
            permission_mode: dure_app::ProviderPermissionModeV1::SkipPermissions,
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
            effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
        })
        .await
        .unwrap();
    let interaction_session_id = opened.binding.interaction_session_id.clone();
    let source_runtime = opened.binding.runtime.clone();
    assert_eq!(
        opened.launch.runtime_generation,
        source_runtime.runtime_generation
    );
    assert_eq!(host.host_launch_count().unwrap(), 1);
    assert_eq!(host.client_attach_count(), 1);

    let selection_mismatch = manager
        .open(ClaudeStructuredOpenRequestV1 {
            agent_id: AgentIdV1::new("agent-claude-managed-runtime").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: None,
            permission_mode: dure_app::ProviderPermissionModeV1::SkipPermissions,
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
            effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("high").unwrap()),
        })
        .await
        .unwrap_err();
    assert_eq!(
        selection_mismatch,
        dure_control_plane::claude_structured_runtime::ClaudeStructuredRuntimeErrorV1::RuntimeConflict
    );

    let api = AgentConversationApi::new(Arc::clone(&service), registry);
    let turn = api
        .dispatch(
            START_TURN_OPERATION,
            &serde_json::to_value(AgentStartTurnIntentV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: interaction_session_id.clone(),
                runtime: source_runtime.clone(),
                turn_id: AgentTurnIdV1::new("turn-managed-runtime-1").unwrap(),
                client_message_id: AgentClientMessageIdV1::new("message-managed-runtime-1")
                    .unwrap(),
                input: "hello through managed runtime".into(),
                requested_at_ms: 10,
            })
            .unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(turn["receipt"]["state"], "accepted");
    wait_for_assistant(
        &service,
        &interaction_session_id,
        "sdk-echo:hello through managed runtime",
    )
    .await;
    let initialized = service
        .binding(&interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        initialized.provider_conversation_ref.as_deref(),
        Some("99999999-8888-4777-8666-555555555555")
    );
    assert_eq!(initialized.binding_revision, 2);

    let source_descriptor = LocalSessionCatalog::new(&discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .find(|descriptor| {
            descriptor.workspace_id == "workspace-claude-managed-runtime"
                && descriptor.provider_id == "claude"
        })
        .unwrap();

    drop(api);
    drop(manager);
    drop(host);
    kill_exact_process(&source_descriptor.provider_process);
    kill_exact_process(&source_descriptor.host_process);
    wait_for_process_absence(&source_descriptor.provider_process);
    wait_for_process_absence(&source_descriptor.host_process);
    fs::remove_dir_all(&discovery_root).unwrap();
    owner_directory(&discovery_root);

    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let host_configuration = ClaudeSdkHostSupervisorConfiguration::new(
        node.clone(),
        entrypoint.clone(),
        host_state_root.clone(),
        runtime_root.clone(),
        "host-managed-runtime-2",
        Vec::new(),
    )
    .unwrap();
    let host = Arc::new(
        ClaudeConversationHost::new(
            host_configuration,
            "client-managed-runtime-2",
            Arc::clone(&service),
            Arc::clone(&registry),
        )
        .unwrap(),
    );
    let credential_profiles = Arc::new(ProviderCredentialProfileRegistry::new(
        temporary.path().to_path_buf(),
        Arc::clone(&store),
    ));
    let configuration = ClaudeStructuredRuntimeConfiguration::new(
        "backend-managed-runtime-2",
        hmux_runtime.clone(),
        discovery_root.clone(),
        relay.clone(),
        relay_state_root.clone(),
        BTreeMap::from([
            (
                "HOME".into(),
                temporary.path().to_string_lossy().into_owned(),
            ),
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            (
                "HEBBIAN_TEST_EXPECT_CLAUDE_PERMISSION_MODE".into(),
                "skip_permissions".into(),
            ),
            (
                "HEBBIAN_TEST_EXPECT_CLAUDE_MODEL".into(),
                "claude-opus-4-1".into(),
            ),
            ("HEBBIAN_TEST_EXPECT_CLAUDE_EFFORT".into(), "xhigh".into()),
        ]),
    )
    .unwrap();
    let manager = ClaudeStructuredRuntimeManager::new(
        configuration,
        credential_profiles,
        Arc::clone(&service),
        Arc::clone(&host),
        Arc::clone(&store),
    );
    let recovery = manager
        .open(ClaudeStructuredOpenRequestV1 {
            agent_id: AgentIdV1::new("agent-claude-managed-runtime").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: None,
            permission_mode: dure_app::ProviderPermissionModeV1::SkipPermissions,
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
            effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
        })
        .await
        .unwrap();
    // A replacement backend starts with an empty in-memory registry. Its first
    // structured open must retire the exact journaled relay and resume the same
    // durable provider conversation without a client-issued stop or launch.
    assert_ne!(
        recovery.launch.runtime_generation,
        source_runtime.runtime_generation
    );
    assert_eq!(host.host_launch_count().unwrap(), 1);
    assert_eq!(host.client_attach_count(), 1);
    let recovered = service
        .binding(&interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        recovered.runtime.runtime_generation,
        recovery.launch.runtime_generation
    );
    assert_eq!(recovered.binding_revision, 3);
    assert_eq!(
        recovered.provider_conversation_ref,
        initialized.provider_conversation_ref
    );

    let api = AgentConversationApi::new(Arc::clone(&service), registry);
    let turn = api
        .dispatch(
            START_TURN_OPERATION,
            &serde_json::to_value(AgentStartTurnIntentV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: interaction_session_id.clone(),
                runtime: recovered.runtime.clone(),
                turn_id: AgentTurnIdV1::new("turn-managed-runtime-2").unwrap(),
                client_message_id: AgentClientMessageIdV1::new("message-managed-runtime-2")
                    .unwrap(),
                input: "hello after control-plane recovery".into(),
                requested_at_ms: 20,
            })
            .unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(turn["receipt"]["state"], "accepted");
    wait_for_assistant(
        &service,
        &interaction_session_id,
        "sdk-echo:hello after control-plane recovery",
    )
    .await;

    let target_execution_profile =
        register_managed_credential_profile(&store, temporary.path()).await;
    assert!(
        manager
            .stop(&interaction_session_id, &recovery.launch.runtime_generation,)
            .await
            .unwrap()
    );
    let target_runtime = AgentProviderRuntimeFenceV1 {
        runtime_generation: "runtime-managed-credential-1".into(),
        provider_epoch: "query-managed-credential-1".into(),
    };
    let replaced = service
        .replace_runtime(&AgentRuntimeReplacementV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: interaction_session_id.clone(),
            expected_binding_revision: recovered.binding_revision,
            source: recovered.runtime.clone(),
            source_execution_profile: recovered.execution_profile.clone(),
            target: target_runtime.clone(),
            target_execution_profile: target_execution_profile.clone(),
            provider_conversation_ref: recovered.provider_conversation_ref.clone(),
            replaced_at_ms: recovered.updated_at_ms + 1,
        })
        .await
        .unwrap();
    assert_eq!(replaced.interaction_session_id, interaction_session_id);
    assert_eq!(replaced.execution_profile, target_execution_profile);
    assert_eq!(replaced.runtime, target_runtime);
    assert_eq!(
        replaced.provider_conversation_ref,
        initialized.provider_conversation_ref
    );

    let credential_runtime = manager
        .open(ClaudeStructuredOpenRequestV1 {
            agent_id: AgentIdV1::new("agent-claude-managed-runtime").unwrap(),
            execution_profile: target_execution_profile.clone(),
            provider_conversation_ref: replaced.provider_conversation_ref.clone(),
            permission_mode: dure_app::ProviderPermissionModeV1::SkipPermissions,
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
            effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
        })
        .await
        .unwrap();
    assert_eq!(credential_runtime.binding, replaced);
    assert_eq!(
        credential_runtime.launch.runtime_generation,
        target_runtime.runtime_generation
    );
    assert_eq!(host.host_launch_count().unwrap(), 1);
    assert_eq!(host.client_attach_count(), 1);

    let turn = api
        .dispatch(
            START_TURN_OPERATION,
            &serde_json::to_value(AgentStartTurnIntentV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: interaction_session_id.clone(),
                runtime: credential_runtime.binding.runtime.clone(),
                turn_id: AgentTurnIdV1::new("turn-managed-runtime-3").unwrap(),
                client_message_id: AgentClientMessageIdV1::new("message-managed-runtime-3")
                    .unwrap(),
                input: "hello after credential replacement".into(),
                requested_at_ms: 30,
            })
            .unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(turn["receipt"]["state"], "accepted");
    wait_for_assistant(
        &service,
        &interaction_session_id,
        "sdk-echo:hello after credential replacement",
    )
    .await;

    store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            agent_id: AgentIdV1::new("agent-claude-managed-runtime").unwrap(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: target_execution_profile,
            permission_mode: dure_app::ProviderPermissionModeV1::SkipPermissions,
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
            effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: credential_runtime.binding.updated_at_ms,
        })
        .await
        .unwrap();

    drop(api);
    drop(manager);
    drop(host);

    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let host_configuration = ClaudeSdkHostSupervisorConfiguration::new(
        node,
        entrypoint,
        host_state_root,
        runtime_root,
        "host-managed-runtime-3",
        Vec::new(),
    )
    .unwrap();
    let host = Arc::new(
        ClaudeConversationHost::new(
            host_configuration,
            "client-managed-runtime-3",
            Arc::clone(&service),
            Arc::clone(&registry),
        )
        .unwrap(),
    );
    let credential_profiles = Arc::new(ProviderCredentialProfileRegistry::new(
        temporary.path().to_path_buf(),
        Arc::clone(&store),
    ));
    let configuration = ClaudeStructuredRuntimeConfiguration::new(
        "backend-managed-runtime-3",
        hmux_runtime,
        discovery_root,
        relay,
        relay_state_root,
        BTreeMap::from([
            (
                "HOME".into(),
                temporary.path().to_string_lossy().into_owned(),
            ),
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            (
                "HEBBIAN_TEST_EXPECT_CLAUDE_PERMISSION_MODE".into(),
                "skip_permissions".into(),
            ),
            (
                "HEBBIAN_TEST_EXPECT_CLAUDE_MODEL".into(),
                "claude-opus-4-1".into(),
            ),
            ("HEBBIAN_TEST_EXPECT_CLAUDE_EFFORT".into(), "xhigh".into()),
        ]),
    )
    .unwrap();
    let manager = ClaudeStructuredRuntimeManager::new(
        configuration,
        credential_profiles,
        Arc::clone(&service),
        Arc::clone(&host),
        Arc::clone(&store),
    );
    let resumed_launch = manager
        .launch(ClaudeStructuredLaunchRequestV1 {
            interaction_session_id: interaction_session_id.clone(),
        })
        .await
        .unwrap();
    assert_ne!(
        resumed_launch.runtime_generation,
        credential_runtime.launch.runtime_generation
    );
    assert_eq!(host.host_launch_count().unwrap(), 1);
    assert_eq!(host.client_attach_count(), 1);

    let api = AgentConversationApi::new(Arc::clone(&service), registry);
    let resumed_binding = service
        .binding(&interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    let turn = api
        .dispatch(
            START_TURN_OPERATION,
            &serde_json::to_value(AgentStartTurnIntentV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: interaction_session_id.clone(),
                runtime: resumed_binding.runtime,
                turn_id: AgentTurnIdV1::new("turn-managed-runtime-4").unwrap(),
                client_message_id: AgentClientMessageIdV1::new("message-managed-runtime-4")
                    .unwrap(),
                input: "hello after committed-selection recovery".into(),
                requested_at_ms: 40,
            })
            .unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(turn["receipt"]["state"], "accepted");
    wait_for_assistant(
        &service,
        &interaction_session_id,
        "sdk-echo:hello after committed-selection recovery",
    )
    .await;

    assert!(
        manager
            .stop(&interaction_session_id, &resumed_launch.runtime_generation,)
            .await
            .unwrap()
    );
}

#[path = "claude_structured_runtime_hmux/reconnect.rs"]
mod reconnect;
