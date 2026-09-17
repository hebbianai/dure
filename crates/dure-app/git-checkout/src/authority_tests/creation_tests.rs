use super::*;

fn assert_reservation_replay(
    request: &GitCheckoutUseRequestV1,
    expected: &GitCheckoutUseReceiptV1,
    instance: &GitCheckoutInstanceV1,
) {
    let (authority, _) =
        Authority::for_instance(Path::new(&request.repository_path), instance).unwrap();
    let before = read_state(&authority).unwrap().unwrap().oid;
    assert_eq!(
        apply_git_checkout_use(request)
            .expect("materialization must not invalidate a stored reservation receipt"),
        *expected
    );
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
}

#[test]
fn creation_reservation_freezes_path_and_materialized_abort_requires_reconciliation() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("reserved");
    let reserve_request = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("reserve-create"),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: target.to_string_lossy().into_owned(),
            owner_id: operation("create-owner"),
        },
    };
    let reserve_receipt = apply_git_checkout_use(&reserve_request).unwrap();
    assert_eq!(
        apply_git_checkout_use(&reserve_request).unwrap(),
        reserve_receipt
    );
    let reservation = match &reserve_receipt.outcome {
        GitCheckoutUseOutcomeV1::CreationReserved { reservation } => reservation.clone(),
        outcome => panic!("expected reservation, got {outcome:?}"),
    };
    let changed = GitCheckoutUseRequestV1 {
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: target.to_string_lossy().into_owned(),
            owner_id: operation("changed-create-owner"),
        },
        ..reserve_request.clone()
    };
    assert_eq!(
        apply_git_checkout_use(&changed).unwrap_err().code,
        "checkout_use_operation_conflict"
    );
    let forged_start = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("forged-start-create"),
        action: GitCheckoutUseActionV1::StartCreation {
            canonical_path: reservation.canonical_path.clone(),
            reservation_token: reservation.path_digest.clone(),
        },
    };
    assert_eq!(
        apply_git_checkout_use(&forged_start).unwrap_err().code,
        "checkout_use_operation_conflict"
    );
    assert!(!target.exists());

    let start_request = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("start-materialized-create"),
        action: GitCheckoutUseActionV1::StartCreation {
            canonical_path: reservation.canonical_path.clone(),
            reservation_token: reservation.reservation_token.clone(),
        },
    };
    let started = apply_git_checkout_use(&start_request).unwrap();
    assert!(matches!(
        started.outcome,
        GitCheckoutUseOutcomeV1::CreationStarted
    ));
    assert_eq!(
        apply_git_checkout_use(&start_request).unwrap_err().code,
        "checkout_use_creation_reconcile_required"
    );
    assert_eq!(
        apply_git_checkout_use(&GitCheckoutUseRequestV1 {
            schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
            repository_path: fixture.repository.to_string_lossy().into_owned(),
            operation_id: operation("competing-start-create"),
            action: GitCheckoutUseActionV1::StartCreation {
                canonical_path: reservation.canonical_path.clone(),
                reservation_token: reservation.reservation_token.clone(),
            },
        })
        .unwrap_err()
        .code,
        "checkout_use_creation_reconcile_required"
    );

    git(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "--detach",
            target.to_str().unwrap(),
            "HEAD",
        ],
    );
    let abort = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("abort-materialized-create"),
        action: GitCheckoutUseActionV1::AbortCreation {
            canonical_path: reservation.canonical_path.clone(),
            reservation_token: reservation.reservation_token.clone(),
        },
    };
    assert_eq!(
        apply_git_checkout_use(&abort).unwrap_err().code,
        "checkout_use_creation_reconcile_required"
    );

    let instance = capture_git_checkout_instance_at(&fixture.repository, &target).unwrap();
    assert_reservation_replay(&reserve_request, &reserve_receipt, &instance);
    assert_eq!(
        apply_git_checkout_use(&changed).unwrap_err().code,
        "checkout_use_operation_conflict"
    );
    let activation_request = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("activate-create"),
        action: GitCheckoutUseActionV1::ActivateCreation {
            instance: instance.clone(),
            reservation_token: reservation.reservation_token.clone(),
        },
    };
    let activated = apply_git_checkout_use(&activation_request).unwrap();
    assert_eq!(activated.phase, GitCheckoutUsePhaseV1::Active);
    assert_eq!(
        apply_git_checkout_use(&activation_request).unwrap(),
        activated
    );
    assert_reservation_replay(&reserve_request, &reserve_receipt, &instance);
    assert_eq!(
        apply_git_checkout_use(&start_request).unwrap_err().code,
        "checkout_use_creation_reconcile_required"
    );
    assert_eq!(
        reservation.canonical_path,
        fs::canonicalize(&target).unwrap().to_string_lossy()
    );

    let moved = fixture._temporary.path().join("moved-created-checkout");
    fs::rename(&target, &moved).unwrap();
    let missing_replay = apply_git_checkout_use(&activation_request);
    fs::rename(&moved, &target).unwrap();

    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("release-created-reservation"),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: reservation.claim.claim_id.clone(),
        },
    })
    .unwrap();
    let released_replay = apply_git_checkout_use(&activation_request);

    let permit_request = permit_request(&fixture, &instance, "permit-created", Vec::new());
    let permit = permit_from(&apply_git_checkout_use(&permit_request).unwrap());
    let permitted_replay = apply_git_checkout_use(&activation_request);
    let physical_request = GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("physical-created"),
        instance: instance.clone(),
        permit_token: permit.permit_token,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    };
    let removed = remove_git_checkout_with_permit(&physical_request).unwrap();
    let removed_replay = apply_git_checkout_use(&activation_request);
    assert_eq!(removed.phase, GitCheckoutUsePhaseV1::Removed);
    assert_eq!(
        remove_git_checkout_with_permit(&physical_request).unwrap(),
        removed
    );
    assert_reservation_replay(&reserve_request, &reserve_receipt, &instance);
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    let terminal = read_state(&authority).unwrap().unwrap().state;
    assert_eq!(terminal.phase(), Phase::Removed);
    let retained_reservation_claim = terminal
        .claims
        .get(reservation.claim.claim_id.as_str())
        .expect("terminal creation lineage must retain its reservation claim");
    assert_eq!(
        retained_reservation_claim.release().is_some(),
        compaction_expectation("abort_removal")["retainsReleasedReservationClaim"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(terminal.claims.len(), 1);

    // A stored activation is not a second source of live claim authority.
    // Collect every observation before asserting so the same regression proves
    // exact-path, released-claim, removal-permit and terminal replay behavior.
    assert_eq!(
        [
            missing_replay,
            released_replay,
            permitted_replay,
            removed_replay
        ]
        .map(|result| result.err().map(|error| error.code)),
        [
            Some("checkout_use_instance_conflict"),
            Some("checkout_use_phase_conflict"),
            Some("checkout_use_phase_conflict"),
            Some("checkout_use_phase_conflict"),
        ]
    );
}

#[test]
fn absent_creation_abort_is_exact_and_terminal() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("never-created");
    let reserved = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("reserve-never-created"),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: target.to_string_lossy().into_owned(),
            owner_id: operation("never-created-owner"),
        },
    })
    .unwrap();
    let reservation = match reserved.outcome {
        GitCheckoutUseOutcomeV1::CreationReserved { reservation } => reservation,
        _ => unreachable!(),
    };
    let abort_request = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("abort-never-created"),
        action: GitCheckoutUseActionV1::AbortCreation {
            canonical_path: reservation.canonical_path,
            reservation_token: reservation.reservation_token,
        },
    };
    let aborted = apply_git_checkout_use(&abort_request).unwrap();
    assert_eq!(aborted.phase, GitCheckoutUsePhaseV1::Removed);
    assert_eq!(apply_git_checkout_use(&abort_request).unwrap(), aborted);
    assert!(!target.exists());
}

#[test]
fn fresh_reservation_does_not_claim_a_materialized_checkout() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    assert!(read_state(&authority).unwrap().is_none());
    let result = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("fresh-reservation-of-existing-checkout"),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: fixture.linked.to_string_lossy().into_owned(),
            owner_id: operation("competing-create-owner"),
        },
    });
    assert!(result.is_err());
    assert!(read_state(&authority).unwrap().is_none());
    assert_eq!(capture(&fixture), instance);
    assert_eq!(
        fs::read_to_string(fixture.linked.join("tracked.txt")).unwrap(),
        "base\n"
    );
}

/// A preserved checkout that was later removed out of band leaves an active
/// generation with every claim released. Creation must retire that generation
/// as already absent instead of pointing the caller at a checkout nobody owns.
#[test]
fn quiescent_active_generation_of_an_absent_checkout_is_retired_and_recreatable() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let claim = claim_from(
        &apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "preserved-claim",
            "preserved-owner",
        ))
        .unwrap(),
    );
    let (authority, original_digest) =
        Authority::for_instance(&fixture.repository, &instance).unwrap();
    let recreate = operation("recreate-owner");

    // An active claim keeps the record authoritative even if the path is gone.
    git(
        &fixture.repository,
        &[
            "worktree",
            "remove",
            "--force",
            fixture.linked.to_str().unwrap(),
        ],
    );
    assert!(!fixture.linked.exists());
    assert!(
        prepare_git_checkout_creation(&fixture.repository, &fixture.linked, &recreate, &["HEAD"])
            .unwrap()
            .is_none()
    );
    assert_eq!(
        read_state(&authority).unwrap().unwrap().state.phase(),
        Phase::Active
    );

    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("preserved-release"),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: claim.claim_id,
        },
    })
    .unwrap();

    let creation =
        prepare_git_checkout_creation(&fixture.repository, &fixture.linked, &recreate, &["HEAD"])
            .unwrap()
            .expect("absent quiescent generation admits a new creation");
    let retired = read_state(&authority).unwrap().unwrap().state;
    assert_eq!(retired.phase(), Phase::Removed);
    assert_eq!(retired.instance_digest(), Some(original_digest.as_str()));
    assert_eq!(
        retired.terminal().map(|terminal| terminal.kind),
        Some(TerminalKind::AlreadyAbsent)
    );
    // Retirement is idempotent under the same creator and never re-executes.
    creation.abort().unwrap();
    let again =
        prepare_git_checkout_creation(&fixture.repository, &fixture.linked, &recreate, &["HEAD"])
            .unwrap()
            .expect("a retired generation stays creatable");
    assert_eq!(
        read_state(&authority).unwrap().unwrap().state.revision,
        retired.revision
    );
    drop(again);
}

/// A present checkout is never retired by a competing creator, even when quiescent.
#[test]
fn quiescent_active_generation_of_a_present_checkout_is_not_retired() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let claim = claim_from(
        &apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "present-claim",
            "present-owner",
        ))
        .unwrap(),
    );
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("present-release"),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: claim.claim_id,
        },
    })
    .unwrap();
    assert!(
        prepare_git_checkout_creation(
            &fixture.repository,
            &fixture.linked,
            &operation("present-recreate"),
            &["HEAD"],
        )
        .unwrap()
        .is_none()
    );
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    assert_eq!(
        read_state(&authority).unwrap().unwrap().state.phase(),
        Phase::Active
    );
}
