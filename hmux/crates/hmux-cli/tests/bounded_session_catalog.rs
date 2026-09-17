use hmux_host::local_discovery::{
    ClaimLinkage, DiscoveryKey, DiscoveryRoot, HostLifetimeIdentity, LocalEndpoint,
    LocalEndpointKind, ManifestCommon, ReadyManifest, SessionClass, StartingManifest,
};
use hmux_host::local_protocol::{ProcessProof, ProtocolVersion, RuntimeContext, VersionRange};
use serde_json::{Value, json};
use std::process::{Command, Output};

const CAPTURE_LIMIT_BYTES: usize = 1024 * 1024;
const CATALOG_LIMIT_BYTES: usize = 960 * 1024;

fn publish_ready(root: &DiscoveryRoot, index: usize) {
    let session_id = format!("session-{index:03}");
    let key = DiscoveryKey::new("workspace", &session_id, "runner-1", 4).unwrap();
    let session = root.session(key).unwrap();
    let capabilities = (0..64)
        .map(|capability| format!("capability-{capability:02}-{}", "x".repeat(108)))
        .collect();
    let common = ManifestCommon {
        launch_program: Some("fixture-provider".into()),
        schema_version: 1,
        host_build_version: "build-v1".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 1 },
        },
        capabilities,
        lifetime: HostLifetimeIdentity {
            workspace_id: "workspace".into(),
            session_id: session_id.clone(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 4,
        },
        host_instance_id: format!("host-{index:03}"),
        provider_id: "fixture".into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: None,
        },
        host_process: ProcessProof {
            process_id: 2_000_000_000,
            start_marker: format!("host-start-{index:03}"),
        },
        created_unix_ms: 1,
        session_class: SessionClass::Managed,
        session_name: Some(format!("fixture-{index:03}")),
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
                    start_marker: format!("provider-start-{index:03}"),
                },
                terminal_epoch: format!("terminal-{index:03}"),
                ready_output_seq: 8,
                endpoint: LocalEndpoint {
                    kind: LocalEndpointKind::UnixSocket,
                    address: format!("/unreachable/{index:03}.sock"),
                },
                capability_token: format!("token-{index:03}"),
                ready_unix_ms: 3,
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

#[test]
fn bounded_query_serializes_client_priority_before_the_capture_limit() {
    let fixture = tempfile::tempdir().unwrap();
    let root = DiscoveryRoot::create(fixture.path().join("hmux")).unwrap();
    for index in 0..160 {
        publish_ready(&root, index);
    }

    let full = hmux(&root, &["--json", "session", "list", "--no-probe"]);
    assert!(full.status.success());
    assert!(
        full.stdout.len() > CAPTURE_LIMIT_BYTES,
        "fixture must reproduce the downstream capture overflow"
    );

    let query = json!({
        "schemaVersion": 1,
        "maxItems": 128,
        "maxOutputBytes": CATALOG_LIMIT_BYTES,
        "prioritized": [{
            "sessionId": "session-159",
            "workspaceId": "workspace",
        }],
    });
    let bounded = hmux(
        &root,
        &[
            "--json",
            "session",
            "list",
            "--no-probe",
            "--catalog-query-json",
            &query.to_string(),
        ],
    );
    assert!(
        bounded.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&bounded.stderr)
    );
    assert!(bounded.stdout.len() <= CATALOG_LIMIT_BYTES);
    let document: Value = serde_json::from_slice(&bounded.stdout).unwrap();
    assert_eq!(document["schemaVersion"], 1);
    assert_eq!(document["complete"], true);
    assert_eq!(document["prioritizedItems"], 1);
    assert_eq!(document["truncation"]["items"], true);
    let returned = document["sessions"].as_array().unwrap().len();
    assert!(returned <= 128);
    assert_eq!(
        document["truncation"]["omittedCount"],
        u64::try_from(160 - returned).unwrap()
    );
    assert_eq!(document["sessions"][0]["session_id"], "session-159");

    let identities = document["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|session| {
            (
                session["workspace_id"].as_str().unwrap(),
                session["session_id"].as_str().unwrap(),
            )
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(identities.len(), returned);
}

#[test]
#[ignore = "requires Node, native dure-control-plane/hmux-runtime, and a loopback sshd"]
fn backend_spaces_preserves_bounded_catalog_and_partial_membership() {
    let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    // sshd StrictModes validates every ancestor of AuthorizedKeysFile; the
    // guardian's shared /tmp ancestry cannot host that authentication fixture.
    let fixture = tempfile::Builder::new()
        .prefix("dure-bounded-catalog-")
        .tempdir_in(&repository)
        .unwrap();
    let root = DiscoveryRoot::create(fixture.path().join("discovery")).unwrap();
    for index in 0..160 {
        publish_ready(&root, index);
    }
    let output = Command::new("node")
        .arg(repository.join("scripts/qa/bounded-catalog-spaces-smoke.mjs"))
        .arg(fixture.path())
        .arg(env!("CARGO_BIN_EXE_hmux"))
        .arg(repository.join("hmux/target/debug/hmux-runtime"))
        .arg(repository.join("crates/dure-app/target/debug/dure-control-plane"))
        .output()
        .unwrap();
    if !output.status.success() {
        // Synthetic process markers do not authorize runtime cleanup. Drop
        // these inert manifests only after native QA verified its real children
        // exited; otherwise retain everything for exact process recovery.
        let retained = if fixture.path().join("native-processes-stopped").is_file() {
            None
        } else {
            Some(fixture.keep())
        };
        panic!(
            "native Spaces proof failed; retained fixture={retained:?}\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    println!("{}", String::from_utf8_lossy(&output.stdout));
}
