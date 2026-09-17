use hmux_client::recovery_journal::{RecoveryIdentity, request_fingerprint, reserve};
use hmux_host::local_discovery::{
    ClaimLinkage, DiscoveryKey, DiscoveryManifest, DiscoveryRoot, ExitedManifest,
    HostLifetimeIdentity, LocalEndpoint, LocalEndpointKind, ManifestCommon, ReadyManifest,
    SessionClass, StartingManifest,
};
use hmux_host::local_protocol::{
    Exit, ProcessProof, ProtocolVersion, RuntimeContext, SessionFence, VersionRange,
};
use hmux_host::provider_epoch::{ExitTombstone, ProviderExitKind};
use serde_json::Value;
use std::process::{Command, Output};

fn publish_ready(root: &DiscoveryRoot, session_id: &str) {
    let key = DiscoveryKey::new("workspace", session_id, "runner-1", 4).unwrap();
    let session = root.session(key).unwrap();
    let common = ManifestCommon {
        launch_program: None,
        schema_version: 1,
        host_build_version: "build-v1".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 1 },
        },
        capabilities: vec!["screen_snapshot".into()],
        lifetime: HostLifetimeIdentity {
            workspace_id: "workspace".into(),
            session_id: session_id.into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 4,
        },
        host_instance_id: format!("host-{session_id}"),
        provider_id: "fixture".into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: None,
        },
        host_process: ProcessProof {
            process_id: 100,
            start_marker: format!("host-start-{session_id}"),
        },
        created_unix_ms: 1,
        session_class: SessionClass::Standalone,
        session_name: Some(format!("fixture-{session_id}")),
        retirement_policy: None,
    };
    let lock = session.acquire_lifetime_lock().unwrap();
    session
        .publish_starting(
            &lock,
            StartingManifest {
                common: common.clone(),
                starting_unix_ms: 2,
            },
        )
        .unwrap();
    session
        .publish_ready(
            &lock,
            ReadyManifest {
                common,
                provider_process: ProcessProof {
                    process_id: 101,
                    start_marker: format!("provider-start-{session_id}"),
                },
                terminal_epoch: format!("terminal-{session_id}"),
                ready_output_seq: 8,
                endpoint: LocalEndpoint {
                    kind: LocalEndpointKind::UnixSocket,
                    address: "host.sock".into(),
                },
                capability_token: format!("token-{session_id}"),
                ready_unix_ms: 3,
            },
        )
        .unwrap();
}

fn publish_exited(root: &DiscoveryRoot, session_id: &str) {
    publish_ready(root, session_id);
    let key = DiscoveryKey::new("workspace", session_id, "runner-1", 4).unwrap();
    let session = root.open_session(key).unwrap();
    let lock = session.acquire_lifetime_lock().unwrap();
    let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
        panic!("fixture must be ready before exit");
    };
    session
        .publish_exited(
            &lock,
            ExitedManifest {
                common: ready.common.clone(),
                tombstone: Box::new(ExitTombstone {
                    fence: SessionFence {
                        workspace_id: "workspace".into(),
                        session_id: session_id.into(),
                        runner_principal: "runner".into(),
                        runner_instance: "runner-1".into(),
                        channel_epoch: 4,
                        host_instance_id: ready.common.host_instance_id.clone(),
                        terminal_epoch: ready.terminal_epoch.clone(),
                    },
                    provider_process: ready.provider_process.clone(),
                    exit: Exit {
                        final_output_seq: ready.ready_output_seq,
                        exit_code: Some(0),
                        platform_status: None,
                        reason: "provider_exit".into(),
                    },
                    exit_kind: ProviderExitKind::Normal,
                    created_unix_ms: 4,
                    failure: None,
                }),
                endpoint: ready.endpoint,
                capability_token: ready.capability_token,
                exited_unix_ms: 4,
            },
        )
        .unwrap();
}

fn hmux(root: &DiscoveryRoot, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_hmux"))
        .arg("--discovery-root")
        .arg(root.path())
        .args(arguments)
        .output()
        .unwrap()
}

fn successful_json(output: Output) -> Value {
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn cli_preview_is_pure_and_exact_apply_is_idempotent_without_touching_ready_state() {
    let temp = tempfile::tempdir().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    publish_exited(&root, "exited");
    publish_ready(&root, "recoverable-ready");
    for index in 0..129 {
        std::fs::write(root.path().join(format!("debris-{index}")), b"broken").unwrap();
    }

    let preview = successful_json(hmux(
        &root,
        &[
            "session",
            "cleanup-exited",
            "exited",
            "--workspace",
            "workspace",
            "--json",
        ],
    ));
    assert_eq!(preview["mode"], "preview");
    assert_eq!(preview["results"][0]["outcome"], "retirable");
    assert!(
        !root.path().join(".recovery").exists(),
        "CLI preview created recovery state"
    );
    let human_preview = hmux(
        &root,
        &[
            "session",
            "cleanup-exited",
            "exited",
            "--workspace",
            "workspace",
        ],
    );
    assert!(human_preview.status.success());
    assert!(
        String::from_utf8_lossy(&human_preview.stdout)
            .contains("apply requires each JSON result.generation")
    );
    let generation = serde_json::to_string(&preview["results"][0]["generation"]).unwrap();

    let apply_without_preview_authority = hmux(
        &root,
        &[
            "session",
            "cleanup-exited",
            "exited",
            "--workspace",
            "workspace",
            "--apply",
            "--json",
        ],
    );
    assert!(!apply_without_preview_authority.status.success());
    assert_eq!(root.list_sessions().unwrap().len(), 2);

    let stale_epoch = successful_json(hmux(
        &root,
        &[
            "session",
            "cleanup-exited",
            "exited",
            "--workspace",
            "workspace",
            "--expected-terminal-epoch",
            "terminal-from-an-older-list",
            "--expected-generation-json",
            &generation,
            "--apply",
            "--json",
        ],
    ));
    assert_eq!(stale_epoch["results"][0]["outcome"], "skipped");
    assert_eq!(stale_epoch["results"][0]["reason"], "epoch_changed");
    assert_eq!(root.list_sessions().unwrap().len(), 2);

    let apply = successful_json(hmux(
        &root,
        &[
            "session",
            "cleanup-exited",
            "exited",
            "--workspace",
            "workspace",
            "--expected-generation-json",
            &generation,
            "--apply",
            "--json",
        ],
    ));
    assert_eq!(apply["results"][0]["outcome"], "retired");
    assert_eq!(root.list_sessions().unwrap().len(), 1);
    assert_eq!(
        root.list_sessions().unwrap()[0].key.session_id(),
        "recoverable-ready"
    );

    let retry = successful_json(hmux(
        &root,
        &[
            "session",
            "cleanup-exited",
            "exited",
            "--workspace",
            "workspace",
            "--expected-generation-json",
            &generation,
            "--apply",
            "--json",
        ],
    ));
    assert_eq!(retry["results"][0]["outcome"], "already_retired");
    assert_eq!(root.list_sessions().unwrap().len(), 1);

    let capabilities = successful_json(hmux(&root, &["capabilities", "--json"]));
    assert!(
        capabilities["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "exited_session_cleanup_v1")
    );
}

#[test]
fn cli_exited_census_reports_has_more_instead_of_failing_at_129_candidates() {
    let temp = tempfile::tempdir().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    for index in (0..129).rev() {
        publish_exited(&root, &format!("exited-{index:03}"));
    }
    let pending_recoveries = (0..128)
        .map(|index| {
            let recovery_id = format!("pending-{index:03}");
            reserve(
                root.path(),
                RecoveryIdentity {
                    recovery_id: recovery_id.clone(),
                    source_session_id: format!("exited-{index:03}"),
                    source_workspace_id: "workspace".into(),
                    request_fingerprint: request_fingerprint(&[&recovery_id]),
                    action: "cleanup-exited-cursor-test",
                },
            )
            .unwrap()
        })
        .collect::<Vec<_>>();

    let preview = successful_json(hmux(&root, &["session", "cleanup-exited", "--json"]));
    assert_eq!(preview["evaluated"], 128);
    assert_eq!(preview["retirable"], 0);
    assert_eq!(preview["skipped"], 128);
    assert_eq!(preview["hasMore"], true);
    assert_eq!(preview["results"][0]["sessionId"], "exited-000");
    assert_eq!(preview["results"][0]["reason"], "recovery_pending");
    assert_eq!(preview["results"][127]["sessionId"], "exited-127");
    let cursor = serde_json::to_string(&preview["nextCursor"]).unwrap();
    let next_page = successful_json(hmux(
        &root,
        &[
            "session",
            "cleanup-exited",
            "--after-cursor-json",
            &cursor,
            "--json",
        ],
    ));
    assert_eq!(next_page["evaluated"], 1);
    assert_eq!(next_page["hasMore"], false);
    assert_eq!(next_page["results"][0]["sessionId"], "exited-128");

    let exact_beyond_page = successful_json(hmux(
        &root,
        &[
            "session",
            "cleanup-exited",
            "exited-128",
            "--workspace",
            "workspace",
            "--json",
        ],
    ));
    assert_eq!(exact_beyond_page["evaluated"], 1);
    assert_eq!(exact_beyond_page["results"][0]["sessionId"], "exited-128");
    assert_eq!(exact_beyond_page["results"][0]["outcome"], "retirable");
    drop(pending_recoveries);
}
