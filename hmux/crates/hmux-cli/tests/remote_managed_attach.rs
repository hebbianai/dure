#![cfg(unix)]

use std::process::Command;

#[test]
fn remote_managed_attach_does_not_initialize_local_discovery() {
    let root = tempfile::tempdir().unwrap();
    let missing_identity = root.path().join("missing-identity");
    let missing_known_hosts = root.path().join("missing-known-hosts");
    let fence = serde_json::json!({
        "workspace_id": "workspace-1",
        "session_id": "session-1",
        "runner_principal": "runner",
        "runner_instance": "runner-1",
        "channel_epoch": "7",
        "host_instance_id": "host-1",
        "terminal_epoch": "terminal-1",
    })
    .to_string();

    let output = Command::new(env!("CARGO_BIN_EXE_hmux"))
        .args([
            "remote-managed-attach",
            "session-1",
            "--workspace",
            "workspace-1",
            "--host",
            "remote.example.test",
            "--port",
            "2222",
            "--user",
            "dure",
            "--connect-timeout-ms",
            "1000",
            "--identity-file",
        ])
        .arg(&missing_identity)
        .arg("--known-hosts-file")
        .arg(&missing_known_hosts)
        .args(["--expected-fence-json", &fence])
        .env("HMUX_DISCOVERY_ROOT", "")
        .env_remove("HMUX")
        .output()
        .expect("run remote managed attach");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("hmux_remote_attach_reference_unavailable"),
        "{stderr}"
    );
    assert!(!stderr.contains("HMUX_DISCOVERY_ROOT"), "{stderr}");
}
