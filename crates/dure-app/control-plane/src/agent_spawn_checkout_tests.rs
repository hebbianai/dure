use super::*;
use crate::workspace_git::GitWorkspaceAcquirer;
use dure_git_checkout::{GitCheckoutRemovalRequestV1, remove_git_checkout_instance};

struct ClaimObservingLauncher {
    store: SqliteDomainStore,
    operation_id: OperationIdV1,
    calls: Arc<AtomicUsize>,
}

#[tokio::test]
async fn checkout_failure_keeps_the_actual_git_reason_in_the_durable_receipt() {
    let repository = crate::workspace_git::tests::repository().await;
    let linked = repository.path().join("linked");
    for arguments in [
        vec![
            "worktree",
            "add",
            "--detach",
            linked.to_str().unwrap(),
            "HEAD",
        ],
        vec![
            "config",
            "extensions.dureUnsupportedRegistrationFixture",
            "true",
        ],
        vec!["config", "core.repositoryformatversion", "1"],
    ] {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(repository.path())
            .args(arguments)
            .env_clear()
            .envs(std::env::vars_os().filter(|(key, _)| !key.to_string_lossy().starts_with("GIT_")))
            .env("LC_ALL", "C")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&database).await.unwrap();
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        request(),
        1,
    )
    .await
    .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let launcher = FixtureLauncher {
        calls: Arc::clone(&calls),
    };
    let prompt = FixturePromptDeliverer {
        calls: Arc::new(AtomicUsize::new(0)),
        uncertain: false,
    };
    let observer = FixturePromptActivityObserver::observed();
    let workspace = GitWorkspaceAcquirer::default();
    let mut context = execution(&launcher, &prompt, &observer);
    context.project_root = linked;
    context.workspace_acquirer = &workspace;
    let prepared = prepare_stage(&store, &planned, AgentSpawnStageV1::Worktree, 1)
        .await
        .unwrap();
    let failed = execute_prepared_stage(
        &store,
        prepared,
        1,
        &apply_body(&planned, "private prompt"),
        Some(&context),
        None,
    )
    .await
    .unwrap();
    let AgentSpawnRecoveryDirectiveV1::RetryRequired {
        error_code,
        error_detail,
        ..
    } = &failed.recovery
    else {
        panic!(
            "expected the original checkout refusal: {:?}",
            failed.recovery
        );
    };
    assert_eq!(error_code, "worktree_git_failed");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let detail = error_detail
        .as_deref()
        .expect("the actual Git reason must survive");
    assert!(detail.contains("unknown repository extension"), "{detail}");
    assert!(
        detail
            .to_ascii_lowercase()
            .contains("dureunsupportedregistrationfixture")
    );
    assert!(!detail.contains(['\n', '\r']));
    drop(store);
    let reopened = SqliteDomainStore::open(&database).await.unwrap();
    assert_eq!(
        reopened
            .agent_spawn_receipt(&planned.operation_id)
            .await
            .unwrap()
            .unwrap(),
        failed,
    );
}

#[tokio::test]
async fn existing_workspace_reuses_the_checkout_with_its_own_registration() {
    let repository = crate::workspace_git::tests::repository().await;
    let (agent, mut source_workspace, selection, binding) = existing_structured_source();
    let acquirer = GitWorkspaceAcquirer::default();
    let base_request = WorkspaceAcquireRequest {
        project_root: repository.path().to_path_buf(),
        workspace_id: source_workspace.workspace_id.clone(),
        registration_id: OperationIdV1::new("original-agent-registration").unwrap(),
        registration: None,
        policy: AgentSpawnWorktreePolicyV1::Dedicated {
            base_commit_sha: crate::workspace_git::resolve_base_commit(repository.path(), None)
                .await
                .unwrap(),
            branch: "agent/source".into(),
            branch_mode: Default::default(),
            checkout_path: None,
        },
    };
    let original = acquirer.acquire(base_request.clone()).await.unwrap();
    source_workspace.root_path = original.root.to_string_lossy().into_owned();
    let source = agent_spawn_api::existing_workspace_authority(
        &agent,
        &source_workspace,
        &selection,
        &AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
    )
    .unwrap();
    let resumed = acquirer
        .acquire(WorkspaceAcquireRequest {
            registration_id: OperationIdV1::new("resumed-agent-registration").unwrap(),
            policy: AgentSpawnWorktreePolicyV1::ExistingWorkspace {
                source: Box::new(source),
            },
            ..base_request.clone()
        })
        .await
        .unwrap();
    assert_eq!(resumed.root, original.root);
    assert_eq!(resumed.registration, original.registration);
    assert!(resumed.lease.is_none());
    let registration = original.registration.unwrap();
    dure_git_checkout::release_git_checkout_registration(
        &registration,
        &base_request.registration_id,
        &OperationIdV1::new("stop-original-agent").unwrap(),
    )
    .unwrap();
    assert_eq!(
        remove_git_checkout_instance(&GitCheckoutRemovalRequestV1 {
            repository_path: registration.repository_path,
            instance: registration.instance,
            policy: dure_app::GitCheckoutRemovalPolicyV1::RequireClean,
        })
        .unwrap_err()
        .code,
        "checkout_use_in_use"
    );
}

impl CredentialAwareWorkflowSessionLauncher for ClaimObservingLauncher {
    fn launch_with_provider_state(
        &self,
        request: WorkflowSessionLaunchRequestV1,
        environment: ProviderStateEnvironment,
        predecessor: Option<hmux_client::PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1 {
        let store = self.store.clone();
        let operation_id = self.operation_id.clone();
        let calls = Arc::clone(&self.calls);
        Box::pin(async move {
            let spawn = store
                .agent_spawn_receipt(&operation_id)
                .await
                .unwrap()
                .unwrap();
            let registration = spawn
                .checkout_registration
                .expect("claim must be journaled before launch");
            assert_eq!(
                request.working_directory,
                registration.instance.canonical_path
            );
            let removal = GitCheckoutRemovalRequestV1 {
                repository_path: registration.repository_path,
                instance: registration.instance,
                policy: dure_app::GitCheckoutRemovalPolicyV1::RequireClean,
            };
            assert_eq!(
                remove_git_checkout_instance(&removal).unwrap_err().code,
                "checkout_use_in_use"
            );
            FixtureLauncher { calls }
                .launch_with_provider_state(request, environment, predecessor)
                .await
        })
    }
}

#[tokio::test]
async fn canonical_spawn_journals_membership_before_launch_across_backend_restart() {
    spawn_journals_membership_at_destination(false, dure_app::AgentSpawnBranchModeV1::Create).await;
}

#[tokio::test]
async fn explicit_destination_journals_membership_before_launch_across_backend_restart() {
    spawn_journals_membership_at_destination(true, dure_app::AgentSpawnBranchModeV1::Create).await;
}

#[tokio::test]
async fn existing_branch_journals_membership_before_launch_across_backend_restart() {
    spawn_journals_membership_at_destination(true, dure_app::AgentSpawnBranchModeV1::Existing)
        .await;
}

async fn spawn_journals_membership_at_destination(
    custom: bool,
    branch_mode: dure_app::AgentSpawnBranchModeV1,
) {
    let repository = crate::workspace_git::tests::repository().await;
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&database).await.unwrap();
    let mut requested = dedicated_request();
    requested.prompt_digest = None;
    requested.worktree = AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha: match branch_mode {
            dure_app::AgentSpawnBranchModeV1::Create => {
                crate::workspace_git::resolve_base_commit(repository.path(), None)
                    .await
                    .unwrap()
            }
            dure_app::AgentSpawnBranchModeV1::Existing => {
                crate::workspace_git::tests::branch_behind_head(
                    repository.path(),
                    "agent/feature-x",
                )
                .await
            }
        },
        branch: "agent/feature-x".into(),
        branch_mode,
        checkout_path: custom.then(|| {
            repository
                .path()
                .join("custom/nested/feature-x")
                .to_string_lossy()
                .into_owned()
        }),
    };
    let providers = crate::provider_extension::test_local_agent_provider_registry();
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
    let calls = Arc::new(AtomicUsize::new(0));
    let launcher = ClaimObservingLauncher {
        store: store.clone(),
        operation_id: planned.operation_id.clone(),
        calls: Arc::clone(&calls),
    };
    let prompt = FixturePromptDeliverer {
        calls: Arc::new(AtomicUsize::new(0)),
        uncertain: false,
    };
    let observer = FixturePromptActivityObserver::observed();
    let workspace = GitWorkspaceAcquirer::default();
    let mut context = execution(&launcher, &prompt, &observer);
    context.project_root = repository.path().to_path_buf();
    context.workspace_acquirer = &workspace;
    let prepared = prepare_stage(&store, &planned, AgentSpawnStageV1::Worktree, 1)
        .await
        .unwrap();
    let committed = execute_prepared_stage(&store, prepared, 1, &body, Some(&context), None)
        .await
        .unwrap();
    let registration = committed.checkout_registration.clone().unwrap();
    let expected_root = repository.path().canonicalize().unwrap().join(if custom {
        "custom/nested/feature-x"
    } else {
        ".worktrees/feature-x"
    });
    assert_eq!(
        registration.instance.canonical_path,
        expected_root.to_string_lossy()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    drop(launcher);
    drop(store);

    let store = SqliteDomainStore::open(&database).await.unwrap();
    let restored = store
        .agent_spawn_receipt(&planned.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored, committed);
    body.expected_last_sequence = restored.last_sequence;
    let launcher = ClaimObservingLauncher {
        store: store.clone(),
        operation_id: planned.operation_id.clone(),
        calls: Arc::clone(&calls),
    };
    let reopened_workspace = GitWorkspaceAcquirer::default();
    let mut context = execution(&launcher, &prompt, &observer);
    context.project_root = repository.path().to_path_buf();
    context.workspace_acquirer = &reopened_workspace;
    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(context),
    )
    .await
    .unwrap();
    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(succeeded.checkout_registration, Some(registration));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
