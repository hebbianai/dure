use super::super::tests::{managed_request, retired_checkpoint};
use super::*;
use launch::PreparedLaunch;

fn fixture() -> (
    tempfile::TempDir,
    LocalSessionCatalog,
    SessionConversionRequest,
) {
    let root = tempfile::tempdir().unwrap();
    let catalog = LocalSessionCatalog::new(root.path());
    let mut request = managed_request(Some("conversation-1"));
    request.cwd = root
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    request.credential_id = Some("fixture-selected-account".into());
    request.credential_directory = Some("/fixture/provider-state".into());
    request.credential_generation = Some(7);
    request.terminal_environment =
        TerminalEnvironment::new([("TERM".into(), Some("xterm-256color".into()))].into()).unwrap();
    request.expected_source_fence = Some(ManagedStopFence {
        runner_principal: "fixture-principal".into(),
        runner_instance: "fixture-runner".into(),
        channel_epoch: "1".into(),
        host_instance_id: "fixture-host".into(),
        terminal_epoch: "fixture-terminal".into(),
    });
    (root, catalog, request)
}

fn prepare_fixture(
    request: &SessionConversionRequest,
    checkpoint: Option<&recovery::RecoveryResumeCheckpoint>,
) -> Result<PreparedConversion, String> {
    let initial_checkpoint = checkpoint.cloned().unwrap_or_else(|| {
        let mut checkpoint = retired_checkpoint();
        checkpoint.provider_cwd = request.cwd.clone();
        checkpoint.source_terminated = false;
        checkpoint
    });
    let argv = vec![
        "/fixture/pinned-shell".into(),
        "-lc".into(),
        "exec /fixture/versions/v1/dure provider-resume conversation-1".into(),
    ];
    let launch = match request.target {
        SessionConversionTarget::Managed => PreparedLaunch::Managed(Box::new(
            ManagedCreateRequest::new(
                "prepared-create",
                "prepared-target",
                &request.source_workspace_id,
                &request.provider_id,
                request.permission_mode,
                &request.cwd,
                argv,
                request.rows,
                request.columns,
            )
            .unwrap()
            .with_terminal_environment(request.terminal_environment.clone())
            .unwrap()
            .with_terminal_default_colors_option(request.terminal_default_colors)
            .unwrap()
            .with_provider_state_environment(
                hmux_client::ProviderStateEnvironment::new(
                    [("CODEX_HOME".into(), "/fixture/provider-state".into())].into(),
                )
                .unwrap(),
            )
            .unwrap(),
        )),
        SessionConversionTarget::Standalone => {
            PreparedLaunch::Standalone(Box::new(launch::standalone_request(
                request,
                argv,
                initial_checkpoint.attempt,
                "fixture-proof".into(),
            )?))
        }
    };
    Ok(PreparedConversion {
        request: request.clone(),
        initial_checkpoint,
        current: runtime::InstalledBuild {
            build_id: "fixture-pinned-build".into(),
            runtime: "/fixture/versions/pinned-build/bin/hmux-runtime".into(),
        },
        launch,
        source_checkout: Some(dure_app::SessionCheckoutBindingV1::new(
            dure_app::SessionCheckoutIdentityV1 {
                runtime_namespace: "/fixture/discovery".into(),
                owner: dure_app::SessionCheckoutOwnerV1::Managed {
                    workspace_id: request.source_workspace_id.clone(),
                    session_id: request.source_session_id.clone(),
                    idempotency_key: "original-root-create".into(),
                },
            },
            request.cwd.clone(),
            None,
        )),
    })
}

fn no_preparation(
    _: &SessionConversionRequest,
    _: Option<&recovery::RecoveryResumeCheckpoint>,
) -> Result<PreparedConversion, String> {
    panic!("a replay must not resolve the CLI, shell, provider environment or runtime")
}

#[test]
fn original_namespace_replays_without_initializing_the_new_primary() {
    let (root, original, request) = fixture();
    drop(reserve(&original, request.clone(), prepare_fixture).unwrap());
    let primary = root.path().join("new-primary");
    let caller = LocalSessionCatalog::with_read_only_discovery_roots(
        &primary, vec![original.discovery_root().to_path_buf()],
    ).unwrap();
    let selected = execution_catalog(&caller, &request).unwrap();
    assert_eq!(selected.discovery_root(), original.discovery_root());
    assert!(selected.discovery_paths().any(|path| path == primary));
    let mut hint = request;
    hint.cwd = "/not-a-preparation-input".into();
    let ReservedConversion::Pending(pending) = reserve(&selected, hint, no_preparation).unwrap()
    else {
        panic!("the original pending operation must remain pending");
    };
    assert!(pending.1.was_existing());
    assert!(!primary.exists());
}

#[test]
fn local_operation_identity_is_not_shadowed_by_compatibility_history() {
    let (_first, primary, request) = fixture();
    let (_second, legacy, mut other) = fixture();
    other.source_session_id = "unrelated-source".into();
    drop(reserve(&primary, request.clone(), prepare_fixture).unwrap());
    drop(reserve(&legacy, other, prepare_fixture).unwrap());
    let caller = LocalSessionCatalog::with_read_only_discovery_roots(
        primary.discovery_root(), vec![legacy.discovery_root().to_path_buf()],
    ).unwrap();
    let selected = execution_catalog(&caller, &request).unwrap();
    assert_eq!(selected.discovery_root(), primary.discovery_root());
    let ReservedConversion::Pending(pending) = reserve(&selected, request.clone(), no_preparation).unwrap()
    else {
        panic!("the primary operation must remain pending");
    };
    assert_eq!(pending.0.request.source_session_id, request.source_session_id);
}

#[test]
fn changed_target_cannot_create_a_second_operation_in_a_new_namespace() {
    let (root, original, mut request) = fixture();
    drop(reserve(&original, request.clone(), prepare_fixture).unwrap());
    let primary = root.path().join("new-primary");
    let caller = LocalSessionCatalog::with_read_only_discovery_roots(
        &primary, vec![original.discovery_root().to_path_buf()],
    ).unwrap();
    request.target = SessionConversionTarget::Standalone;
    assert!(execution_catalog(&caller, &request).is_err());
    assert!(!primary.exists());
}

#[test]
fn legacy_operation_keeps_its_original_namespace() {
    let (root, original, request) = fixture();
    drop(reserve_legacy(&original, &request));
    let primary = root.path().join("new-primary");
    let caller = LocalSessionCatalog::with_read_only_discovery_roots(
        &primary, vec![original.discovery_root().to_path_buf()],
    ).unwrap();
    let selected = execution_catalog(&caller, &request).unwrap();
    assert_eq!(selected.discovery_root(), original.discovery_root());
    drop(reserve(&selected, request, prepare_fixture).unwrap());
    assert!(!primary.exists());
}

fn completion(request: &SessionConversionRequest) -> recovery::RecoveryCompletion {
    let mut checkpoint = retired_checkpoint();
    checkpoint.provider_cwd = request.cwd.clone();
    recovery::RecoveryCompletion {
        target_session_id: "converted-target".into(),
        target_workspace_id: "workspace_1".into(),
        target_build_id: "fixture-build".into(),
        action: request.target.action().into(),
        outcome: "converted".into(),
        resume_checkpoint: Some(checkpoint),
        operation_checkpoint: None,
    }
}

#[test]
fn recovery_checkout_uses_the_journal_namespace_and_keeps_the_claim() {
    let (_root, catalog, request) = fixture();
    let prepared = prepare_fixture(&request, None).unwrap();
    let source = prepared.source_checkout.as_ref().unwrap();
    let retained = prepared.recovery_checkout(&catalog).unwrap().unwrap();
    let namespace = catalog.discovery_root().canonicalize().unwrap();
    assert_ne!(source.identity.runtime_namespace, namespace.to_str().unwrap());
    assert_eq!(retained.claim_id, source.claim_id);
    assert_eq!(retained.working_directory, source.working_directory);
    assert_eq!(retained.registration, source.registration);
    assert_eq!(
        retained.identity.owner,
        dure_app::SessionCheckoutOwnerV1::Recovery {
            recovery_id: request.conversion_id,
        },
    );
    assert_eq!(
        retained.identity.runtime_namespace,
        namespace.to_str().unwrap(),
    );
}

#[test]
fn pending_and_completed_replays_retain_inputs_when_client_hints_disappear() {
    for target in [
        SessionConversionTarget::Managed,
        SessionConversionTarget::Standalone,
    ] {
        let (_root, catalog, mut request) = fixture();
        request.target = target;
        request.terminal_default_colors =
            Some(hmux_client::TerminalDefaultColors::new(0x171717, 0xffffff).unwrap());
        let ReservedConversion::Pending(pending) =
            reserve(&catalog, request.clone(), prepare_fixture).unwrap()
        else {
            panic!("fresh conversion must be pending");
        };
        let (prepared, mut reservation) = *pending;
        let original = serde_json::to_value(&prepared).unwrap();
        reservation
            .checkpoint_resume(completion(&request).resume_checkpoint.unwrap())
            .unwrap();
        drop(reservation);
        let mut hint = request.clone();
        hint.expected_conversation_id = None;
        hint.expected_source_fence = None;
        hint.credential_id = None;
        hint.credential_directory = None;
        hint.credential_generation = None;
        hint.rows = 60;
        hint.columns = 120;
        hint.cwd = "/another/client-cwd".into();
        hint.terminal_environment = Default::default();
        hint.terminal_default_colors = None;
        let ReservedConversion::Pending(pending) =
            reserve(&catalog, hint.clone(), no_preparation).unwrap()
        else {
            panic!("reopened interrupted conversion remains pending");
        };
        let (prepared, mut reservation) = *pending;
        assert_eq!(serde_json::to_value(&prepared).unwrap(), original);
        assert!(reservation.was_existing());
        reservation.complete(completion(&request)).unwrap();
        drop(reservation);
        hint.terminal_default_colors =
            Some(hmux_client::TerminalDefaultColors::new(0xe5e5e5, 0x242424).unwrap());
        let ReservedConversion::Completed(completed) =
            reserve(&catalog, hint, no_preparation).unwrap()
        else {
            panic!("replay must retain completion");
        };
        let (prepared_request, completed, target) = *completed;
        assert!(target.is_none());
        assert_eq!(
            serde_json::to_value(prepared_request).unwrap(),
            serde_json::to_value(request).unwrap()
        );
        assert_eq!(
            serde_json::to_value(
                read_prepared(completed.operation_checkpoint.as_ref().unwrap()).unwrap()
            )
            .unwrap(),
            original,
        );
    }
}

#[test]
fn explicit_identity_hints_cannot_retarget_a_prepared_conversion() {
    let (_root, catalog, request) = fixture();
    drop(reserve(&catalog, request.clone(), prepare_fixture).unwrap());
    for field in ["source", "provider", "conversation", "target", "fence"] {
        let mut hint = request.clone();
        match field {
            "source" => hint.source_session_id = "another-source".into(),
            "provider" => hint.provider_id = "claude".into(),
            "conversation" => hint.expected_conversation_id = Some("another-conversation".into()),
            "target" => hint.target = SessionConversionTarget::Standalone,
            "fence" => {
                hint.expected_source_fence.as_mut().unwrap().terminal_epoch =
                    "another-terminal".into()
            }
            _ => unreachable!(),
        }
        assert!(reserve(&catalog, hint, no_preparation).is_err(), "{field}");
    }
    assert!(matches!(
        reserve(&catalog, request, no_preparation).unwrap(),
        ReservedConversion::Pending(_),
    ));
}

fn reserve_legacy(
    catalog: &LocalSessionCatalog,
    request: &SessionConversionRequest,
) -> recovery::RecoveryReservation {
    let identity = recovery::RecoveryIdentity {
        recovery_id: request.conversion_id.clone(),
        source_session_id: request.source_session_id.clone(),
        source_workspace_id: request.source_workspace_id.clone(),
        action: request.target.action(),
        request_fingerprint: recovery::request_fingerprint(&[
            &serde_json::to_string(request).unwrap()
        ]),
    };
    let recovery::RecoveryReservationState::Pending(reservation) =
        recovery::reserve(catalog.discovery_root(), identity).unwrap()
    else {
        panic!("fresh legacy fixture must be pending");
    };
    reservation
}

#[test]
fn legacy_pending_upgrade_requires_its_original_request_before_accepting_hintless_retry() {
    let (_root, catalog, request) = fixture();
    let checkpoint = completion(&request).resume_checkpoint.unwrap();
    let mut reservation = reserve_legacy(&catalog, &request);
    reservation.checkpoint_resume(checkpoint.clone()).unwrap();
    drop(reservation);
    let mut hint = request.clone();
    hint.expected_conversation_id = None;
    assert!(reserve(&catalog, hint.clone(), no_preparation)
        .unwrap_err()
        .starts_with("hmux_recovery_idempotency_conflict:"));
    drop(
        reserve(&catalog, request, |request, prior| {
            assert_eq!(prior, Some(&checkpoint));
            prepare_fixture(request, prior)
        })
        .unwrap(),
    );
    let ReservedConversion::Pending(pending) = reserve(&catalog, hint, no_preparation).unwrap()
    else {
        panic!("upgraded pending conversion remains pending");
    };
    let (prepared, reservation) = *pending;
    assert_eq!(
        prepared.request.expected_conversation_id.as_deref(),
        Some("conversation-1")
    );
    assert_eq!(prepared.initial_checkpoint, checkpoint);
    assert!(reservation.operation_checkpoint().is_some());
}

#[test]
fn legacy_completion_never_prepares_or_rewrites_the_launch() {
    let (_root, catalog, request) = fixture();
    let mut reservation = reserve_legacy(&catalog, &request);
    reservation.complete(completion(&request)).unwrap();
    drop(reservation);
    let ReservedConversion::Completed(completed) =
        reserve(&catalog, request, no_preparation).unwrap()
    else {
        panic!("legacy completion must remain terminal");
    };
    assert!(completed.1.operation_checkpoint.is_none());
}

#[test]
fn prepared_identity_covers_loss_before_the_first_progress_checkpoint() {
    let (_root, catalog, mut request) = fixture();
    request.expected_conversation_id = None;
    drop(reserve(&catalog, request.clone(), prepare_fixture).unwrap());
    let mut wrong = request.clone();
    wrong.expected_conversation_id = Some("another-conversation".into());
    assert!(reserve(&catalog, wrong, no_preparation)
        .unwrap_err()
        .starts_with("session_conversion_conversation_changed:"));
    let ReservedConversion::Pending(pending) = reserve(&catalog, request, no_preparation).unwrap()
    else {
        panic!("interrupted preparation must remain pending");
    };
    let (prepared, reservation) = *pending;
    assert!(reservation.resume_checkpoint().is_none());
    assert_eq!(
        prepared.initial_checkpoint.resume_identity,
        "conversation-1"
    );
}

#[test]
fn managed_replacement_attempts_change_only_identity_in_frozen_launch_inputs() {
    let (_root, _catalog, request) = fixture();
    let prepared = prepare_fixture(&request, None).unwrap();
    let PreparedLaunch::Managed(create) = prepared.launch else {
        unreachable!();
    };
    let mut before = serde_json::to_value(&create).unwrap();
    let advanced = create
        .retarget_identity("next-create", "next-target")
        .unwrap();
    before["idempotencyKey"] = "next-create".into();
    before["sessionId"] = "next-target".into();
    assert_eq!(serde_json::to_value(advanced).unwrap(), before);
}

#[test]
fn standalone_replay_retains_the_complete_request_and_private_creation_identity() {
    let (_root, catalog, mut request) = fixture();
    request.target = SessionConversionTarget::Standalone;
    request.terminal_default_colors =
        Some(hmux_client::TerminalDefaultColors::new(0x171717, 0xffffff).unwrap());
    let ReservedConversion::Pending(pending) =
        reserve(&catalog, request.clone(), prepare_fixture).unwrap()
    else {
        unreachable!();
    };
    let (prepared, reservation) = *pending;
    let PreparedLaunch::Standalone(first) = prepared.launch else {
        unreachable!();
    };
    drop(reservation);
    request.rows = 60;
    request.columns = 120;
    request.terminal_environment = Default::default();
    request.terminal_default_colors =
        Some(hmux_client::TerminalDefaultColors::new(0xe5e5e5, 0x242424).unwrap());
    let ReservedConversion::Pending(pending) = reserve(&catalog, request, no_preparation).unwrap()
    else {
        unreachable!();
    };
    let (prepared, _) = *pending;
    let PreparedLaunch::Standalone(replayed) = prepared.launch else {
        unreachable!();
    };
    assert_eq!(replayed, first);
    let identity = replayed.recovery_identity().unwrap();
    assert_eq!(
        identity.recipe_requirement(),
        hmux_client::StandaloneRecipeRequirement::RequestBound
    );
    assert!(!format!("{replayed:?}").contains(identity.launch_owner_proof()));
}
