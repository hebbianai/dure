use super::*;

#[test]
fn detached_control_plane_owns_schedule_crud_and_recovery() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-standalone-schedules-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = write_session_query_fixture(root);

    let bootstrap = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        bootstrap.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&bootstrap.stdout),
        String::from_utf8_lossy(&bootstrap.stderr)
    );
    let project = project_catalog_fixture_repository(root);
    let register = register_project_cli(root, &hmux, "dure", "Dure", project.to_str());
    assert!(register.status.success());

    let created = command(
        root,
        &hmux,
        &[
            "schedule",
            "create",
            "--id",
            "morning-triage",
            "--name",
            "Morning triage",
            "--project",
            "dure",
            "--provider",
            "codex",
            "--cron",
            "0 9 * * 1-5",
            "--timezone",
            "Asia/Seoul",
            "--disabled",
            "--idempotency-key",
            "schedule-put-fixture",
            "--backend",
            "local",
            "--json",
            "--",
            "triage ready work",
        ],
    );
    assert!(
        created.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&created.stdout),
        String::from_utf8_lossy(&created.stderr)
    );
    let created: Value = serde_json::from_slice(&created.stdout).unwrap();
    assert_eq!(created["kind"], "dure.schedules.put");
    assert_eq!(created["schedule"]["revision"], 1);
    assert_eq!(created["schedule"]["enabled"], false);

    let listed = command(
        root,
        &hmux,
        &["schedule", "list", "--backend", "local", "--json"],
    );
    assert!(listed.status.success());
    let listed: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(listed["schedules"].as_array().unwrap().len(), 1);

    let manual = command(
        root,
        &hmux,
        &[
            "schedule",
            "run-once",
            "morning-triage",
            "--expected-revision",
            "1",
            "--idempotency-key",
            "detached-manual-1",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert!(
        manual.status.success(),
        "{}",
        String::from_utf8_lossy(&manual.stdout)
    );
    let manual: Value = serde_json::from_slice(&manual.stdout).unwrap();
    assert_eq!(manual["occurrence"]["trigger"]["kind"], "manual");
    assert_eq!(manual["occurrence"]["launchState"], "pending");

    let descriptor = read_descriptor(root);
    assert!(
        control_plane_identity()
            .capabilities
            .contains(&"schedule.occurrences")
    );
    stop_owned_service(root, &descriptor);

    let mut restarted = start_owned_service(root, &hmux, &descriptor.generation);
    let recovered = command(
        root,
        &hmux,
        &[
            "schedule",
            "show",
            "morning-triage",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert!(recovered.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&recovered.stdout).unwrap()["schedule"],
        created["schedule"]
    );

    let deleted = command(
        root,
        &hmux,
        &[
            "schedule",
            "delete",
            "morning-triage",
            "--expected-revision",
            "1",
            "--idempotency-key",
            "schedule-delete-fixture",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert!(deleted.status.success());
    let deleted: Value = serde_json::from_slice(&deleted.stdout).unwrap();
    assert_eq!(deleted["schedule"]["revision"], 2);
    assert!(deleted["schedule"]["deletedAtMs"].is_number());

    let runs = command(
        root,
        &hmux,
        &[
            "schedule",
            "runs",
            "morning-triage",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert!(runs.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&runs.stdout).unwrap()["occurrences"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let inspected = command(
        root,
        &hmux,
        &[
            "schedule",
            "inspect",
            "detached-manual-1",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert!(
        inspected.status.success(),
        "{}",
        String::from_utf8_lossy(&inspected.stdout)
    );
    let inspected: Value = serde_json::from_slice(&inspected.stdout).unwrap();
    assert_eq!(
        inspected["occurrence"]["idempotencyKey"],
        "detached-manual-1"
    );
    assert_eq!(inspected["resultMarkdown"], Value::Null);
    assert_ne!(inspected["occurrence"]["launchState"], "succeeded");

    let restarted_descriptor = read_descriptor(root);
    stop_owned_child(root, &restarted_descriptor, &mut restarted);
    assert!(!root.join("automations.json").exists());
    assert!(!root.join("automation-runs.json").exists());
}
