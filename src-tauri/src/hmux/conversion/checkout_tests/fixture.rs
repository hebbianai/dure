use super::*;

pub(super) struct ConversionFixture {
    pub home: PathBuf,
    pub app_home: PathBuf,
    pub discovery: PathBuf,
    pub checkout: PathBuf,
    pub app: tauri::App<tauri::test::MockRuntime>,
    pub manager: HmuxManager,
    pub current: runtime::InstalledBuild,
    pub create: ManagedCreateRequest,
    pub source: hmux_client::CreatedManagedSession,
}

impl ConversionFixture {
    pub fn new(target: SessionConversionTarget, source_root: Option<PathBuf>) -> Self {
        let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
            .canonicalize()
            .unwrap();
        let home = PathBuf::from(std::env::var_os("HOME").unwrap())
            .canonicalize()
            .unwrap();
        assert!(home.starts_with(&guardian) && home != guardian);
        let app_home = PathBuf::from(std::env::var_os("DURE_HOME").unwrap())
            .canonicalize()
            .unwrap();
        assert!(app_home.starts_with(&home) && app_home != home);
        let catalog = product_catalog().unwrap();
        let discovery = catalog.discovery_root().to_path_buf();
        for root in catalog.discovery_paths().chain(source_root.as_deref()) {
            assert!(root.starts_with(&home) && root != home);
        }
        assert_eq!(std::env::var("SHELL").unwrap(), "/bin/sh");
        // Keep every fixture file until the outer guardian has retired its Hosts.
        let root = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
        assert!(root.starts_with(&guardian));
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["commit", "-q", "--allow-empty", "-m", "base"]);
        git(
            &root,
            &["worktree", "add", "-q", "-b", "conversion", "checkout"],
        );
        let checkout = root.join("checkout").canonicalize().unwrap();
        let provider = fixture_provider(&home, &checkout);
        let app = tauri::test::mock_app();
        let manager = HmuxManager::default();
        let install_root = home.join("hmux-install");
        assert_eq!(
            PathBuf::from(std::env::var_os("HMUX_INSTALL_ROOT").unwrap()),
            install_root
        );
        let current = runtime::ensure_current_build(app.handle()).unwrap();
        assert!(current.runtime.starts_with(&install_root));
        let channel = crate::app_channel::current().unwrap();
        crate::managed_hooks::publish_codex_runtime(
            &channel.control_dir, &current.runtime, &home,
        ).unwrap();
        let create = ManagedCreateRequest::new(
            "conversion-shell-create",
            "conversion-shell",
            "local-shell-workspace",
            match target {
                SessionConversionTarget::Managed => "local-shell",
                SessionConversionTarget::Standalone => "codex",
            },
            PermissionMode::Default,
            &checkout,
            vec![
                provider.to_string_lossy().into_owned(),
                "resume".into(),
                CONVERSATION.into(),
            ],
            24,
            80,
        )
        .unwrap();
        let create = require_conversation_fenced_managed_stop_lifecycle(create).unwrap();
        let create = match target {
            SessionConversionTarget::Managed => create,
            SessionConversionTarget::Standalone => create
                .with_conversation_identity(
                    ProviderConversationIdentitySeed::new("codex", CONVERSATION).unwrap(),
                )
                .unwrap(),
        };
        let source =
            crate::session_checkout::create(current.runtime.clone(), source_root, create.clone())
                .unwrap();
        wait_for_provider_start(&home, source.session().descriptor());
        Self {
            home,
            app_home,
            discovery,
            checkout,
            app,
            manager,
            current,
            create,
            source,
        }
    }
}

pub(super) fn wait_for_provider_start(home: &Path, descriptor: &SessionDescriptor) {
    // A Host create receipt precedes provider initialization. The existing fake
    // provider publishes this atomic receipt after the wrapper opens both the
    // rollout and runtime database, before conversion can inspect those files.
    let receipt = home
        .join("provider-capture/provider-sessions")
        .join(format!("{}.json", descriptor.session_id));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !receipt.is_file() {
        assert!(Instant::now() < deadline, "fixture provider did not initialize");
        thread::sleep(Duration::from_millis(20));
    }
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(receipt).unwrap()).unwrap();
    assert_eq!(receipt["schema"], 1);
    assert_eq!(receipt["provider"], "codex");
    assert_eq!(receipt["sessionId"], descriptor.session_id);
}

pub(super) fn request(
    operation_id: &str,
    checkout: &Path,
    source: &SessionDescriptor,
    target: SessionConversionTarget,
) -> SessionConversionRequest {
    SessionConversionRequest {
        conversion_id: operation_id.into(),
        source_session_id: source.session_id.clone(),
        source_workspace_id: source.workspace_id.clone(),
        expected_source_fence: Some(ManagedStopFence {
            runner_principal: source.runner_principal.clone(),
            runner_instance: source.runner_instance.clone(),
            channel_epoch: source.channel_epoch.clone(),
            host_instance_id: source.host_instance_id.clone(),
            terminal_epoch: source.terminal_epoch.clone(),
        }),
        target,
        provider_id: "codex".into(),
        expected_conversation_id: Some(CONVERSATION.into()),
        cwd: checkout.to_string_lossy().into_owned(),
        confirmed: false,
        permission_mode: PermissionMode::Default,
        credential_id: None,
        credential_directory: None,
        credential_generation: None,
        rows: 24,
        columns: 80,
        terminal_environment: Default::default(),
        terminal_default_colors: None,
    }
}
