use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};

use dure_control_plane::control_plane_identity;

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

#[test]
fn manifest_rust_identity_and_node_projection_conform() {
    let root = repository_root();
    let manifest_path = root.join("cli/lib/control-plane-build-identity.json");
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let rust = serde_json::to_value(control_plane_identity()).unwrap();
    assert_eq!(rust["buildId"], manifest["currentBuildId"]);
    assert_eq!(rust["apiVersion"], manifest["identity"]["apiVersion"]);
    assert_eq!(rust["kind"], manifest["identity"]["kind"]);
    assert_eq!(rust["capabilities"], manifest["identity"]["capabilities"]);

    let module = root.join("cli/lib/control-plane-contract.mjs");
    let observed = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            "const contract = await import(process.argv[1]); process.stdout.write(JSON.stringify({ currentBuildId: contract.CONTROL_PLANE_BUILD_ID, previousBuildId: contract.PREVIOUS_CONTROL_PLANE_BUILD_ID, apiVersion: contract.CONTROL_PLANE_IDENTITY_API_VERSION, kind: contract.CONTROL_PLANE_IDENTITY_KIND, capabilities: contract.CONTROL_PLANE_CAPABILITIES }));",
        ])
        .arg(format!("file://{}", module.display()))
        .output()
        .unwrap();
    assert!(
        observed.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&observed.stdout),
        String::from_utf8_lossy(&observed.stderr)
    );
    let node: Value = serde_json::from_slice(&observed.stdout).unwrap();
    assert_eq!(
        node,
        json!({
            "currentBuildId": manifest["currentBuildId"],
            "previousBuildId": manifest["previousBuildId"],
            "apiVersion": manifest["identity"]["apiVersion"],
            "kind": manifest["identity"]["kind"],
            "capabilities": manifest["identity"]["capabilities"]
        })
    );
}

#[test]
fn runtime_lifecycle_is_fully_advertised() {
    let capabilities = &control_plane_identity().capabilities;
    for operation in [
        "agent_runtime.inspect",
        "agent_runtime.hibernate",
        "agent_runtime.idle.configure",
        "agent_runtime.idle.inspect",
        "agent_runtime.wake",
        "agent_runtime.native_rehost.reconcile",
        "agent_runtime.native_resume.publish",
        "agent_runtime.projection.inspect",
        "agent_runtime.repair",
        "agent_runtime.repair_intent.inspect.v1",
        "agent_runtime.stop",
        "agent_runtime.remove",
        "agent_runtime.transition",
    ] {
        assert!(
            capabilities.contains(&operation),
            "control-plane build identity does not advertise {operation}",
        );
    }
}
