use super::*;

#[test]
fn skipped_schema_four_builds_upgrade_through_journaled_replacement() {
    assert_schema_four_upgrade("dure-control-plane/v36-typed-dispositions");
}

#[test]
fn previous_schema_four_build_upgrades_to_the_current_manifest_identity() {
    let manifest = repository_build_identity_manifest();
    assert_schema_four_upgrade(manifest["previousBuildId"].as_str().unwrap());
}

fn assert_schema_four_upgrade(source_build: &str) {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-skipped-schema-four-upgrade-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let generation = "local-v1-11111111111111111111111111111111";
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    fs::copy(&hmux, root.join("hmux-runtime")).unwrap();
    fs::create_dir(root.join("hmux-discovery")).unwrap();
    fs::set_permissions(
        root.join("hmux-discovery"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let capabilities = control_plane_identity().capabilities;
    let source = start_schema_four_backend(root, generation, source_build, capabilities.clone());
    write_local_backend_profile_at(
        root,
        generation,
        &capabilities,
        &legacy_generation_socket_path(root, generation),
    );

    let upgraded = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        upgraded.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&upgraded.stdout),
        String::from_utf8_lossy(&upgraded.stderr),
    );
    source.join().unwrap();
    let descriptor = read_descriptor(root);
    assert_ne!(descriptor.generation, generation);
    assert_eq!(
        descriptor.build_id.as_deref(),
        Some(control_plane_identity().build_id)
    );
    stop_owned_service(root, &descriptor);
}
