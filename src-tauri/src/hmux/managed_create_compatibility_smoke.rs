//! Native legacy-create versus advance behavior with real disposable Hosts.

use super::{HmuxManager, ManagedCreateLaunch, ManagedCreateSummary};
use crate::managed_create_resolution::{
    LegacyManagedCreateReceipt, ManagedCreateAdvanceCommandResolution,
};
use hmux_client::{LocalSessionCatalog, PermissionMode, SessionLifecycle, SessionSelector};
use std::path::Path;

fn launch(root: &Path, repetition: usize) -> ManagedCreateLaunch {
    ManagedCreateLaunch {
        replace_current: false,
        idempotency_key: format!("compatibility-create-{repetition}"),
        session_id: format!("compatibility-session-{repetition}"),
        workspace_id: "compatibility-workspace".into(),
        provider_id: "test-provider".into(),
        conversation_id: None,
        permission_mode: PermissionMode::Default,
        credential_id: None,
        credential_generation: None,
        provider_state_environment: Default::default(),
        cwd: root.to_string_lossy().into_owned(),
        command: "sleep 60".into(),
        initial_prompt: None,
        rows: 24,
        columns: 80,
        terminal_environment: Default::default(),
        terminal_default_colors: Default::default(),
    }
}

fn advanced(
    resolution: ManagedCreateAdvanceCommandResolution<ManagedCreateSummary>,
) -> ManagedCreateSummary {
    match resolution {
        ManagedCreateAdvanceCommandResolution::Advanced { receipt } => receipt,
        other => panic!("an exited source must advance explicitly: {other:?}"),
    }
}

fn timing_provider_command(marker: &Path, provider_command: &str) -> String {
    let script = format!(
        "printf '%s' \"${{HMUX_BROKER_TIMING_REQUEST-unset}}\" > {}; exec {provider_command}",
        crate::ssh::shell_quote(marker.to_str().unwrap()),
    );
    // Managed launch prepends exec. Keep both steps inside one executable,
    // otherwise the probe replaces the shell and the provider never starts.
    format!("/bin/sh -c {}", crate::ssh::shell_quote(&script))
}

#[test]
#[ignore = "run pnpm test:hmux-managed-create-compatibility"]
fn native_timing_fixture_runs_provider_after_environment_probe() {
    let state = std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap();
    let root = tempfile::tempdir().unwrap();
    assert!(root.path().starts_with(&state));
    for shell in ["/bin/sh", "/bin/zsh"] {
        if !Path::new(shell).is_file() {
            continue;
        }
        let marker = root.path().join("provider selector 'quoted'");
        let command = timing_provider_command(&marker, "printf '%s' provider-ran");
        let command = crate::managed_hooks::prepare_managed_exec(
            "test-provider",
            &command,
            &Default::default(),
        )
        .unwrap()
        .into_command_template(Path::new(shell));
        let output = std::process::Command::new(&command[0])
            .args(&command[1..])
            .env_remove("HMUX_BROKER_TIMING_REQUEST")
            .output()
            .unwrap();
        assert!(output.status.success(), "{shell}: {output:?}");
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "unset");
        assert_eq!(output.stdout, b"provider-ran", "{shell}: provider was skipped");
    }
}

#[test]
#[ignore = "run pnpm test:hmux-managed-create-compatibility"]
fn native_refresh_broker_timing_is_request_scoped_without_parent_environment() {
    let state = std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap();
    let home = std::env::var_os("HOME").unwrap();
    let app_home = std::env::var_os("DURE_HOME").unwrap();
    let discovery = std::env::var_os("HMUX_DISCOVERY_ROOT").unwrap();
    assert!(Path::new(&home).starts_with(&state));
    assert!(Path::new(&app_home).starts_with(&home));
    assert!(Path::new(&discovery).starts_with(&state));
    assert!(std::env::var_os("HMUX_BROKER_TIMING_REQUEST").is_none());
    let root = tempfile::tempdir().unwrap().keep();
    let app = tauri::test::mock_app();
    let manager = HmuxManager::default();
    let path = Path::new(&discovery).join(".diagnostics/runtime-v1/broker-timing.jsonl");
    let mut previous = std::fs::read_to_string(&path).unwrap_or_default();
    for (repetition, timing) in [(100, false), (101, true), (102, false)] {
        let mut request = launch(&root, repetition);
        request.conversation_id = Some(format!("private-conversation-{repetition}"));
        let source = manager.create_managed(app.handle(), request).unwrap();
        let mut request = launch(&root, repetition);
        request.replace_current = true;
        request.conversation_id = Some(format!("private-conversation-{repetition}"));
        let marker = root.join(format!("broker-environment-{repetition}"));
        request.command = timing_provider_command(&marker, "sleep 60");
        let native_timings = super::managed_create_timing::tests::Records::start();
        let resolution = manager
            .advance_managed_create_with_broker_timing(app.handle(), request, timing)
            .unwrap();
        let native_timings = native_timings.finish();
        if !matches!(resolution, ManagedCreateAdvanceCommandResolution::Advanced { .. }) {
            eprintln!("timing fixture repetition={repetition} selected={timing} resolution={resolution:?}");
            eprintln!("fixture sessions: {:?}", LocalSessionCatalog::new(&discovery).list());
            eprintln!("fixture timing: {:?}", std::fs::read_to_string(&path));
        }
        let target = advanced(resolution);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let provider_selector = std::fs::read_to_string(&marker);
        let after = std::fs::read_to_string(&path).unwrap_or_default();
        // Release only fixture-owned generations before diagnostic assertions.
        for created in [&target, &source] {
            manager
                .stop_managed_create_chain_v2(
                    app.handle(),
                    &created.idempotency_key,
                    &created.session.session_id,
                    &created.session.workspace_id,
                )
                .unwrap();
        }
        assert_eq!(provider_selector.unwrap(), "unset");
        assert_ne!(source.session.session_id, target.session.session_id);
        assert_eq!(native_timings.len(), usize::from(timing));
        if timing {
            let phases = native_timings[0]["checkpoints"].as_array().unwrap();
            for expected in [
                "launch.prepared",
                "operations.acquired",
                "runtime.resolved",
                "checkout.start",
                "checkout.store.ready",
                "checkout.runtime.ready",
                "checkout.replacement.entry",
                "checkout.replay.ready",
                "checkout.source.ready",
                "checkout.independent.start",
                "checkout.independent.ready",
                "checkout.replacement.ready",
                "checkout.ready",
                "summary.ready",
            ] {
                assert!(phases.iter().any(|phase| phase["phase"] == expected));
            }
            let appended = after.strip_prefix(&previous).unwrap();
            assert_eq!(appended.lines().count(), 1);
            let record: serde_json::Value = serde_json::from_str(appended).unwrap();
            assert_eq!(record["requestId"], source.idempotency_key);
            assert_eq!(record["sessionId"], source.session.session_id);
            assert_eq!(record["outcome"], "advanced");
            assert_eq!(record["responsePublished"], true);
            assert!(record["phases"]
                .as_array()
                .unwrap()
                .iter()
                .any(|phase| phase["phase"] == "source_close"));
            assert!(record["phases"]
                .as_array()
                .unwrap()
                .iter()
                .any(|phase| phase["phase"] == "stop_reservation"
                    && phase["reservation"]["admissionLockMicros"].is_u64()
                    && phase["reservation"]["recordPublishMicros"].is_u64()));
            assert_eq!(record["truncated"], false);
            assert!(appended.len() <= 4 * 1024);
            for private in ["private-conversation", root.to_str().unwrap(), "sleep 60"] {
                assert!(!appended.contains(private));
            }
        } else {
            assert_eq!(
                after, previous,
                "diagnostics leaked into an unselected Refresh"
            );
        }
        previous = after;
        assert!(std::env::var_os("HMUX_BROKER_TIMING_REQUEST").is_none());
    }
}

#[test]
#[ignore = "run pnpm test:hmux-managed-create-compatibility"]
fn native_legacy_create_preserves_identity_while_advance_replaces_exited() {
    let state = std::env::var_os("DURE_HMUX_TEST_STATE_ROOT")
        .expect("the Hmux guardian must own this fixture");
    let home = std::env::var_os("HOME").expect("disposable HOME is required");
    assert!(Path::new(&home).starts_with(&state));
    let app_home = std::env::var_os("DURE_HOME").expect("disposable DURE_HOME is required");
    assert!(Path::new(&app_home).starts_with(&home));
    let discovery =
        std::env::var_os("HMUX_DISCOVERY_ROOT").expect("isolated discovery is required");
    assert!(Path::new(&discovery).starts_with(&state));
    let root = tempfile::tempdir().unwrap().keep();
    let app = tauri::test::mock_app();
    let manager = HmuxManager::default();
    let catalog = LocalSessionCatalog::new(discovery);

    for repetition in 0..3 {
        let before = catalog.list().unwrap().len();
        let created = manager
            .create_managed(app.handle(), launch(&root, repetition))
            .unwrap();
        let legacy =
            serde_json::to_value(LegacyManagedCreateReceipt::new(created.clone())).unwrap();
        assert!(legacy.get("state").is_none());
        assert!(legacy.get("receipt").is_none());
        assert_eq!(legacy["session"]["sessionId"], created.session.session_id);
        assert_eq!(legacy["outcome"], "created");

        let reused = manager
            .create_managed(app.handle(), launch(&root, repetition))
            .unwrap();
        assert_eq!(reused.outcome, "reused");
        assert_eq!(reused.session.stop_fence, created.session.stop_fence);
        let current = manager
            .advance_managed_create(app.handle(), launch(&root, repetition))
            .unwrap();
        let current = serde_json::to_value(current).unwrap();
        assert_eq!(current["state"], "current");
        assert_eq!(current["receipt"]["outcome"], "reused");
        assert_eq!(current["receipt"]["session"], legacy["session"]);

        let mut changed = launch(&root, repetition);
        changed.command = "sleep 61".into();
        assert!(manager.create_managed(app.handle(), changed).is_err());
        assert_eq!(catalog.list().unwrap().len(), before + 1);

        manager
            .stop_managed_session(
                app.handle(),
                &format!("compatibility-stop-source-{repetition}"),
                &created.session.session_id,
                &created.session.workspace_id,
                created.session.stop_fence.clone().unwrap(),
            )
            .unwrap();
        assert!(manager
            .create_managed(app.handle(), launch(&root, repetition))
            .is_err());
        assert_eq!(catalog.list().unwrap().len(), before + 1);

        let successor = advanced(
            manager
                .advance_managed_create(app.handle(), launch(&root, repetition))
                .unwrap(),
        );
        assert_ne!(successor.session.session_id, created.session.session_id);
        assert_ne!(successor.idempotency_key, created.idempotency_key);
        assert_eq!(successor.outcome, "created");
        let replay = advanced(
            manager
                .advance_managed_create(app.handle(), launch(&root, repetition))
                .unwrap(),
        );
        assert_eq!(replay.outcome, "reused");
        assert_eq!(replay.session.stop_fence, successor.session.stop_fence);
        assert_eq!(replay.session.session_id, successor.session.session_id);
        assert_eq!(catalog.list().unwrap().len(), before + 2);

        manager
            .stop_managed_session(
                app.handle(),
                &format!("compatibility-stop-successor-{repetition}"),
                &successor.session.session_id,
                &successor.session.workspace_id,
                successor.session.stop_fence.clone().unwrap(),
            )
            .unwrap();
        let selector = SessionSelector::new(
            &successor.session.session_id,
            Some(successor.session.workspace_id.clone()),
        );
        assert_eq!(
            catalog.open(&selector).unwrap().descriptor().lifecycle,
            SessionLifecycle::Exited
        );
        println!(
            "managed-create-compatibility repetition={repetition} legacy=raw live=reused changed=refused exited=refused advance=successor replay=reused generations=2 cleanup=stopped"
        );
    }
    // The guardian checks every owned process before retiring the fixture root,
    // including a panic before either explicit stop above.
}
