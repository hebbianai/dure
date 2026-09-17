//! The runtime sidecar serves the same reclaimable discovery contracts as the CLI.

use hmux_client::{
    CatalogCensusError, CatalogCensusWorker, ExactDiscoveryWorker, ExactSessionProbeResult,
    LocalSessionCatalog, SessionSelector, inspect_local_sessions_exact_isolated,
    list_local_sessions_isolated, resolve_local_session_id_isolated,
    resolve_local_session_isolated,
};
use hmux_host::local_discovery::{
    ClaimLinkage, DiscoveryKey, DiscoveryRoot, HostLifetimeIdentity, LocalEndpoint,
    LocalEndpointKind, ManifestCommon, ManifestLimits, ReadyManifest, SessionClass,
    StartingManifest,
};
use hmux_host::local_protocol::{ProcessProof, ProtocolVersion, RuntimeContext, VersionRange};
use std::path::PathBuf;
use std::time::Duration;

fn publish_ready(root: &DiscoveryRoot, workspace_id: &str, session_id: &str) -> DiscoveryKey {
    let key = DiscoveryKey::new(workspace_id, session_id, "runner-1", 4).unwrap();
    let session = root.session(key.clone()).unwrap();
    let common = ManifestCommon {
        launch_program: None,
        schema_version: 1,
        host_build_version: "build-v1".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 1 },
        },
        capabilities: Vec::new(),
        lifetime: HostLifetimeIdentity {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 4,
        },
        host_instance_id: format!("host-{workspace_id}"),
        provider_id: "fixture".into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: None,
        },
        host_process: ProcessProof {
            process_id: 2_000_000_000,
            start_marker: format!("host-{workspace_id}"),
        },
        created_unix_ms: 1,
        session_class: SessionClass::Standalone,
        session_name: Some(format!("name-{workspace_id}")),
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
                    process_id: 2_000_000_001,
                    start_marker: format!("provider-{workspace_id}"),
                },
                terminal_epoch: format!("terminal-{workspace_id}"),
                ready_output_seq: 8,
                endpoint: LocalEndpoint {
                    kind: LocalEndpointKind::UnixSocket,
                    address: "host.sock".into(),
                },
                capability_token: format!("token-{workspace_id}"),
                ready_unix_ms: 3,
            },
        )
        .unwrap();
    key
}

#[test]
fn runtime_sidecar_serves_a_complete_private_census() {
    let fixture = tempfile::tempdir().unwrap();
    let discovery_root = fixture.path().join("discovery");
    DiscoveryRoot::create(&discovery_root).unwrap();
    let catalog = LocalSessionCatalog::new(discovery_root);
    let worker = CatalogCensusWorker::new(PathBuf::from(env!("CARGO_BIN_EXE_hmux-runtime")));

    let sessions = list_local_sessions_isolated(&catalog, &worker, Duration::from_secs(1))
        .expect("the staged runtime contract must return a complete empty census");

    assert!(sessions.is_empty());
}

#[test]
fn runtime_sidecar_serves_an_exact_private_lookup() {
    let fixture = tempfile::tempdir().unwrap();
    let discovery_root = fixture.path().join("discovery");
    DiscoveryRoot::create(&discovery_root).unwrap();
    let catalog = LocalSessionCatalog::new(discovery_root);
    let worker = ExactDiscoveryWorker::new(PathBuf::from(env!("CARGO_BIN_EXE_hmux-runtime")));
    let selector = SessionSelector::new("known-pane", Some("known-workspace".into()));

    let results = inspect_local_sessions_exact_isolated(
        &catalog,
        &worker,
        vec![selector.clone()],
        1,
        Duration::from_secs(1),
    )
    .expect("the staged runtime contract must accept exact lookup requests");

    assert_eq!(results, vec![ExactSessionProbeResult::NotFound(selector)]);
}

#[test]
fn exact_session_id_bypasses_an_unrelated_census_scan_overflow() {
    let fixture = tempfile::tempdir().unwrap();
    let discovery_root = fixture.path().join("discovery");
    let root = DiscoveryRoot::create(&discovery_root).unwrap();
    let target = publish_ready(&root, "workspace-a", "session-target");
    let workspace_path = root.path().join(target.relative_path().parent().unwrap());
    for index in 0..ManifestLimits::default().max_session_census_scan_entries {
        std::fs::write(workspace_path.join(format!("s_unrelated-{index}")), []).unwrap();
    }
    let catalog = LocalSessionCatalog::new(discovery_root);
    let worker = CatalogCensusWorker::new(PathBuf::from(env!("CARGO_BIN_EXE_hmux-runtime")));

    assert!(matches!(
        list_local_sessions_isolated(&catalog, &worker, Duration::from_secs(5)),
        Err(CatalogCensusError::LookupFailed { error_code })
            if error_code == "hmux_discovery_scan_limit"
    ));

    let session =
        resolve_local_session_isolated(&catalog, &worker, "session-target", Duration::from_secs(5))
            .unwrap();
    assert_eq!(session.descriptor().workspace_id, "workspace-a");
    assert_eq!(session.descriptor().session_id, "session-target");
}

#[test]
fn exact_session_id_worker_refuses_cross_workspace_ambiguity() {
    let fixture = tempfile::tempdir().unwrap();
    let discovery_root = fixture.path().join("discovery");
    let root = DiscoveryRoot::create(&discovery_root).unwrap();
    publish_ready(&root, "workspace-a", "session-duplicate");
    publish_ready(&root, "workspace-b", "session-duplicate");
    let catalog = LocalSessionCatalog::new(discovery_root);
    let worker = CatalogCensusWorker::new(PathBuf::from(env!("CARGO_BIN_EXE_hmux-runtime")));

    let error = resolve_local_session_id_isolated(
        &catalog,
        &worker,
        "session-duplicate",
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert_eq!(error.code(), "hmux_session_ambiguous");
}
