//! CLI composition over real broker, Host and PTY fixtures, under the existing QA guardian.

use super::*;

#[path = "rehost_cli/named.rs"]
mod named;

#[test]
#[ignore = "run pnpm test:hmux-rehost-cli with the isolated test guardian and built CLI"]
fn dure_start_and_retry_preserve_one_operation_and_successor() {
    let state = std::path::PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    let cli = std::path::PathBuf::from(std::env::var_os("DURE_QA_HMUX_BIN").unwrap())
        .canonicalize()
        .unwrap();
    let dure = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../cli/dure.mjs");
    let group = std::env::var("DURE_QA_REHOST_GROUP").unwrap();
    assert!(["admission", "start", "retry"].contains(&group.as_str()));
    for (action, fault, competing) in [
        ("start", "none", false),
        ("start", "none", true),
        ("retry", "after_payload_journaled", false),
        ("retry", "after_source_stop", false),
        ("retry", "after_replacement_create", false),
        ("start", "after_payload_journaled", false),
        ("start", "after_source_stop", false),
        ("start", "after_replacement_create", false),
        ("start", "no_conversation", false),
        ("start", "exited_conversation", false),
        ("start", "exited_no_conversation", false),
    ] {
        let journaled = fault.starts_with("after_");
        if (if journaled { action } else { "admission" }) != group {
            continue;
        }
        let case = format!("{action}-{fault}-{competing}");
        eprintln!("rehost CLI case: {case}");
        let cwd = state.join(&case);
        fs::create_dir(&cwd).unwrap();
        let discovery = cwd.join("discovery");
        let marker = cwd.join("conversation");
        let mut source_request = rehostable_create_request(&cwd, &marker, &case);
        if matches!(
            fault,
            "no_conversation" | "exited_conversation" | "exited_no_conversation"
        ) {
            let mut wire = serde_json::to_value(&source_request).unwrap();
            wire.as_object_mut()
                .unwrap()
                .remove("conversationIdentity")
                .unwrap();
            if fault.starts_with("exited_") {
                wire["providerId"] = "claude".into();
                wire["command"] = serde_json::json!([
                    "/bin/sh",
                    "-c",
                    "while [ ! -f exit-provider ]; do sleep 0.05; done"
                ]);
            }
            source_request = serde_json::from_value(wire).unwrap();
        }
        let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery)
            .create(source_request)
            .unwrap();
        let source = created.session().descriptor().clone();
        if fault.starts_with("exited_") {
            if fault == "exited_conversation" {
                // No launch seed and no client pane. Follow a provider-reported
                // continuation so rehost must use the final identity, not the first.
                let initial = format!("conversation-initial-{case}");
                publish_provider_conversation_identity(
                    &discovery, &cwd, &source, "claude", &initial,
                );
                publish_provider_conversation_identity_with_predecessor(
                    &discovery,
                    &cwd,
                    &source,
                    "claude",
                    &format!("conversation-{case}"),
                    Some(initial),
                );
            }
            fs::write(cwd.join("exit-provider"), b"exit").unwrap();
            wait_for_exited(&discovery, &source.session_id, &source.workspace_id);
            if fault == "exited_conversation" {
                let stale = exact_managed_rehost_request(format!("stale-{case}"), &source, true)
                    .with_expected_conversation_id(format!("conversation-initial-{case}"))
                    .unwrap();
                let error = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
                    .with_discovery_root(&discovery)
                    .rehost(stale)
                    .unwrap_err();
                assert_eq!(error.code(), "hmux_managed_rehost_identity_mismatch");
                assert!(
                    !marker.exists(),
                    "a stale conversation must not launch a successor"
                );
            }
        }
        let operation = format!("cli-{case}");
        let request = exact_managed_rehost_request(&operation, &source, true);
        if journaled {
            run_crashing_managed_rehost(&discovery, &cwd, &request, fault);
        }

        let invoke_selected =
            |action: &str, operation: &str, confirm: bool, operation_only: bool| {
                let mut command = Command::new("node");
                command.arg(&dure).args(["hmux", "rehost", action]);
                if !operation_only {
                    command.args([&source.session_id, "--workspace", &source.workspace_id]);
                }
                command.args(["--operation-id", operation, "--json"]);
                if confirm {
                    command.arg("--confirm-restart");
                }
                command
                    .current_dir(&cwd)
                    .env("HOME", &cwd)
                    .env("DURE_HOME", cwd.join("app"))
                    .env("DURE_APP_CHANNEL", "stable")
                    .env_remove("HEBBIAN_APP_CHANNEL")
                    .env("DURE_HMUX_BIN", &cli)
                    .env("HMUX_DISCOVERY_ROOT", &discovery)
                    .env("HMUX_RUNTIME", env!("CARGO_BIN_EXE_hmux-runtime"))
                    .env_remove(MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV)
                    .output()
                    .unwrap()
            };
        let invoke = |action: &str, operation: &str, confirm: bool| {
            invoke_selected(action, operation, confirm, false)
        };
        let unconfirmed = invoke(action, &operation, false);
        assert!(!unconfirmed.status.success());
        assert!(
            String::from_utf8_lossy(&unconfirmed.stderr)
                .contains("hmux_managed_rehost_confirmation_required")
        );
        let absent = invoke("retry", "unknown-operation", true);
        assert!(!absent.status.success());
        assert!(
            String::from_utf8_lossy(&absent.stderr)
                .contains("hmux_managed_rehost_intent_not_found")
        );
        let unknown_source = invoke_selected("retry", "unknown-operation", true, true);
        assert!(!unknown_source.status.success());
        assert!(
            String::from_utf8_lossy(&unknown_source.stderr)
                .contains("hmux_managed_rehost_operation_source_unavailable")
        );
        let observed = invoke("status", &operation, false);
        assert!(
            observed.status.success(),
            "{}",
            String::from_utf8_lossy(&observed.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&observed.stdout).unwrap()["state"],
            if journaled {
                "retry_required"
            } else {
                "not_found"
            }
        );

        if matches!(fault, "no_conversation" | "exited_no_conversation") {
            let refused = invoke("start", &operation, true);
            assert!(!refused.status.success());
            assert!(
                String::from_utf8_lossy(&refused.stderr)
                    .contains("hmux_managed_rehost_conversation_required")
            );
            assert!(!marker.exists());
            let still_source = LocalSessionCatalog::new(&discovery)
                .find(&SessionSelector::new(
                    &source.session_id,
                    Some(source.workspace_id.clone()),
                ))
                .unwrap();
            assert!(still_source.same_generation(&source));
            assert_eq!(
                still_source.lifecycle,
                if fault == "exited_no_conversation" {
                    SessionLifecycle::Exited
                } else {
                    SessionLifecycle::Ready
                }
            );
            ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
                .with_discovery_root(&discovery)
                .stop(exact_managed_stop_request(
                    format!("cli-cleanup-{case}"),
                    &source,
                ))
                .unwrap();
            wait_for_exited(&discovery, &source.session_id, &source.workspace_id);
            continue;
        }

        let duplicate_operation = if competing {
            format!("{operation}-competing")
        } else {
            operation.clone()
        };
        let (first_attempt, duplicate) = thread::scope(|scope| {
            let first =
                scope.spawn(|| invoke_selected(action, &operation, true, action == "retry"));
            let duplicate = scope.spawn(|| invoke(action, &duplicate_operation, true));
            (first.join().unwrap(), duplicate.join().unwrap())
        });
        for response in [&first_attempt, &duplicate] {
            if !response.status.success() {
                assert!(
                    String::from_utf8_lossy(&response.stderr).contains("hmux_recovery_busy")
                        || String::from_utf8_lossy(&response.stderr)
                            .contains("hmux_recovery_source_busy")
                        || (competing
                            && String::from_utf8_lossy(&response.stderr)
                                .contains("hmux_managed_rehost_source_changed")),
                    "{}",
                    String::from_utf8_lossy(&response.stderr)
                );
            }
        }
        if competing {
            assert_ne!(
                first_attempt.status.success(),
                duplicate.status.success(),
                "only one operation may retire the source"
            );
        }
        let lost_response = if first_attempt.status.success() {
            first_attempt
        } else {
            duplicate
        };
        assert!(
            lost_response.status.success(),
            "{}",
            String::from_utf8_lossy(&lost_response.stderr)
        );
        let first: hmux_client::ManagedRehostReceipt =
            serde_json::from_slice(&lost_response.stdout).unwrap();
        let operation = first.operation_id();
        wait_for_exited(&discovery, &source.session_id, &source.workspace_id);
        let root = DiscoveryRoot::open(&discovery).unwrap();
        let key = SessionLookupKey::new(&source.workspace_id, &source.session_id).unwrap();
        let manifest = root.session_base_path(&key).join("manifest.json");
        let retained_manifest = cwd.join("source-manifest.saved");
        fs::rename(&manifest, &retained_manifest).unwrap();
        let replay = invoke("start", operation, true);
        assert!(
            replay.status.success(),
            "{}",
            String::from_utf8_lossy(&replay.stderr)
        );
        let receipt: hmux_client::ManagedRehostReceipt =
            serde_json::from_slice(&replay.stdout).unwrap();
        receipt.validate().unwrap();
        assert!(receipt.replayed());
        let mut expected_receipt = serde_json::to_value(&first).unwrap();
        expected_receipt["replayed"] = true.into();
        assert_eq!(
            expected_receipt,
            serde_json::to_value(&receipt).unwrap(),
            "a fresh CLI process must replay the same receipt"
        );
        let app = cwd.join("app");
        fs::create_dir_all(&app).unwrap();
        let changed_name =
            r#"{"agents":[{"id":"other-agent","name":"worker","sessionId":"different-source"}]}"#;
        fs::write(app.join("agents.json"), changed_name).unwrap();
        let explicit_retry = invoke_selected("retry", operation, true, true);
        assert!(
            explicit_retry.status.success(),
            "{}",
            String::from_utf8_lossy(&explicit_retry.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<hmux_client::ManagedRehostReceipt>(&explicit_retry.stdout)
                .unwrap(),
            receipt
        );
        assert_eq!(
            fs::read_to_string(app.join("agents.json")).unwrap(),
            changed_name
        );
        let operation_status = invoke_selected("status", operation, false, true);
        assert!(operation_status.status.success());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&operation_status.stdout).unwrap()["sourceGeneration"]
                ["sessionId"],
            source.session_id
        );
        fs::rename(&retained_manifest, &manifest).unwrap();
        let expected = format!("conversation-{case}");
        wait_for_file_content(&marker, expected.as_bytes());
        assert_eq!(receipt.conversation_id(), Some(expected.as_str()));
        wait_for_exited(&discovery, &source.session_id, &source.workspace_id);

        let catalog = LocalSessionCatalog::new(&discovery);
        let target = catalog
            .find(&SessionSelector::new(
                receipt.replacement_receipt().session_id(),
                Some(source.workspace_id.clone()),
            ))
            .unwrap();
        assert_eq!(target.lifecycle, SessionLifecycle::Ready);
        assert_eq!(
            catalog
                .list()
                .unwrap()
                .iter()
                .filter(|entry| entry.lifecycle == SessionLifecycle::Ready)
                .count(),
            1
        );
        let observed = invoke("status", operation, false);
        assert!(observed.status.success());
        let observation: serde_json::Value = serde_json::from_slice(&observed.stdout).unwrap();
        assert_eq!(
            observation["currentGeneration"]["sessionId"],
            target.session_id
        );
        assert_eq!(
            fs::read(&marker).unwrap(),
            expected.as_bytes(),
            "no second provider launch"
        );
        let gc = garbage_collect_completed_action(
            &discovery,
            MANAGED_REHOST_RECOVERY_ACTION,
            RecoveryJournalGcPolicy {
                minimum_completed_age: Duration::ZERO,
                maximum_completed_records: 0,
                maximum_completed_bytes: 0,
                ..RecoveryJournalGcPolicy::default()
            },
        )
        .unwrap();
        assert_eq!(gc.removed_completed_records, 1);
        for action in ["status", "retry"] {
            let compacted = invoke_selected(action, operation, action == "retry", true);
            assert!(!compacted.status.success());
            assert!(
                String::from_utf8_lossy(&compacted.stderr)
                    .contains("hmux_managed_rehost_operation_source_unavailable")
            );
        }
        let compacted_start = invoke("start", operation, true);
        assert!(!compacted_start.status.success());
        assert!(
            String::from_utf8_lossy(&compacted_start.stderr)
                .contains("hmux_managed_rehost_source_changed")
        );
        let observed = invoke("status", operation, false);
        assert!(observed.status.success());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&observed.stdout).unwrap()["currentGeneration"]
                ["sessionId"],
            target.session_id
        );
        assert_eq!(
            fs::read(&marker).unwrap(),
            expected.as_bytes(),
            "compaction must not authorize another launch"
        );
        ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&discovery)
            .stop(exact_managed_stop_request(
                format!("cli-cleanup-{case}"),
                &target,
            ))
            .unwrap();
        wait_for_exited(&discovery, &target.session_id, &target.workspace_id);
    }
    // The guardian retains these roots on failure and retires them only after exact Host cleanup.
}
