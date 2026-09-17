use super::*;
use hmux_client::recovery_journal::{RecoveryReservation, prepared_standalone_create};

fn fixture() -> (PathBuf, StandaloneCreateRequest, RecoveryReservation) {
    let root = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
    let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(&guardian) && root != guardian);
    DiscoveryRoot::create(root.join("discovery")).unwrap();
    let request = StandaloneCreateRequest::new(
        &root,
        Some("bound-broker".into()),
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_recovery_identity(
        StandaloneRecoveryCreateIdentity::new("standalone_bound_broker", "private-proof")
            .unwrap()
            .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound),
    )
    .unwrap()
    .with_recovery_operation_id("bound-operation")
    .unwrap();
    let identity = RecoveryIdentity {
        recovery_id: "bound-operation".into(),
        source_session_id: "standalone_bound_broker".into(),
        source_workspace_id: workspace_id_for_path(&root),
        request_fingerprint: request_fingerprint(&["bound-broker"]),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    };
    let RecoveryReservationState::Pending(mut operation) =
        reserve(&root.join("discovery"), identity).unwrap()
    else {
        panic!("fixture must create a pending operation");
    };
    prepared_standalone_create::load_or_prepare(&mut operation, || {
        prepared_standalone_create::PreparedStandaloneCreate::new(request.clone())
    })
    .unwrap();
    (root, request, operation)
}

#[test]
#[ignore = "requires the isolated native runtime and process guardian"]
fn delayed_broker_cannot_launch_after_its_operation_has_refused() {
    let (root, request, mut operation) = fixture();
    let refusal = prepared_standalone_create::refusal::completion(
        "standalone_bound_broker",
        &workspace_id_for_path(&root),
        "hmux_standalone_recipe_conflict",
    );
    prepared_standalone_create::execution::complete(&mut operation, refusal).unwrap();
    drop(operation);
    let result = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(root.join("discovery"))
        .create(request);
    if result.is_ok() {
        await_marker(&fixture_provider_marker(&root));
    }
    let starts = fs::read_to_string(fixture_provider_marker(&root))
        .map_or(0, |marker| marker.lines().count());
    // Capture all assertions before exact fixture cleanup, including the RED path.
    if let Ok(created) = &result {
        terminate(
            &root.join("discovery"),
            created.receipt().session_id(),
            created.receipt().workspace_id(),
        );
    }
    assert_eq!(
        starts, 0,
        "a terminal operation must not start a delayed provider"
    );
    let Err(error) = result else {
        panic!("terminal operation must refuse the broker");
    };
    assert!(
        error
            .to_string()
            .contains("hmux_standalone_operation_not_pending"),
        "{error}"
    );
}

#[test]
#[ignore = "requires the isolated native runtime and process guardian"]
fn a_pending_bound_operation_launches_once_under_its_original_writer() {
    let (root, request, operation) = fixture();
    let creator = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(root.join("discovery"));
    let first = creator.create(request.clone()).unwrap();
    await_marker(&fixture_provider_marker(&root));
    let replay = creator.create(request).unwrap();
    let starts = fs::read_to_string(fixture_provider_marker(&root))
        .unwrap()
        .lines()
        .count();
    let same = first.receipt() == replay.receipt();
    terminate(
        &root.join("discovery"),
        first.receipt().session_id(),
        first.receipt().workspace_id(),
    );
    drop(operation);
    assert_eq!(starts, 1);
    assert!(same);
}

#[test]
#[ignore = "requires the isolated native runtime and process guardian"]
fn acknowledgement_cannot_make_a_delayed_bound_request_fresh_again() {
    let (root, request, mut operation) = fixture();
    let discovery = root.join("discovery");
    let completion = prepared_standalone_create::execution::complete(
        &mut operation,
        prepared_standalone_create::refusal::completion(
            "standalone_bound_broker",
            &workspace_id_for_path(&root),
            "hmux_standalone_recipe_conflict",
        ),
    )
    .unwrap();
    let Some(recovery_journal::existing_operation::RecoveryOperationObservation::Completed {
        identity,
        ..
    }) = recovery_journal::existing_operation::read(
        &discovery,
        "bound-operation",
        STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    )
    .unwrap()
    else {
        panic!("fixture must be completed");
    };
    drop(operation);
    recovery_journal::acknowledge_completion(&discovery, &identity, &completion).unwrap();
    assert!(
        recovery_journal::existing_operation::read(
            &discovery,
            "bound-operation",
            STANDALONE_CREATE_OPERATION_RECOVERY_ACTION
        )
        .unwrap()
        .is_none()
    );
    let result = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(&discovery)
        .create(request);
    if let Ok(created) = &result {
        await_marker(&fixture_provider_marker(&root));
        terminate(
            &discovery,
            created.receipt().session_id(),
            created.receipt().workspace_id(),
        );
    }
    assert!(!fixture_provider_marker(&root).exists());
    assert_eq!(
        result.err().unwrap().code(),
        "hmux_standalone_operation_not_pending"
    );
}

#[test]
#[ignore = "requires the isolated native runtime and process guardian"]
fn a_bound_broker_cannot_substitute_fresh_launch_inputs() {
    let (root, request, operation) = fixture();
    let mut changed = serde_json::to_value(request).unwrap();
    changed["initialRows"] = 99.into();
    let changed = serde_json::from_value(changed).unwrap();
    let result = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(root.join("discovery"))
        .create(changed);
    if let Ok(created) = &result {
        await_marker(&fixture_provider_marker(&root));
        terminate(
            &root.join("discovery"),
            created.receipt().session_id(),
            created.receipt().workspace_id(),
        );
    }
    drop(operation);
    assert!(!fixture_provider_marker(&root).exists());
    assert_eq!(
        result.err().unwrap().code(),
        "hmux_standalone_operation_input_conflict"
    );
}

#[test]
#[ignore = "requires a second real runtime build via DURE_QA_HMUX_REPLACEMENT_RUNTIME"]
fn an_old_broker_refuses_the_bound_schema_without_launching() {
    let (root, request, operation) = fixture();
    let runtime = PathBuf::from(std::env::var_os("DURE_QA_HMUX_REPLACEMENT_RUNTIME").unwrap());
    let result = StandaloneSessionCreator::new(runtime)
        .with_discovery_root(root.join("discovery"))
        .create(request);
    if let Ok(created) = &result {
        await_marker(&fixture_provider_marker(&root));
        terminate(
            &root.join("discovery"),
            created.receipt().session_id(),
            created.receipt().workspace_id(),
        );
    }
    drop(operation);
    assert!(!fixture_provider_marker(&root).exists());
    assert!(
        result
            .err()
            .unwrap()
            .to_string()
            .contains("unsupported schema")
    );
}
