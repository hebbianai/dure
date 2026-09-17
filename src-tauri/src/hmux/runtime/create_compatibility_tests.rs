use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

pub(super) const APP_CAPABILITIES: &[&str] = &[
    "managed_create_v6",
    "standalone_request_bound_create_v1",
    "agent_state_report_causality_v1",
];

// Host protocol compatibility alone proves neither creation nor report support.
pub(super) fn runtime_script(path: &Path, build_id: &str, capabilities: &[&str]) {
    let info = serde_json::json!({
        "schemaVersion": 1, "buildId": build_id,
        "protocol": {"minimum": "1.0", "maximum": "1.0"},
        "capabilities": capabilities,
    });
    fs::write(
        path,
        format!(
            "#!/bin/sh\n[ \"$1\" = hmux-build-info ] || exit 47\nprintf '%s' '{}'\n",
            info
        ),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn install(root: &Path, build_id: &str, capabilities: &[&str]) -> PathBuf {
    super::tests::installed_build(root, build_id, true);
    let runtime = root
        .join("versions")
        .join(build_id)
        .join("bin")
        .join(runtime_file_name());
    runtime_script(&runtime, build_id, capabilities);
    symlink(Path::new("versions").join(build_id), root.join("current")).unwrap();
    runtime
}

#[test]
fn bundled_activation_upgrades_a_create_capable_current_without_causal_reports() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("install");
    let old = install(
        &root,
        "create-only",
        &["managed_create_v6", "standalone_request_bound_create_v1"],
    );
    let old_bytes = fs::read(&old).unwrap();
    let source = temp.path().join("bundled");
    runtime_script(&source, "causal-build", APP_CAPABILITIES);

    let selected = activate_bundled_runtime_at(&root, &source, BUILD_INFO_TIMEOUT).unwrap();
    assert_eq!(selected.build_id, "causal-build");
    assert_eq!(resolve_current_at(&root).unwrap().build_id, "causal-build");
    assert_eq!(previous_build_id_at(&root).as_deref(), Some("create-only"));
    assert_eq!(fs::read(old).unwrap(), old_bytes);
}

#[test]
fn bundled_activation_upgrades_a_protocol_compatible_but_create_incompatible_current() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("install");
    let old = install(&root, "old-build", &[]);
    let old_bytes = fs::read(&old).unwrap();
    let source = temp.path().join("bundled");
    runtime_script(&source, "new-build", APP_CAPABILITIES);
    let selected = activate_bundled_runtime_at(&root, &source, BUILD_INFO_TIMEOUT).unwrap();
    assert_eq!(selected.build_id, "new-build");
    assert_eq!(
        fs::read_link(root.join("current")).unwrap(),
        Path::new("versions/new-build")
    );
    assert_eq!(
        fs::read_link(root.join("previous")).unwrap(),
        Path::new("versions/old-build")
    );
    assert_eq!(fs::read(&old).unwrap(), old_bytes);
    assert!(root
        .join("versions/old-build/bin")
        .join(cli_file_name())
        .is_file());
}

#[test]
#[ignore = "run pnpm test:hmux-create-runtime-compatibility"]
fn native_terminal_creation_upgrades_legacy_current_before_request_bound_create() {
    let state = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap());
    let root = install_root().unwrap();
    let discovery = PathBuf::from(std::env::var_os("HMUX_DISCOVERY_ROOT").unwrap());
    assert!(root.starts_with(&state) && discovery.starts_with(&state));
    assert!(
        !root.exists(),
        "fixture must start with an empty installation"
    );
    let old = install(&root, "legacy-create", &[]);
    if let Some(legacy) = std::env::var_os("DURE_QA_LEGACY_HMUX_RUNTIME") {
        let info = inspect_runtime_at(Path::new(&legacy), BUILD_INFO_TIMEOUT).unwrap();
        let version = root.join("versions/legacy-create");
        let mut metadata: InstallMetadata =
            serde_json::from_slice(&fs::read(version.join("install.json")).unwrap()).unwrap();
        metadata.build_id = info.build_id.clone();
        fs::write(
            version.join("install.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        fs::copy(legacy, &old).unwrap();
        fs::rename(&version, root.join("versions").join(&info.build_id)).unwrap();
        replace_version_link(&root, "current", &info.build_id).unwrap();
    }
    let old = resolve_current_at(&root).unwrap();
    let old_bytes = fs::read(&old.runtime).unwrap();
    let old_metadata = fs::read(
        old.runtime
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("install.json"),
    )
    .unwrap();
    let app = tauri::test::mock_app();
    let manager = super::super::HmuxManager::default();
    let created = manager
        .create_standalone_command(
            app.handle(),
            state.to_str().unwrap().into(),
            24,
            80,
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf terminal-create-ready; exec /bin/cat".into(),
            ],
            hmux_client::TerminalEnvironment::default(),
        )
        .expect("the same desktop terminal creation must succeed with a legacy current installed");
    let catalog = hmux_client::LocalSessionCatalog::new(&discovery);
    let session = catalog
        .open(&hmux_client::SessionSelector::new(
            &created.session_id,
            Some(created.workspace_id.clone()),
        ))
        .unwrap();
    assert_eq!(
        hmux_client::probe_local_session_exact(&catalog, session.descriptor()),
        hmux_client::SessionProbeStatus::Healthy
    );
    assert_ne!(resolve_current_at(&root).unwrap().build_id, old.build_id);
    assert_eq!(previous_build_id_at(&root), Some(old.build_id));
    assert_eq!(fs::read(&old.runtime).unwrap(), old_bytes);
    assert_eq!(
        fs::read(
            old.runtime
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("install.json")
        )
        .unwrap(),
        old_metadata
    );
    manager
        .terminate_standalone_session(
            &created.session_id,
            &created.workspace_id,
            Duration::from_secs(3),
        )
        .unwrap();
    create_managed_with_current_grammar(&root, &discovery, &state, app.handle());
    println!(
        "legacy-current terminal create: healthy; old artifact preserved; exact session stopped"
    );
}

#[test]
fn compatible_independent_current_is_preserved_across_bundle_revisions() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("install");
    let current = install(&root, "independent-newer", APP_CAPABILITIES);
    let before = fs::read(&current).unwrap();
    let source = temp.path().join("bundled");
    runtime_script(&source, "bundled-older", APP_CAPABILITIES);
    let selected = activate_bundled_runtime_at(&root, &source, BUILD_INFO_TIMEOUT).unwrap();
    assert_eq!(selected.runtime, current);
    assert_eq!(fs::read(current).unwrap(), before);
    assert!(!root.join("previous").exists());
    assert!(!root.join("versions/bundled-older").exists());
}

#[test]
fn incompatible_bundle_cannot_replace_an_installed_runtime() {
    for capabilities in [
        vec![],
        vec!["managed_create_v6"],
        vec!["standalone_request_bound_create_v1"],
        vec!["managed_create_v6", "standalone_request_bound_create_v1"],
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("install");
        install(&root, "old-build", &[]);
        let source = temp.path().join("bundled");
        runtime_script(&source, "incomplete-bundle", &capabilities);
        assert!(activate_bundled_runtime_at(&root, &source, BUILD_INFO_TIMEOUT).is_err());
        assert_eq!(resolve_current_at(&root).unwrap().build_id, "old-build");
        assert!(!root.join("versions/incomplete-bundle").exists());
    }
}

#[test]
fn installed_runtime_identity_mismatch_is_not_repaired_as_a_version_upgrade() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("install");
    let current = install(&root, "recorded-build", &[]);
    runtime_script(&current, "different-build", &[]);
    let source = temp.path().join("bundled");
    runtime_script(&source, "new-build", APP_CAPABILITIES);
    assert!(activate_bundled_runtime_at(&root, &source, BUILD_INFO_TIMEOUT).is_err());
    assert_eq!(
        fs::read_link(root.join("current")).unwrap(),
        Path::new("versions/recorded-build")
    );
    assert!(!root.join("versions/new-build").exists());
}

fn create_managed_with_current_grammar<R: tauri::Runtime>(
    root: &Path,
    discovery: &Path,
    cwd: &Path,
    app: &AppHandle<R>,
) {
    use hmux_client::{
        ManagedCreateRequest, ManagedSessionCreator, ManagedSessionStopper, ManagedStopRequest,
        PermissionMode, ProviderStateEnvironment,
    };
    let selected = resolve_current_at(root).unwrap();
    let request = ManagedCreateRequest::new(
        "schema-managed-create",
        "schema-managed-session",
        "schema-workspace",
        "test-provider",
        PermissionMode::Default,
        cwd,
        vec!["/bin/sh".into(), "-c".into(), "exec /bin/cat".into()],
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::from_mutations(
            Default::default(),
            ["TEST_PROVIDER_STATE".into()].into(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        format!(
            "managed_create_v{}",
            serde_json::to_value(&request).unwrap()["schemaVersion"]
        ),
        hmux_client::MANAGED_CREATE_CAPABILITY
    );
    let created = ManagedSessionCreator::new(&selected.runtime)
        .with_discovery_root(discovery)
        .create(request)
        .unwrap();
    let descriptor = created.session().descriptor();
    assert!(descriptor
        .capabilities
        .iter()
        .any(|value| value == "agent_state_report_causality_v1"));
    let report = serde_json::from_value(serde_json::json!({
        "sessionId": descriptor.session_id,
        "workspaceId": descriptor.workspace_id,
        "expectedSessionFence": {
            "sessionId": descriptor.session_id,
            "workspaceId": descriptor.workspace_id,
            "runnerPrincipal": descriptor.runner_principal,
            "runnerInstance": descriptor.runner_instance,
            "channelEpoch": descriptor.channel_epoch,
            "hostInstanceId": descriptor.host_instance_id,
            "terminalEpoch": descriptor.terminal_epoch,
        },
        "activity": "waiting",
        "attention": "none",
        "turnCompleted": false,
        "causality": {"sequence": "1"},
    }))
    .unwrap();
    let applied = super::super::HmuxManager::default()
        .report_agent_state(app, report)
        .expect("the selected runtime must accept the app's causal startup report");
    assert_eq!(applied.outcome, "applied");
    let observer = hmux_client::LocalSessionObserver::connect_resolved(
        created.session().clone(),
        hmux_client::ObserverAttachOptions::default(),
    )
    .unwrap();
    let state = observer
        .attachment()
        .initial_snapshot
        .agent_runtime_state
        .as_ref()
        .unwrap();
    assert_eq!(state.source, hmux_client::AgentRuntimeStateSource::ProviderEvent);
    assert_eq!(state.activity, hmux_client::AgentRuntimeActivity::Waiting);
    assert_eq!(state.terminal_epoch, descriptor.terminal_epoch);
    observer.detach().unwrap();
    let stop = ManagedStopRequest::new(
        "schema-managed-stop",
        &descriptor.session_id,
        &descriptor.workspace_id,
    )
    .unwrap()
    .with_expected_fence(
        &descriptor.runner_principal,
        &descriptor.runner_instance,
        descriptor.channel_epoch.parse().unwrap(),
        &descriptor.host_instance_id,
        &descriptor.terminal_epoch,
    )
    .unwrap();
    ManagedSessionStopper::new(&selected.runtime, cwd)
        .with_discovery_root(discovery)
        .stop(stop)
        .unwrap();
    println!("managed create and causal app report: applied at Host; exact session stopped");
}

#[test]
fn malformed_runtime_receipt_preserves_current_and_does_not_publish_a_bundle() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("install");
    let current = install(&root, "old-build", &[]);
    fs::write(&current, "#!/bin/sh\nprintf not-json\n").unwrap();
    let source = temp.path().join("bundle");
    runtime_script(&source, "new-build", APP_CAPABILITIES);
    assert!(activate_bundled_runtime_at(&root, &source, BUILD_INFO_TIMEOUT).is_err());
    assert_eq!(resolve_current_at(&root).unwrap().build_id, "old-build");
    assert!(!root.join("versions/new-build").exists());
}

#[test]
fn incompatible_existing_bundle_version_is_never_overwritten_or_activated() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("install");
    install(&root, "old-build", &[]);
    super::tests::installed_build(&root, "new-build", false);
    let retained = root
        .join("versions/new-build/bin")
        .join(runtime_file_name());
    runtime_script(&retained, "new-build", &[]);
    let before = fs::read(&retained).unwrap();
    let source = temp.path().join("bundle");
    runtime_script(&source, "new-build", APP_CAPABILITIES);
    assert!(activate_bundled_runtime_at(&root, &source, BUILD_INFO_TIMEOUT).is_err());
    assert_eq!(resolve_current_at(&root).unwrap().build_id, "old-build");
    assert_eq!(fs::read(retained).unwrap(), before);
}
