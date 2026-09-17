use super::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::time::Duration;

struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    accounts: PathBuf,
    a: PathBuf,
    b: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let accounts = home.join(".dure/accounts");
        let a = accounts.join("claude-a");
        let b = accounts.join("claude-b");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        Self {
            _temp: temp,
            home,
            accounts,
            a,
            b,
        }
    }

    fn path(&self, source: &str) -> PathBuf {
        match source {
            "default" => self.home.join(STATE_FILE),
            "a" => self.a.join(STATE_FILE),
            "b" => self.b.join(STATE_FILE),
            _ => unreachable!(),
        }
    }

    fn write(&self, source: &str, value: Value) {
        std::fs::write(
            self.path(source),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }

    fn read(&self, source: &str) -> Value {
        serde_json::from_slice(&std::fs::read(self.path(source)).unwrap()).unwrap()
    }

    fn edit(&self, source: &str, edit: impl FnOnce(&mut Map<String, Value>)) {
        let mut value = self.read(source);
        edit(value.as_object_mut().unwrap());
        self.write(source, value);
    }

    fn converge(&self, current: &Path) -> Result<(), String> {
        converge(&self.home, &self.accounts, Some(current), None)
    }
}

fn identity(name: &str, servers: Value) -> Value {
    json!({
        "oauthAccount": { "accountUuid": name },
        "mcpServers": servers,
        "projects": {
            "/workspace": {
                "hasTrustDialogAccepted": true,
                "lastSessionId": format!("session-{name}")
            }
        }
    })
}

fn server(command: &str) -> Value {
    json!({ "command": command })
}

#[test]
fn independent_add_and_remove_deltas_converge_without_resurrecting_a_server() {
    let fixture = Fixture::new();
    fixture.write(
        "default",
        identity("default", json!({ "keep": server("keep") })),
    );
    fixture.write("a", identity("a", json!({ "remove": server("remove") })));
    fixture.write("b", identity("b", json!({})));
    fixture.converge(&fixture.a).unwrap();

    fixture.edit("a", |document| {
        let servers = document
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .unwrap();
        servers.remove("remove");
        servers.insert("from-a".into(), server("a"));
    });
    fixture.edit("b", |document| {
        document
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert("from-b".into(), server("b"));
    });
    fixture.converge(&fixture.b).unwrap();

    for source in ["default", "a", "b"] {
        let document = fixture.read(source);
        assert!(document["mcpServers"]["keep"].is_object());
        assert!(document["mcpServers"]["from-a"].is_object());
        assert!(document["mcpServers"]["from-b"].is_object());
        assert!(document["mcpServers"].get("remove").is_none());
    }
}

#[test]
fn same_key_conflict_uses_the_latest_complete_definition() {
    let fixture = Fixture::new();
    fixture.write(
        "default",
        identity("default", json!({ "same": server("initial") })),
    );
    fixture.write("a", identity("a", json!({})));
    fixture.write("b", identity("b", json!({})));
    fixture.converge(&fixture.a).unwrap();

    fixture.edit("a", |document| {
        document
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert("same".into(), server("a"));
    });
    std::thread::sleep(Duration::from_millis(5));
    fixture.edit("b", |document| {
        document
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert("same".into(), server("b"));
    });
    fixture.converge(&fixture.b).unwrap();

    for source in ["default", "a", "b"] {
        assert_eq!(fixture.read(source)["mcpServers"]["same"]["command"], "b");
    }
}

#[test]
fn convergence_preserves_unreviewed_project_state_and_empty_project_containers() {
    let fixture = Fixture::new();
    fixture.write(
        "default",
        json!({
            "oauthAccount": { "accountUuid": "default" },
            "projects": {
                "/empty": {},
                "/private": {
                    "lastSessionId": "private-session",
                    "hasTrustDialogAccepted": true
                }
            }
        }),
    );
    fixture.write("a", identity("a", json!({})));
    fixture.write("b", identity("b", json!({})));
    fixture.converge(&fixture.a).unwrap();

    let document = fixture.read("default");
    assert_eq!(document["projects"]["/empty"], json!({}));
    assert_eq!(
        document["projects"]["/private"]["lastSessionId"],
        "private-session"
    );
    assert_eq!(
        document["projects"]["/private"]["hasTrustDialogAccepted"],
        true
    );
}

#[test]
fn fault_rolls_back_published_files_and_never_puts_mcp_secrets_in_the_error() {
    let fixture = Fixture::new();
    fixture.write("default", identity("default", json!({})));
    fixture.write("a", identity("a", json!({})));
    fixture.write("b", identity("b", json!({})));
    fixture.converge(&fixture.a).unwrap();
    let default_before = std::fs::read(fixture.path("default")).unwrap();
    let b_before = std::fs::read(fixture.path("b")).unwrap();
    let manifest = fixture.accounts.join(MANIFEST_FILE);
    let manifest_before = std::fs::read(&manifest).unwrap();

    fixture.edit("a", |document| {
        document.insert(
            "mcpServers".into(),
            json!({
                "secret-server": {
                    "type": "http",
                    "url": "https://fixture.invalid",
                    "headers": { "Authorization": "Bearer never-log-this" }
                }
            }),
        );
    });
    let a_after_edit = std::fs::read(fixture.path("a")).unwrap();
    let error = converge(&fixture.home, &fixture.accounts, Some(&fixture.a), Some(1)).unwrap_err();

    assert!(error.starts_with("credential_overlay_fault_injected:"));
    assert!(!error.contains("never-log-this"));
    assert_eq!(
        std::fs::read(fixture.path("default")).unwrap(),
        default_before
    );
    assert_eq!(std::fs::read(fixture.path("a")).unwrap(), a_after_edit);
    assert_eq!(std::fs::read(fixture.path("b")).unwrap(), b_before);
    assert_eq!(std::fs::read(&manifest).unwrap(), manifest_before);
    fixture.converge(&fixture.b).unwrap();
}

#[test]
fn malformed_registered_source_pauses_convergence_without_advancing_the_authority() {
    let fixture = Fixture::new();
    for source in ["default", "a", "b"] {
        fixture.write(
            source,
            identity(source, json!({ "retained": server("retained") })),
        );
    }
    fixture.converge(&fixture.a).unwrap();
    let default_before = std::fs::read(fixture.path("default")).unwrap();
    let manifest = fixture.accounts.join(MANIFEST_FILE);
    let manifest_before = std::fs::read(&manifest).unwrap();

    fixture.edit("a", |document| {
        document
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .unwrap()
            .remove("retained");
    });
    std::fs::write(fixture.path("b"), b"not-json").unwrap();
    let error = fixture.converge(&fixture.a).unwrap_err();

    assert!(error.starts_with("credential_shared_state_source_invalid:"));
    assert_eq!(
        std::fs::read(fixture.path("default")).unwrap(),
        default_before
    );
    assert_eq!(std::fs::read(manifest).unwrap(), manifest_before);
}

#[test]
fn generation_change_after_staging_is_retried_without_overwriting_the_new_writer() {
    let fixture = Fixture::new();
    fixture.write("default", identity("default", json!({})));
    let path = fixture.path("default");
    let expected = version(&path, "credential_shared_state_source_untrusted").unwrap();
    let external = serde_json::to_vec(&json!({ "externalWriter": true })).unwrap();
    let mut transaction = OverlayTransaction::default();
    let mut fault = FaultInjection::default();

    let result = atomic_replace_regular_file(
        &path,
        &mut transaction,
        &mut fault,
        |file| {
            file.write_all(b"{\"staged\":true}")
                .map_err(|error| error.to_string())
        },
        || {
            std::fs::write(&path, &external).unwrap();
            unchanged(&path, expected, "credential_shared_state_source_untrusted")
        },
    );

    assert!(
        result
            .unwrap_err()
            .starts_with("credential_shared_state_retry:")
    );
    assert_eq!(std::fs::read(path).unwrap(), external);
}

#[test]
fn rollback_preserves_an_in_place_external_write_to_the_published_generation() {
    let fixture = Fixture::new();
    fixture.write("default", identity("default", json!({})));
    let path = fixture.path("default");
    let external = serde_json::to_vec(&json!({ "externalWriter": true })).unwrap();
    let mut transaction = OverlayTransaction::default();
    let mut fault = FaultInjection {
        fail_after: Some(1),
        mutations: 0,
    };

    let result = atomic_replace_regular_file(
        &path,
        &mut transaction,
        &mut fault,
        |file| {
            file.write_all(b"{\"published\":true}")
                .map_err(|error| error.to_string())
        },
        || Ok(()),
    );
    assert!(
        result
            .unwrap_err()
            .starts_with("credential_overlay_fault_injected:")
    );
    std::fs::write(&path, &external).unwrap();
    drop(transaction);

    assert_eq!(std::fs::read(path).unwrap(), external);
}

#[test]
fn concurrent_profile_prepares_share_one_manifest_and_are_idempotent() {
    let fixture = Fixture::new();
    fixture.write(
        "default",
        identity("default", json!({ "default": server("default") })),
    );
    fixture.write("a", identity("a", json!({ "a": server("a") })));
    fixture.write("b", identity("b", json!({ "b": server("b") })));

    std::thread::scope(|scope| {
        let first = scope.spawn(|| fixture.converge(&fixture.a));
        let second = scope.spawn(|| fixture.converge(&fixture.b));
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();
    });
    fixture.converge(&fixture.a).unwrap();

    for source in ["default", "a", "b"] {
        let document = fixture.read(source);
        for server in ["default", "a", "b"] {
            assert!(document["mcpServers"][server].is_object());
        }
    }
    assert_eq!(
        std::fs::metadata(fixture.accounts.join(MANIFEST_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn provider_launch_converges_shared_state_without_moving_identity_or_session() {
    let fixture = Fixture::new();
    let project = "/workspace/shared";
    fixture.write(
        "default",
        json!({
            "oauthAccount": { "accountUuid": "default-account" },
            "mcpServers": {
                "default-server": { "command": "/bin/default" }
            },
            "projects": {
                project: {
                    "hasTrustDialogAccepted": true,
                    "mcpServers": {
                        "default-local": { "command": "/bin/default-local" }
                    },
                    "lastSessionId": "default-session"
                }
            }
        }),
    );
    fixture.write(
        "a",
        json!({
            "oauthAccount": { "accountUuid": "account-a" },
            "mcpServers": {
                "profile-server": {
                    "command": "/bin/profile",
                    "env": { "PRIVATE_TOKEN": "fixture-secret" }
                }
            },
            "projects": {
                project: {
                    "enabledMcpjsonServers": ["project-server"],
                    "mcpServers": {
                        "profile-local": { "command": "/bin/profile-local" }
                    },
                    "lastSessionId": "profile-a-session"
                }
            }
        }),
    );
    fixture.write(
        "b",
        json!({
            "oauthAccount": { "accountUuid": "account-b" },
            "projects": {
                project: { "lastSessionId": "profile-b-session" }
            }
        }),
    );

    for (credential, profile) in [("acc-a", &fixture.a), ("acc-b", &fixture.b)] {
        crate::prepare_managed_provider_profile(
            "claude",
            fixture.home.to_str().unwrap(),
            Some(credential),
            Some(profile.to_str().unwrap()),
        )
        .unwrap();
    }

    for (source, identity, session) in [
        ("default", "default-account", "default-session"),
        ("a", "account-a", "profile-a-session"),
        ("b", "account-b", "profile-b-session"),
    ] {
        let document = fixture.read(source);
        assert_eq!(document["oauthAccount"]["accountUuid"], identity);
        assert_eq!(document["projects"][project]["lastSessionId"], session);
        assert!(document["mcpServers"]["default-server"].is_object());
        assert!(document["mcpServers"]["profile-server"].is_object());
        assert!(document["projects"][project]["hasTrustDialogAccepted"].is_boolean());
        assert!(document["projects"][project]["mcpServers"]["default-local"].is_object());
        assert!(document["projects"][project]["mcpServers"]["profile-local"].is_object());
        assert_eq!(
            document["projects"][project]["enabledMcpjsonServers"],
            json!(["project-server"])
        );
    }

    fixture.edit("a", |document| {
        document
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert("after-profile".into(), server("after-profile"));
        document["projects"][project]["hasTrustDialogAccepted"] = Value::Bool(false);
    });
    crate::prepare_managed_provider_profile("claude", fixture.home.to_str().unwrap(), None, None)
        .unwrap();
    for source in ["default", "b"] {
        let document = fixture.read(source);
        assert!(document["mcpServers"]["after-profile"].is_object());
        assert_eq!(
            document["projects"][project]["hasTrustDialogAccepted"],
            false
        );
        assert!(document["projects"][project]["lastSessionId"].is_string());
    }
}

#[test]
fn malformed_optional_shared_state_never_blocks_selected_or_default_launch() {
    let fixture = Fixture::new();
    std::fs::write(fixture.path("default"), b"not-json").unwrap();
    std::fs::write(fixture.path("a"), b"also-not-json").unwrap();

    let selected = crate::prepare_managed_provider_profile(
        "claude",
        fixture.home.to_str().unwrap(),
        Some("acc-work"),
        Some(fixture.a.to_str().unwrap()),
    )
    .unwrap();
    assert_eq!(
        selected
            .values()
            .get("CLAUDE_CONFIG_DIR")
            .map(String::as_str),
        std::fs::canonicalize(&fixture.a).unwrap().to_str()
    );
    let default = crate::prepare_managed_provider_profile(
        "claude",
        fixture.home.to_str().unwrap(),
        None,
        None,
    )
    .unwrap();
    assert!(default.removals().contains("CLAUDE_CONFIG_DIR"));
    assert_eq!(std::fs::read(fixture.path("default")).unwrap(), b"not-json");
    assert_eq!(std::fs::read(fixture.path("a")).unwrap(), b"also-not-json");
}

#[test]
#[ignore = "requires an installed Claude Code CLI"]
fn real_claude_cli_add_remove_and_list_converges_across_default_and_two_profiles() {
    let fixture = Fixture::new();
    let project = fixture.home.join("project");
    std::fs::create_dir(&project).unwrap();
    let run = |profile: Option<&Path>, arguments: &[&str]| {
        let mut command = Command::new("claude");
        command.current_dir(&project).env("HOME", &fixture.home);
        if let Some(profile) = profile {
            command.env("CLAUDE_CONFIG_DIR", profile);
        }
        command.args(arguments).output().unwrap()
    };
    for (profile, name) in [
        (None, "default-user"),
        (Some(fixture.a.as_path()), "profile-a-user"),
        (Some(fixture.b.as_path()), "profile-b-user"),
    ] {
        let output = run(
            profile,
            &["mcp", "add", "--scope", "user", name, "--", "/usr/bin/true"],
        );
        assert!(output.status.success());
    }
    let local = run(
        Some(&fixture.a),
        &[
            "mcp",
            "add",
            "--scope",
            "local",
            "profile-local",
            "--",
            "/usr/bin/true",
        ],
    );
    assert!(local.status.success());
    fixture.converge(&fixture.a).unwrap();

    for profile in [None, Some(fixture.a.as_path()), Some(fixture.b.as_path())] {
        let output = run(profile, &["mcp", "list"]);
        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        for name in [
            "default-user",
            "profile-a-user",
            "profile-b-user",
            "profile-local",
        ] {
            assert!(stdout.contains(name), "{name} missing from Claude MCP list");
        }
    }

    let removed = run(
        Some(&fixture.a),
        &["mcp", "remove", "--scope", "user", "profile-a-user"],
    );
    assert!(removed.status.success());
    fixture.converge(&fixture.b).unwrap();
    for source in ["default", "a", "b"] {
        assert!(
            fixture.read(source)["mcpServers"]
                .get("profile-a-user")
                .is_none()
        );
    }
}
