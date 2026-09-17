use super::*;

struct Profile {
    temporary: tempfile::TempDir,
    canonical: PathBuf,
    account: PathBuf,
}

impl Profile {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let canonical = temporary.path().join(".codex");
        let account = temporary.path().join(".dure/accounts/codex-refresh");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(canonical.join("config.toml"), "model = 'fixture'\n").unwrap();
        std::fs::write(canonical.join("hooks.json"), r#"{"hooks":{}}"#).unwrap();
        Self {
            temporary,
            canonical,
            account,
        }
    }

    fn prepare(&self) {
        prepare_provider_profile_launch(
            "codex",
            &self.temporary.path().join(".dure"),
            self.temporary.path(),
            &self.account,
            Some("/fixture/managed-codex-notify.sh"),
        )
        .unwrap();
    }

    fn config(&self) -> PathBuf {
        self.account.join("config.toml")
    }

    fn document(&self) -> toml::Table {
        toml::from_str(&std::fs::read_to_string(self.config()).unwrap()).unwrap()
    }

    fn save_decisions(&self) -> toml::Value {
        let prefix = std::fs::canonicalize(&self.account).unwrap();
        let decisions = toml::Value::Table(toml::Table::from_iter([
            (
                format!("{}/hooks.json:session_start:2:0", prefix.display()),
                toml::Value::Table(toml::Table::from_iter([
                    (
                        "trusted_hash".into(),
                        toml::Value::String("sha256:approved".into()),
                    ),
                    ("enabled".into(), toml::Value::Boolean(true)),
                ])),
            ),
            (
                format!("{}/config.toml:stop:0:0", prefix.display()),
                toml::Value::Table(toml::Table::from_iter([
                    (
                        "trusted_hash".into(),
                        toml::Value::String("sha256:disabled".into()),
                    ),
                    ("enabled".into(), toml::Value::Boolean(false)),
                ])),
            ),
            (
                "/fixture/project/.codex/hooks.json:stop:0:0".into(),
                toml::Value::Table(toml::Table::from_iter([(
                    "enabled".into(),
                    toml::Value::Boolean(false),
                )])),
            ),
        ]));
        let mut document = self.document();
        document.insert(
            "hooks".into(),
            toml::Value::Table(toml::Table::from_iter([(
                "state".into(),
                decisions.clone(),
            )])),
        );
        std::fs::write(self.config(), toml::to_string(&document).unwrap()).unwrap();
        decisions
    }
}

#[test]
fn preparation_preserves_account_hook_decisions_without_trusting_new_definitions() {
    let profile = Profile::new();
    profile.prepare();
    let decisions = profile.save_decisions();
    let updated = "model = 'updated'\nnotify = ['/fixture/user-notify']\n\
        [[hooks.Stop]]\nmatcher = '*'\n[[hooks.Stop.hooks]]\n\
        type = 'command'\ncommand = 'echo new-unreviewed-hook'\n";
    std::fs::write(profile.canonical.join("config.toml"), updated).unwrap();
    std::fs::write(
        profile.canonical.join("hooks.json"),
        r#"{"hooks":{"SessionStart":[]}}"#,
    )
    .unwrap();
    profile.prepare();
    let document = profile.document();
    assert_eq!(
        document.get("hooks").and_then(|h| h.get("state")),
        Some(&decisions)
    );
    assert_eq!(document["model"].as_str(), Some("updated"));
    assert!(document["hooks"].get("Stop").is_some());
    assert_eq!(document["notify"].as_array().unwrap().len(), 2);
    assert_eq!(
        std::fs::read_to_string(profile.canonical.join("config.toml")).unwrap(),
        updated
    );
    assert_eq!(
        std::fs::read(profile.account.join("hooks.json")).unwrap(),
        std::fs::read(profile.canonical.join("hooks.json")).unwrap()
    );

    let other = profile.account.with_file_name("codex-other");
    std::fs::create_dir_all(&other).unwrap();
    prepare_provider_profile_launch(
        "codex",
        &profile.temporary.path().join(".dure"),
        profile.temporary.path(),
        &other,
        None,
    )
    .unwrap();
    let other: toml::Table =
        toml::from_str(&std::fs::read_to_string(other.join("config.toml")).unwrap()).unwrap();
    assert!(other["hooks"].get("state").is_none());
}

#[test]
fn repeated_composed_config_preparation_does_not_republish() {
    let profile = Profile::new();
    profile.prepare();
    profile.save_decisions();
    let before = FileGeneration::from(&std::fs::metadata(profile.config()).unwrap());
    let bytes = std::fs::read(profile.config()).unwrap();
    for _ in 0..5 {
        profile.prepare();
        assert_eq!(std::fs::read(profile.config()).unwrap(), bytes);
        assert_eq!(
            FileGeneration::from(&std::fs::metadata(profile.config()).unwrap()),
            before,
            "unchanged composed config must not be overwritten by canonical then notify"
        );
    }
}

#[test]
fn canonical_hook_trust_does_not_replace_an_account_disable() {
    let profile = Profile::new();
    profile.prepare();
    let decisions = profile.save_decisions();
    let canonical = std::fs::canonicalize(profile.canonical.join("config.toml")).unwrap();
    std::fs::write(
        &canonical,
        format!(
            "[hooks.state.\"{}:stop:0:0\"]\nenabled = true\ntrusted_hash = 'sha256:canonical'\n",
            canonical.display(),
        ),
    )
    .unwrap();
    profile.prepare();
    let document = profile.document();
    for (key, decision) in decisions.as_table().unwrap() {
        assert_eq!(document["hooks"]["state"].get(key), Some(decision));
    }
}

#[test]
fn composed_config_rollback_retains_prior_account_decisions() {
    let profile = Profile::new();
    profile.prepare();
    profile.save_decisions();
    let previous = std::fs::read(profile.config()).unwrap();
    std::fs::write(profile.canonical.join("config.toml"), "model = 'changed'\n").unwrap();
    let error = prepare_codex_overlay(
        profile.temporary.path(),
        &profile.account,
        Some(1),
        Some("/fixture/managed-codex-notify.sh"),
    )
    .unwrap_err();
    assert!(error.contains("injected"), "{error}");
    assert_eq!(std::fs::read(profile.config()).unwrap(), previous);
    profile.prepare();
    assert_eq!(profile.document()["model"].as_str(), Some("changed"));
    assert!(std::fs::read_dir(&profile.account).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".hebbian-overlay-")
    }));
}

#[test]
fn concurrent_composed_preparation_keeps_account_decisions_and_file_generation() {
    let profile = Profile::new();
    profile.prepare();
    let decisions = profile.save_decisions();
    let previous = FileGeneration::from(&std::fs::metadata(profile.config()).unwrap());
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| profile.prepare());
        }
    });
    assert_eq!(profile.document()["hooks"]["state"], decisions);
    assert_eq!(
        FileGeneration::from(&std::fs::metadata(profile.config()).unwrap()),
        previous
    );
}

#[test]
fn composed_config_repairs_permissions_and_rejects_symlinks() {
    let profile = Profile::new();
    profile.prepare();
    let decisions = profile.save_decisions();
    for mode in [0o644, 0o4600] {
        std::fs::set_permissions(profile.config(), std::fs::Permissions::from_mode(mode)).unwrap();
        profile.prepare();
        assert_eq!(
            std::fs::metadata(profile.config()).unwrap().mode() & 0o7777,
            0o600
        );
        assert_eq!(profile.document()["hooks"]["state"], decisions);
    }
    let target = profile.account.join("original-config");
    std::fs::rename(profile.config(), &target).unwrap();
    let previous = std::fs::read(&target).unwrap();
    std::os::unix::fs::symlink(&target, profile.config()).unwrap();
    assert!(prepare_codex_overlay(profile.temporary.path(), &profile.account, None, None).is_err());
    assert!(
        std::fs::symlink_metadata(profile.config())
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(std::fs::read(target).unwrap(), previous);
}

#[test]
fn missing_canonical_config_preserves_local_decisions_across_notify_channels() {
    let profile = Profile::new();
    profile.prepare();
    let decisions = profile.save_decisions();
    std::fs::remove_file(profile.canonical.join("config.toml")).unwrap();
    prepare_codex_overlay(
        profile.temporary.path(),
        &profile.account,
        None,
        Some("/other/managed-codex-notify.sh"),
    )
    .unwrap();
    let document = profile.document();
    assert_eq!(document["hooks"]["state"], decisions);
    assert_eq!(
        document["notify"].as_array().unwrap(),
        &[toml::Value::String("/other/managed-codex-notify.sh".into())]
    );
}

#[test]
fn empty_or_unparseable_canonical_config_keeps_the_existing_copy_contract() {
    for bytes in [&b""[..], &b"model = [broken"[..], &b"\xff"[..]] {
        let profile = Profile::new();
        std::fs::write(profile.canonical.join("config.toml"), bytes).unwrap();
        prepare_codex_overlay(profile.temporary.path(), &profile.account, None, None).unwrap();
        assert_eq!(std::fs::read(profile.config()).unwrap(), bytes);
        let previous = FileGeneration::from(&std::fs::metadata(profile.config()).unwrap());
        prepare_codex_overlay(profile.temporary.path(), &profile.account, None, None).unwrap();
        assert_eq!(
            FileGeneration::from(&std::fs::metadata(profile.config()).unwrap()),
            previous
        );
        // A valid canonical replacement still repairs malformed account bytes.
        std::fs::write(
            profile.canonical.join("config.toml"),
            "model = 'repaired'\n",
        )
        .unwrap();
        profile.prepare();
        assert_eq!(profile.document()["model"].as_str(), Some("repaired"));
    }
}
