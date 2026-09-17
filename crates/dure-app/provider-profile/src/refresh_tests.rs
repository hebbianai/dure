use super::*;
use std::time::Instant;

#[test]
fn repeated_profile_preparation_preserves_unchanged_spawn_files() {
    for provider in ["codex", "claude"] {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path();
        let policy = reviewed_overlay_policy(provider).unwrap();
        let canonical = home.join(policy.canonical_directory_name);
        let account = home.join(format!(".dure/accounts/{provider}-refresh"));
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        for name in policy.spawn_sync_files {
            let content = if *name == "config.toml" {
                "model = 'fixture'\n".to_string()
            } else {
                // Synthetic shared state only; no real account or credential data.
                let size = if *name == "models_cache.json" {
                    512 * 1024
                } else {
                    4096
                };
                format!("{{\"fixture\":\"{}\"}}\n", "x".repeat(size))
            };
            std::fs::write(canonical.join(name), content).unwrap();
        }
        let prepare = || {
            prepare_managed_provider_profile(
                provider,
                home.to_str().unwrap(),
                Some("refresh"),
                Some(account.to_str().unwrap()),
            )
            .unwrap()
        };
        let initial_environment = prepare();
        let mut replacements = 0;
        let mut timings = Vec::new();
        for _ in 0..5 {
            let before: Vec<_> = policy
                .spawn_sync_files
                .iter()
                .map(|name| FileGeneration::from(&std::fs::metadata(account.join(name)).unwrap()))
                .collect();
            let started = Instant::now();
            assert_eq!(prepare(), initial_environment);
            timings.push(started.elapsed().as_secs_f64() * 1000.0);
            for (name, previous) in policy.spawn_sync_files.iter().zip(before) {
                let current = FileGeneration::from(&std::fs::metadata(account.join(name)).unwrap());
                replacements += usize::from(current != previous);
                assert_eq!(
                    std::fs::read(account.join(name)).unwrap(),
                    std::fs::read(canonical.join(name)).unwrap(),
                );
            }
        }
        eprintln!(
            "{provider} repeated profile preparation: {timings:?} ms; spawn-file changes={replacements}"
        );
        assert_eq!(
            replacements, 0,
            "unchanged {provider} spawn state must not be republished"
        );
    }
}

#[test]
fn changed_spawn_state_is_published_even_with_the_same_size_and_modification_time() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let destination = temporary.path().join("destination");
    std::fs::write(&source, b"old state").unwrap();
    let modified = std::fs::metadata(&source).unwrap().modified().unwrap();
    sync_file(&source, &destination).unwrap();
    std::fs::write(&source, b"new state").unwrap();
    File::options()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();

    assert!(sync_file(&source, &destination).unwrap());
    assert_eq!(std::fs::read(&destination).unwrap(), b"new state");
}

#[test]
fn identical_spawn_state_still_repairs_permissions_and_private_file_identity() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let destination = temporary.path().join("destination");
    let linked = temporary.path().join("linked");
    std::fs::write(&source, b"same state").unwrap();
    sync_file(&source, &destination).unwrap();
    std::fs::hard_link(&destination, &linked).unwrap();
    assert!(sync_file(&source, &destination).unwrap());
    assert_ne!(
        std::fs::metadata(&destination).unwrap().ino(),
        std::fs::metadata(&linked).unwrap().ino()
    );
    for mode in [0o644, 0o4600] {
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(sync_file(&source, &destination).unwrap());
        assert_eq!(
            std::fs::metadata(&destination).unwrap().mode() & 0o7777,
            0o600
        );
    }
    assert_eq!(std::fs::read(&destination).unwrap(), b"same state");
}

#[test]
fn identical_spawn_state_does_not_accept_a_symlink_at_either_boundary() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let destination = temporary.path().join("destination");
    let target = temporary.path().join("target");
    std::fs::write(&source, b"same state").unwrap();
    std::fs::write(&target, b"same state").unwrap();
    std::os::unix::fs::symlink(&target, &destination).unwrap();
    assert!(
        sync_file(&source, &destination)
            .unwrap_err()
            .starts_with("credential_overlay_wrong_type:")
    );
    assert!(
        std::fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(sync_file(&destination, &source).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"same state");
}

#[test]
fn backend_launch_preparation_reuses_the_verified_profile_and_spawn_state() {
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path();
    let canonical = home.join(".codex");
    let account = home.join(".dure/accounts/codex-refresh");
    std::fs::create_dir_all(&canonical).unwrap();
    std::fs::create_dir_all(&account).unwrap();
    std::fs::write(canonical.join("config.toml"), "model = 'fixture'\n").unwrap();
    let environment = prepare_managed_provider_profile(
        "codex",
        home.to_str().unwrap(),
        Some("refresh"),
        Some(account.to_str().unwrap()),
    )
    .unwrap();
    let file = account.join("config.toml");
    let generation = FileGeneration::from(&std::fs::metadata(&file).unwrap());
    let profile = std::fs::metadata(&account).unwrap();
    let prepared =
        prepare_provider_profile_launch("codex", &home.join(".dure"), home, &account, None)
            .unwrap();
    assert_eq!(
        prepared.directory(),
        std::fs::canonicalize(&account).unwrap()
    );
    assert_eq!(
        (prepared.directory_device(), prepared.directory_inode()),
        (profile.dev(), profile.ino())
    );
    assert_eq!(prepared.into_environment(), environment);
    assert_eq!(
        FileGeneration::from(&std::fs::metadata(file).unwrap()),
        generation
    );
}

#[test]
fn unchanged_spawn_comparison_rejects_a_replaced_source_generation() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let destination = temporary.path().join("destination");
    let replacement = temporary.path().join("replacement");
    std::fs::write(&source, b"same state").unwrap();
    sync_file(&source, &destination).unwrap();
    let mut previous_source = File::open(&source).unwrap();
    std::fs::write(&replacement, b"same state").unwrap();
    std::fs::rename(replacement, &source).unwrap();
    assert!(!unchanged_spawn_file(&source, &mut previous_source, &destination).unwrap());
}

fn sync_file(source: &Path, destination: &Path) -> Result<bool, String> {
    let mut transaction = OverlayTransaction::default();
    let changed = atomic_sync_regular_file(
        source,
        destination,
        &mut transaction,
        &mut FaultInjection {
            fail_after: None,
            mutations: 0,
        },
    )?;
    transaction.commit()?;
    Ok(changed)
}
