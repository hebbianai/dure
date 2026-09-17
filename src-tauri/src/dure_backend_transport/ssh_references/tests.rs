use super::*;
use crate::dure_backend_transport::tests::write_ssh_reference_fixture;
use serde_json::Value;

fn failures() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/dure-backend-ssh-reference-failures.json"
    ))
    .unwrap()
}

fn assert_unavailable(root: &Path, case: &str) {
    let result = resolve(
        root,
        "remote-a",
        &ProfileAuth::IdentityFile {
            reference: "credential-profile:remote-a".into(),
        },
        &ProfileTrust::KnownHosts {
            reference: "known-hosts-profile:remote-a".into(),
        },
        Compatibility {
            profile_id: None,
            known_hosts_file: None,
            identity_file: None,
        },
    );
    let error = result.expect_err(case);
    assert_eq!(
        error.code, "backend_transport_reference_unavailable",
        "{case}"
    );
    assert_eq!(
        error.message, "the backend SSH reference is unavailable",
        "{case}"
    );
}

#[test]
fn shared_catalog_failures_are_rejected_before_connect() {
    for case in failures()["catalogCases"].as_array().unwrap() {
        let root = tempfile::tempdir().unwrap();
        let paths = write_ssh_reference_fixture(root.path());
        let mut catalog = case["catalog"].clone();
        for entry in catalog["references"].as_array_mut().unwrap() {
            if let Some(path) = paths.get(entry["path"].as_str().unwrap()) {
                entry["path"] = Value::from(path.to_str().unwrap());
            }
        }
        std::fs::write(root.path().join(CATALOG_FILE), catalog.to_string()).unwrap();
        assert_unavailable(root.path(), case["name"].as_str().unwrap());
    }
}

#[test]
fn shared_file_failures_are_rejected_before_connect() {
    for case in failures()["fileCases"].as_array().unwrap() {
        let root = tempfile::tempdir().unwrap();
        let paths = write_ssh_reference_fixture(root.path());
        let target = case["target"].as_str().unwrap();
        let path = match target {
            "catalog" => root.path().join(CATALOG_FILE),
            "knownHosts" => paths["__KNOWN_HOSTS_A__"].clone(),
            "identity" => paths["__IDENTITY_A__"].clone(),
            _ => panic!("unknown target: {target}"),
        };
        match case["fault"].as_str().unwrap() {
            "mode" => {
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
            "symlink" => {
                let replacement = root.path().join("replacement");
                std::fs::rename(&path, &replacement).unwrap();
                std::os::unix::fs::symlink(replacement, &path).unwrap();
            }
            "oversize" => {
                let maximum = if target == "catalog" {
                    MAX_CATALOG_BYTES
                } else {
                    MAX_MATERIAL_BYTES
                };
                std::fs::write(&path, vec![b'x'; maximum as usize + 1]).unwrap();
            }
            "empty" => std::fs::write(&path, []).unwrap(),
            fault => panic!("unknown fault: {fault}"),
        }
        assert_unavailable(root.path(), &case.to_string());
    }
}

#[test]
fn current_user_ownership_rejects_a_foreign_uid_without_changing_credentials() {
    let current_uid = unsafe { libc::geteuid() };
    assert!(current_user_owns(current_uid));
    assert!(!current_user_owns(current_uid.wrapping_add(1)));
}

#[tokio::test]
#[ignore = "requires scripts/qa/backend-ssh-profile-isolation-smoke.mjs --tauri"]
async fn real_ssh_profiles_keep_native_authority_isolated() {
    use crate::dure_backend_transport::{
        DureBackendRouteV1, DureBackendTransportState, RuntimeConfig,
    };

    let root = PathBuf::from(
        std::env::var_os("DURE_QA_BACKEND_SSH_ROOT").expect("run the owned loopback SSH fixture"),
    );
    let catalog: Value =
        serde_json::from_slice(&std::fs::read(root.join("backend-profiles.json")).unwrap())
            .unwrap();
    let profiles = catalog["profiles"].as_array().unwrap();
    assert_eq!(profiles.len(), 2);
    for profile in profiles {
        assert_eq!(profile["transport"]["host"], "127.0.0.1");
        assert_eq!(profile["transport"]["endpoint"]["host"], "127.0.0.1");
    }
    let state = DureBackendTransportState {
        config: RuntimeConfig {
            ssh_command: PathBuf::from("/usr/bin/ssh"),
            ..RuntimeConfig::default()
        },
        ..DureBackendTransportState::default()
    };
    let mut results = Vec::new();
    for _ in 0..3 {
        for id in ["remote-a", "remote-b"] {
            let result = state
                .request(
                    &root,
                    &DureBackendRouteV1::Selected {
                        profile_id: Some(id.into()),
                    },
                    "client_view.authority.read",
                    serde_json::json!({ "schemaVersion": 1 }),
                )
                .await;
            results.push((id, result));
        }
    }
    state.close().await;
    for (id, result) in results {
        let result = result.unwrap();
        assert_eq!(result.backend_id, id);
        assert_eq!(result.result["selectedBackend"], id);
    }
}
