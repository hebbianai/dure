use super::*;

#[test]
fn exact_live_replacement_recovers_a_mislabeled_build_receipt() {
    mislabeled_replacement_fixture(ActivationFailure::None);
}

#[test]
fn second_recovering_receipt_cleans_up_replacement_fixture() {
    mislabeled_replacement_fixture(ActivationFailure::Before);
}

#[test]
fn lost_activation_receipt_cleans_up_replacement_fixture() {
    mislabeled_replacement_fixture(ActivationFailure::After);
}

#[derive(Clone, Copy)]
enum ActivationFailure {
    None,
    Before,
    After,
}

fn finish_replacement_fixture(
    root: &Path,
    source_descriptor: &Descriptor,
    source: thread::JoinHandle<()>,
    intent_path: &Path,
) {
    let published = read_descriptor(root);
    if intent_path.exists() {
        let intent: Value = serde_json::from_slice(&fs::read(intent_path).unwrap()).unwrap();
        let generation = intent["target"]["generation"].as_str().unwrap();
        let target_path = if generation == published.generation {
            root.join("backend/control-plane.json")
        } else {
            root.join("backend")
                .join(format!("control-plane.{generation}.candidate.json"))
        };
        if target_path.exists() {
            let staged: Descriptor =
                serde_json::from_slice(&fs::read(&target_path).unwrap()).unwrap();
            assert_eq!(staged.generation, generation);
            // An unconfirmed successor rejects normal stop even after it is
            // published. Retire the exact process captured by this fixture.
            let cleanup = Command::new("node")
                .arg(repository_root().join(
                    "crates/dure-app/control-plane/tests/default_checkpoint/retire_staged_fixture.mjs",
                ))
                .arg("retire")
                .arg(root)
                .arg(&target_path)
                .output()
                .unwrap();
            assert!(
                cleanup.status.success(),
                "stdout={} stderr={}",
                String::from_utf8_lossy(&cleanup.stdout),
                String::from_utf8_lossy(&cleanup.stderr),
            );
            wait_owned_service_exit(&staged);
        }
    } else if published.generation != source_descriptor.generation {
        stop_owned_service(root, &published);
    }
    // A second recovering receipt leaves this listener accepting requests.
    // Stop it through its original identity before joining the fixture thread.
    if backend_ping_available(source_descriptor) {
        let response = backend_request(
            root,
            source_descriptor,
            "backend.shutdown",
            &[],
            shutdown_body(source_descriptor),
        );
        assert_eq!(response["result"]["status"], "stopping");
    }
    source.join().unwrap();
    assert_service_locks_stably_released(root);
}

fn mislabeled_replacement_fixture(failure: ActivationFailure) {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-mislabeled-control-plane-build-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let outcome = std::panic::catch_unwind(|| run_replacement_fixture(root, failure));
    if let Err(error) = outcome {
        // Failed cleanup must retain the exact process proof for reconciliation.
        eprintln!(
            "retained replacement fixture: {}",
            temporary.keep().display()
        );
        std::panic::resume_unwind(error);
    }
}

fn run_replacement_fixture(root: &Path, failure: ActivationFailure) {
    let source_generation = "local-v1-11111111111111111111111111111111";
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    fs::create_dir(root.join("hmux-discovery")).unwrap();
    let capabilities = [
        "agent_checkpoint.binding.ensure",
        "agent_checkpoint.read",
        "agent_checkpoint.write",
    ];
    let source = start_backend_fixture(
        root,
        source_generation,
        Some("dure-control-plane/v23-checkpoint-observe"),
        capabilities.to_vec(),
        Some(&hmux),
    );
    let source_descriptor = read_descriptor(root);
    write_local_backend_profile(root, source_generation, &capabilities);

    let cli = installed_cli(root);
    rewrite_cli_build_identity(
        &cli,
        "dure-control-plane/v25-durable-workspace-lease",
        "dure-control-plane/v24-mismatch-fixture",
    );
    let mut mislabeled_identity = serde_json::to_value(control_plane_identity()).unwrap();
    mislabeled_identity["buildId"] =
        Value::String("dure-control-plane/v25-durable-workspace-lease".into());
    let mislabeled_control_plane = root.join("mislabeled-control-plane");
    write_owner_file(
        &mislabeled_control_plane,
        format!(
            "#!/bin/sh\nif [ \"$1\" = identity ]; then printf '%s\\n' '{}'; exit 0; fi\nexec '{}' \"$@\"\n",
            mislabeled_identity,
            env!("CARGO_BIN_EXE_dure-control-plane")
        )
        .as_bytes(),
        true,
    );

    let interrupted = command_with_control_plane(
        root,
        &hmux,
        &mislabeled_control_plane,
        &["profiles", "list", "--json"],
    );
    let interrupted_report: Value = serde_json::from_slice(&interrupted.stdout).unwrap();
    assert_eq!(interrupted.status.code(), Some(2));
    assert_eq!(interrupted_report["error"]["code"], "cli_update_required");
    let intent_path = root
        .join("backend/replacement-intents")
        .join(format!("{source_generation}.json"));
    assert_eq!(read_descriptor(root).generation, source_generation);
    assert!(backend_ping_available(&read_descriptor(root)));
    assert!(!intent_path.exists());

    let repository_identity = repository_build_identity_manifest();
    rewrite_cli_build_identity(
        &cli,
        repository_identity["currentBuildId"].as_str().unwrap(),
        repository_identity["previousBuildId"].as_str().unwrap(),
    );
    let next_hmux = root.join("next-hmux");
    write_owner_file(&next_hmux, b"#!/bin/sh\nexit 1\n", true);
    let activation_attempts = root.join("activation-attempts");
    let rejected_activation = root.join("rejected-activation");
    let node = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node.status.success());
    let node = String::from_utf8(node.stdout).unwrap();
    let activation = match failure {
        ActivationFailure::None => String::new(),
        ActivationFailure::Before => format!(
            "if [ \"$1\" = activate-staged ]; then printf 'attempt\\n' >> '{}'; exit 72; fi\n",
            activation_attempts.display(),
        ),
        ActivationFailure::After => format!(
            "if [ \"$1\" = activate-staged ]; then printf 'attempt\\n' >> '{}'; '{}' \"$@\" || exit $?; exit 72; fi\n",
            activation_attempts.display(),
            env!("CARGO_BIN_EXE_dure-control-plane"),
        ),
    };
    write_owner_file(
        &rejected_activation,
        format!(
            "#!/bin/sh\n{activation}if [ \"$1\" = serve ]; then exec '{}' '{}' launch '{}' '{}' \"$@\"; fi\nexec '{}' \"$@\"\n",
            node.trim(),
            repository_root().join("crates/dure-app/control-plane/tests/default_checkpoint/retire_staged_fixture.mjs").display(),
            root.display(),
            env!("CARGO_BIN_EXE_dure-control-plane"),
            env!("CARGO_BIN_EXE_dure-control-plane"),
        )
        .as_bytes(),
        true,
    );
    let executable = rejected_activation.as_path();
    let recovered = output_with_recovery(
        cli_command(root, &next_hmux, &["profiles", "list", "--json"])
            .env("DURE_CONTROL_PLANE_BIN", executable),
    );
    let profile_catalog: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    let target = read_descriptor(root);
    let failed_activation = !matches!(failure, ActivationFailure::None);
    if failed_activation {
        assert!(is_recovering_output(&recovered));
        assert_eq!(
            fs::read_to_string(activation_attempts)
                .unwrap()
                .lines()
                .count(),
            2
        );
        match failure {
            ActivationFailure::Before => assert_eq!(target.generation, source_generation),
            ActivationFailure::After => assert_ne!(target.generation, source_generation),
            ActivationFailure::None => unreachable!(),
        }
        assert_eq!(
            profile_catalog["profiles"][0]["expected"]["generation"],
            source_generation
        );
        assert!(intent_path.exists());
        assert!(backend_ping_available(&source_descriptor));
        eprintln!("replacement-failure-fixture: {}", root.display());
    }
    finish_replacement_fixture(root, &source_descriptor, source, &intent_path);
    assert!(!backend_ping_available(&source_descriptor));
    if failed_activation {
        return;
    }

    assert!(
        recovered.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&recovered.stdout),
        String::from_utf8_lossy(&recovered.stderr)
    );
    assert_eq!(
        profile_catalog["profiles"][0]["expected"]["generation"],
        target.generation
    );
    assert!(!intent_path.exists());
}
