use std::sync::atomic::AtomicBool;

use super::*;

struct ObservingLauncher {
    store: SqliteDomainStore,
    agent_id: AgentIdV1,
    records_ready: Arc<AtomicBool>,
    launcher: RecordingLauncher,
}

impl CredentialAwareWorkflowSessionLauncher for ObservingLauncher {
    fn launch_with_provider_state(
        &self,
        request: WorkflowSessionLaunchRequestV1,
        environment: ProviderStateEnvironment,
        predecessor: Option<hmux_client::PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1 {
        let store = self.store.clone();
        let agent_id = self.agent_id.clone();
        let records_ready = Arc::clone(&self.records_ready);
        let launched = self
            .launcher
            .launch_with_provider_state(request, environment, predecessor);
        Box::pin(async move {
            // The agent foreign keys require its workspace and project to exist too.
            records_ready.store(
                store.agent(&agent_id).await.unwrap().is_some(),
                Ordering::SeqCst,
            );
            launched.await
        })
    }
}

async fn spawn_with_registration(provider: &str, registered: bool, native: bool) {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    if registered {
        register_project(&store).await;
    }
    let providers = if provider == "codex" {
        crate::provider_extension::test_codex_structured_agent_provider_registry()
    } else {
        crate::provider_extension::test_local_agent_provider_registry()
    };
    let mut requested = request();
    requested.provider_id = ProviderIdV1::new(provider).unwrap();
    requested.prompt_digest = None;
    requested.interaction_preference =
        native.then_some(AgentSpawnInteractionPreferenceV1::NativeCli);
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        requested,
        1,
    )
    .await
    .unwrap();
    let mut body = apply_body(&planned, "");
    body.prompt = None;
    let launcher = ObservingLauncher {
        store: store.clone(),
        agent_id: planned.plan.agent_id.clone(),
        records_ready: Arc::new(AtomicBool::new(false)),
        launcher: RecordingLauncher::default(),
    };
    let structured = FixtureStructuredLauncher::for_provider(provider);
    let prompt = FixturePromptDeliverer {
        calls: Arc::new(AtomicUsize::new(0)),
        uncertain: false,
    };
    let observer = FixturePromptActivityObserver::observed();
    let mut context = execution(&launcher, &prompt, &observer);
    if !native {
        context.launch = AgentSpawnLaunchExecution::StructuredProtocol {
            launcher: &structured,
        };
    }
    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(context),
    )
    .await
    .unwrap();
    assert_eq!(
        succeeded.state,
        AgentSpawnJournalStateV1::Succeeded,
        "{provider}: {:?}",
        succeeded.recovery
    );
    let project = store
        .project(&planned.plan.authority.project_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(project.root_path, "/fixture/project");
    assert_eq!(
        project.created_at_ms,
        if registered { 0 } else { planned.created_at_ms }
    );
    let workspace = store
        .workspace(&planned.plan.workspace_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(workspace.project_id, project.project_id);
    assert_eq!(workspace.root_path, project.root_path);
    let agent = store.agent(&planned.plan.agent_id).await.unwrap().unwrap();
    assert_eq!(agent.workspace_id, workspace.workspace_id);
    assert_eq!(agent.provider_id.as_str(), provider);
    let selection = store
        .agent_runtime_selection(&agent.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        selection.interaction_profile,
        if native {
            AgentInteractionProfileV1::NativeCli
        } else {
            AgentInteractionProfileV1::StructuredProtocol
        }
    );

    let replay = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        None,
    )
    .await
    .unwrap();
    assert_eq!(replay, succeeded);
    if native {
        assert!(launcher.records_ready.load(Ordering::SeqCst));
        assert_eq!(launcher.launcher.calls.load(Ordering::SeqCst), 1);
    } else {
        assert_eq!(structured.launch_calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn native_spawn_without_project_registration() {
    for provider in ["codex", "claude"] {
        spawn_with_registration(provider, false, true).await;
    }
}

#[tokio::test]
async fn native_spawn_with_project_registration() {
    for provider in ["codex", "claude"] {
        spawn_with_registration(provider, true, true).await;
    }
}

#[tokio::test]
async fn structured_spawn_without_project_registration() {
    for provider in ["codex", "claude"] {
        spawn_with_registration(provider, false, false).await;
    }
}

#[tokio::test]
async fn structured_spawn_with_project_registration() {
    for provider in ["codex", "claude"] {
        spawn_with_registration(provider, true, false).await;
    }
}
