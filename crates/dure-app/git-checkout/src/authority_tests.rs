use super::*;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(unix)]
#[path = "authority_tests/creation_commit_tests.rs"]
mod creation_commit_tests;
#[path = "authority_tests/creation_tests.rs"]
mod creation_tests;
#[cfg(unix)]
#[path = "authority_tests/execution_tests.rs"]
mod execution_tests;
#[path = "authority_tests/registration_tests.rs"]
mod registration_tests;

struct Fixture {
    _temporary: tempfile::TempDir,
    repository: PathBuf,
    linked: PathBuf,
}

fn git_result(repository: &Path, args: &[&str]) -> std::process::Output {
    let mut command = Command::new("git");
    command.arg("-C").arg(repository).args(args);
    super::super::scrub_git_environment(&mut command);
    command.output().unwrap()
}

fn git(repository: &Path, args: &[&str]) -> String {
    let output = git_result(repository, args);
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end_matches(['\r', '\n'])
        .to_string()
}

fn fixture_with_init_args(init_args: &[&str]) -> Option<Fixture> {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let repository = root.join("repository");
    fs::create_dir(&repository).unwrap();
    let output = git_result(&repository, init_args);
    if !output.status.success() {
        return None;
    }
    git(&repository, &["config", "user.name", "Checkout Use Test"]);
    git(
        &repository,
        &["config", "user.email", "checkout-use@example.invalid"],
    );
    git(&repository, &["config", "commit.gpgsign", "false"]);
    fs::write(repository.join("tracked.txt"), "base\n").unwrap();
    git(&repository, &["add", "tracked.txt"]);
    git(&repository, &["commit", "-m", "base"]);
    let linked = root.join("linked");
    git(
        &repository,
        &[
            "worktree",
            "add",
            "--detach",
            linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    Some(Fixture {
        _temporary: temporary,
        repository,
        linked,
    })
}

fn fixture() -> Fixture {
    fixture_with_init_args(&["init", "-b", "main"]).unwrap()
}

fn capture(fixture: &Fixture) -> GitCheckoutInstanceV1 {
    capture_git_checkout_instance_at(&fixture.repository, &fixture.linked).unwrap()
}

fn operation(value: &str) -> OperationIdV1 {
    OperationIdV1::new(value).unwrap()
}

fn claim_request(
    fixture: &Fixture,
    instance: &GitCheckoutInstanceV1,
    operation_id: &str,
    owner_id: &str,
) -> GitCheckoutUseRequestV1 {
    GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation(operation_id),
        action: GitCheckoutUseActionV1::Claim {
            instance: instance.clone(),
            owner_id: operation(owner_id),
        },
    }
}

fn claim_from(receipt: &GitCheckoutUseReceiptV1) -> GitCheckoutUseClaimV1 {
    match &receipt.outcome {
        GitCheckoutUseOutcomeV1::ClaimAcquired { claim, .. } => claim.clone(),
        outcome => panic!("expected claim receipt, got {outcome:?}"),
    }
}

fn permit_request(
    fixture: &Fixture,
    instance: &GitCheckoutInstanceV1,
    operation_id: &str,
    retiring_claim_ids: Vec<OperationIdV1>,
) -> GitCheckoutUseRequestV1 {
    GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation(operation_id),
        action: GitCheckoutUseActionV1::AcquireRemovalPermit {
            instance: instance.clone(),
            retiring_claim_ids,
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
    }
}

fn permit_from(receipt: &GitCheckoutUseReceiptV1) -> GitCheckoutRemovalPermitV1 {
    match &receipt.outcome {
        GitCheckoutUseOutcomeV1::RemovalPermitted { permit } => permit.clone(),
        outcome => panic!("expected permit receipt, got {outcome:?}"),
    }
}

fn release_claim(
    fixture: &Fixture,
    instance: &GitCheckoutInstanceV1,
    operation_id: &str,
    claim_id: OperationIdV1,
) -> GitCheckoutUseReceiptV1 {
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation(operation_id),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id,
        },
    })
    .unwrap()
}

fn persist_legacy_permit(
    fixture: &Fixture,
    instance: &GitCheckoutInstanceV1,
    observed_revision: u64,
    retiring_claim_ids: Vec<OperationIdV1>,
) -> GitCheckoutRemovalPermitV1 {
    let (_, instance_digest) = Authority::for_instance(&fixture.repository, instance).unwrap();
    let permit_operation =
        legacy_operation_id("permit", observed_revision, &instance_digest).unwrap();
    permit_from(
        &apply_git_checkout_use(&permit_request(
            fixture,
            instance,
            permit_operation.as_str(),
            retiring_claim_ids,
        ))
        .unwrap(),
    )
}

fn physical_request(
    fixture: &Fixture,
    instance: &GitCheckoutInstanceV1,
    operation_id: OperationIdV1,
    permit_token: String,
) -> GitCheckoutUsePhysicalRemovalRequestV1 {
    GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id,
        instance: instance.clone(),
        permit_token,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    }
}

fn shared_contract() -> serde_json::Value {
    serde_json::from_str(include_str!("../test-vectors/checkout-use-v1.json")).unwrap()
}

fn compaction_expectation(id: &str) -> serde_json::Value {
    shared_contract()["releasedClaimCompaction"]
        .as_array()
        .unwrap()
        .iter()
        .find(|expectation| expectation["id"] == id)
        .unwrap_or_else(|| panic!("shared contract lost compaction expectation {id}"))
        .clone()
}

fn normalization_error(context: &str) -> String {
    shared_contract()["instanceErrorNormalization"][context]
        .as_str()
        .unwrap_or_else(|| panic!("shared contract lost error normalization context {context}"))
        .to_string()
}

fn assert_receipt_correlation(receipt: &GitCheckoutUseReceiptV1, operation_id: &str) {
    assert_eq!(receipt.operation_id, operation(operation_id));
    assert!(matches!(receipt.request_digest.len(), 40 | 64));
    assert!(
        receipt
            .request_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
}

#[test]
fn claim_first_blocks_legacy_remove_before_physical_git() {
    let fixture = fixture();
    let instance = capture(&fixture);
    apply_git_checkout_use(&claim_request(
        &fixture,
        &instance,
        "claim-first",
        "owner-first",
    ))
    .unwrap();

    let error = remove_git_checkout_instance_admitted(
        &fixture.repository,
        &instance,
        GitCheckoutRemovalPolicyV1::RequireClean,
    )
    .unwrap_err();

    assert_eq!(error.code, "checkout_use_in_use");
    assert!(fixture.linked.join(".git").is_file());
}

#[test]
fn permit_first_blocks_a_new_claim_before_projection_mutation() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let permit = apply_git_checkout_use(&permit_request(
        &fixture,
        &instance,
        "permit-first",
        Vec::new(),
    ))
    .unwrap();

    let error = apply_git_checkout_use(&claim_request(
        &fixture,
        &instance,
        "late-claim",
        "late-owner",
    ))
    .unwrap_err();

    assert_eq!(error.code, "checkout_use_phase_conflict");
    assert_eq!(permit.phase, GitCheckoutUsePhaseV1::Removing);
    assert!(fixture.linked.join(".git").is_file());
}

#[test]
fn legacy_remove_reuses_persisted_zero_claim_permit_after_response_loss() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let permit = persist_legacy_permit(&fixture, &instance, 0, Vec::new());
    assert_eq!(permit.revision.value(), 1);

    let removal = remove_git_checkout_instance_admitted(
        &fixture.repository,
        &instance,
        GitCheckoutRemovalPolicyV1::RequireClean,
    )
    .unwrap();

    assert_eq!(removal.outcome, GitCheckoutRemovalOutcomeV1::Removed);
    assert!(!fixture.linked.exists());
}

#[test]
fn legacy_remove_reconciles_a_persisted_physical_marker_without_reexecution() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let (authority, instance_digest) =
        Authority::for_instance(&fixture.repository, &instance).unwrap();
    let permit = persist_legacy_permit(&fixture, &instance, 0, Vec::new());
    let physical_operation =
        legacy_operation_id("physical", permit.revision.value(), &instance_digest).unwrap();
    let physical_request =
        physical_request(&fixture, &instance, physical_operation, permit.permit_token);
    let physical_digest =
        physical_request_digest(&authority, &instance_digest, &physical_request).unwrap();
    assert!(matches!(
        start_physical_removal(
            &authority,
            &instance_digest,
            &physical_request,
            &physical_digest,
        )
        .unwrap(),
        PhysicalStart::Execute
    ));

    let error = remove_git_checkout_instance_admitted_using(
        &fixture.repository,
        &instance,
        GitCheckoutRemovalPolicyV1::RequireClean,
        |_, _, _| panic!("persisted physical marker must suppress a second remover"),
    )
    .unwrap_err();
    assert_eq!(error.code, normalization_error("markedRemovalAmbiguous"));
    assert!(fixture.linked.join(".git").is_file());

    assert_eq!(
        super::super::remove_git_checkout_instance_at(&fixture.repository, &instance)
            .unwrap()
            .outcome,
        GitCheckoutRemovalOutcomeV1::Removed
    );
    let converged = remove_git_checkout_instance_admitted_using(
        &fixture.repository,
        &instance,
        GitCheckoutRemovalPolicyV1::RequireClean,
        |_, _, _| panic!("exact-absence reconciliation must not invoke the remover"),
    )
    .unwrap();
    assert_eq!(
        converged.outcome,
        GitCheckoutRemovalOutcomeV1::AlreadyAbsent
    );
}

#[test]
fn legacy_remove_adopts_a_permit_committed_after_intervening_revisions() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let initial_claim = claim_from(
        &apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "legacy-base-claim",
            "legacy-base-owner",
        ))
        .unwrap(),
    );
    release_claim(
        &fixture,
        &instance,
        "legacy-base-release",
        initial_claim.claim_id,
    );
    let setup_permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            "legacy-base-permit",
            Vec::new(),
        ))
        .unwrap(),
    );
    let setup_request = physical_request(
        &fixture,
        &instance,
        operation("legacy-base-physical"),
        setup_permit.permit_token,
    );
    assert_eq!(
        remove_git_checkout_with_permit_using(&setup_request, |_, _, _| {
            Err(GitCheckoutPhysicalRemovalError::RefusedBeforeInvocation(
                GitCheckoutInstanceError::new("worktree_not_clean", "test refusal"),
            ))
        })
        .unwrap_err()
        .code,
        "checkout_use_git_failed"
    );
    let (authority, instance_digest) =
        Authority::for_instance(&fixture.repository, &instance).unwrap();
    assert_eq!(read_state(&authority).unwrap().unwrap().state.revision, 5);

    let permit_operation = legacy_operation_id("permit", 5, &instance_digest).unwrap();
    let delayed_permit = permit_request(&fixture, &instance, permit_operation.as_str(), Vec::new());
    let interleaving_claim = claim_from(
        &apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "legacy-interleaving-claim",
            "legacy-interleaving-owner",
        ))
        .unwrap(),
    );
    release_claim(
        &fixture,
        &instance,
        "legacy-interleaving-release",
        interleaving_claim.claim_id,
    );
    let delayed = permit_from(&apply_git_checkout_use(&delayed_permit).unwrap());
    assert_eq!(delayed.operation_id, permit_operation);
    assert_eq!(delayed.revision.value(), 8);

    let invocations = std::sync::atomic::AtomicUsize::new(0);
    let removal = remove_git_checkout_instance_admitted_using(
        &fixture.repository,
        &instance,
        GitCheckoutRemovalPolicyV1::RequireClean,
        |repository, instance, policy| {
            invocations.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            remove_git_checkout_instance_at_classified(repository, instance, policy)
        },
    )
    .unwrap();
    assert_eq!(invocations.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(removal.outcome, GitCheckoutRemovalOutcomeV1::Removed);
}

#[test]
fn legacy_permit_operation_requires_a_canonical_bounded_observed_revision() {
    let instance_digest = "a".repeat(40);

    assert!(removal::owns_permit_operation(
        "legacy",
        &instance_digest,
        &format!("legacy-permit-r0-{instance_digest}"),
    ));
    assert!(removal::owns_permit_operation(
        "legacy",
        &instance_digest,
        &format!(
            "legacy-permit-r{}-{instance_digest}",
            MAX_GIT_CHECKOUT_USE_REVISION_V1
        ),
    ));
    for operation_id in [
        format!("legacy-permit-r00-{instance_digest}"),
        format!(
            "legacy-permit-r{}-{instance_digest}",
            MAX_GIT_CHECKOUT_USE_REVISION_V1 + 1
        ),
        format!("legacy-permit-r0-wrong-{instance_digest}"),
        format!("explicit-permit-r0-{instance_digest}"),
    ] {
        assert!(!removal::owns_permit_operation(
            "legacy",
            &instance_digest,
            &operation_id
        ));
    }
}

#[test]
fn legacy_remove_never_adopts_a_permit_that_retires_explicit_claims() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let claim = claim_from(
        &apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "explicit-retiring-claim",
            "explicit-retiring-owner",
        ))
        .unwrap(),
    );
    persist_legacy_permit(&fixture, &instance, 1, vec![claim.claim_id]);

    let error = remove_git_checkout_instance_admitted_using(
        &fixture.repository,
        &instance,
        GitCheckoutRemovalPolicyV1::RequireClean,
        |_, _, _| panic!("legacy removal must not consume an explicit retiring permit"),
    )
    .unwrap_err();

    assert_eq!(error.code, "checkout_use_phase_conflict");
    assert!(fixture.linked.join(".git").is_file());
}

#[test]
fn claim_and_zero_claim_permit_same_base_cas_has_one_authoritative_winner() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let claim_request = claim_request(&fixture, &instance, "cas-race-claim", "cas-race-owner");
    let permit_request = permit_request(&fixture, &instance, "cas-race-permit", Vec::new());
    let claim_prepared = prepare_request(&claim_request).unwrap();
    let permit_prepared = prepare_request(&permit_request).unwrap();
    let claim_state = reduce_request(None, &claim_prepared)
        .unwrap()
        .state
        .unwrap();
    let permit_state = reduce_request(None, &permit_prepared)
        .unwrap()
        .state
        .unwrap();
    let authority = claim_prepared.authority.clone();
    assert!(read_state(&authority).unwrap().is_none());

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let claim_authority = authority.clone();
    let claim_barrier = barrier.clone();
    let claim_writer = std::thread::spawn(move || {
        claim_barrier.wait();
        compare_and_swap(&claim_authority, None, &claim_state).unwrap()
    });
    let permit_authority = authority.clone();
    let permit_barrier = barrier.clone();
    let permit_writer = std::thread::spawn(move || {
        permit_barrier.wait();
        compare_and_swap(&permit_authority, None, &permit_state).unwrap()
    });
    barrier.wait();
    let claim_won = claim_writer.join().unwrap();
    let permit_won = permit_writer.join().unwrap();
    assert_ne!(claim_won, permit_won, "exactly one absent-ref CAS must win");

    let loser = if claim_won {
        apply_git_checkout_use(&permit_request).unwrap_err()
    } else {
        apply_git_checkout_use(&claim_request).unwrap_err()
    };
    assert_eq!(
        loser.code,
        if claim_won {
            "checkout_use_in_use"
        } else {
            "checkout_use_phase_conflict"
        }
    );
    let state = read_state(&authority).unwrap().unwrap().state;
    assert_eq!(
        state.phase(),
        if claim_won {
            Phase::Active
        } else {
            Phase::Removing
        }
    );
    assert!(fixture.linked.join(".git").is_file());
}

#[test]
fn request_locators_are_rejected_before_io_when_relative_overbound_or_non_normal() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let expected = normalization_error("request");
    let path_bound = shared_contract()["bounds"]["pathBytes"].as_u64().unwrap() as usize;

    for repository_path in [
        "relative/repository".to_string(),
        format!("{}/./", fixture.repository.display()),
        format!("/{}", "r".repeat(path_bound)),
    ] {
        let mut request = claim_request(
            &fixture,
            &instance,
            "invalid-repository-locator",
            "invalid-repository-owner",
        );
        request.repository_path = repository_path;
        assert_eq!(apply_git_checkout_use(&request).unwrap_err().code, expected);
    }

    let repository_first = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: "relative/repository".to_string(),
        operation_id: operation("invalid-repository-before-reserve-io"),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: fixture.linked.to_string_lossy().into_owned(),
            owner_id: operation("invalid-repository-before-reserve-owner"),
        },
    })
    .unwrap_err();
    assert_eq!(repository_first.code, expected);
    assert!(repository_first.message.starts_with("repository path"));

    let mut non_normal_instance = instance.clone();
    non_normal_instance.canonical_path =
        format!("{}/./linked", fixture._temporary.path().display());
    let request = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("invalid-checkout-locator"),
        action: GitCheckoutUseActionV1::Claim {
            instance: non_normal_instance,
            owner_id: operation("invalid-checkout-owner"),
        },
    };
    assert_eq!(apply_git_checkout_use(&request).unwrap_err().code, expected);

    let reserve = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("invalid-reservation-locator"),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: format!("{}/linked/../reserved", fixture._temporary.path().display()),
            owner_id: operation("invalid-reservation-owner"),
        },
    };
    assert_eq!(apply_git_checkout_use(&reserve).unwrap_err().code, expected);
    let trailing_separator = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("trailing-separator-reservation-locator"),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: format!("{}/reserved/", fixture._temporary.path().display()),
            owner_id: operation("trailing-separator-reservation-owner"),
        },
    };
    assert!(
        shared_contract()["creationLocator"]["rejectsTrailingSeparator"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        apply_git_checkout_use(&trailing_separator)
            .unwrap_err()
            .code,
        expected
    );
    for (operation_id, checkout_path) in [
        (
            "relative-reservation-locator",
            "relative/reserved".to_string(),
        ),
        (
            "root-reservation-locator",
            std::path::MAIN_SEPARATOR.to_string(),
        ),
    ] {
        let request = GitCheckoutUseRequestV1 {
            schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
            repository_path: fixture.repository.to_string_lossy().into_owned(),
            operation_id: operation(operation_id),
            action: GitCheckoutUseActionV1::ReserveCreation {
                checkout_path,
                owner_id: operation("invalid-reservation-leaf-owner"),
            },
        };
        assert_eq!(apply_git_checkout_use(&request).unwrap_err().code, expected);
    }

    let mut overbound_instance = instance;
    overbound_instance.git_dir = format!("/{}", "g".repeat(path_bound));
    let request = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("overbound-checkout-locator"),
        action: GitCheckoutUseActionV1::Claim {
            instance: overbound_instance,
            owner_id: operation("overbound-checkout-owner"),
        },
    };
    assert_eq!(apply_git_checkout_use(&request).unwrap_err().code, expected);
}

#[test]
fn same_owner_new_claim_is_distinct_and_release_is_exact() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let first_request = claim_request(&fixture, &instance, "claim-one", "same-owner");
    let first_receipt = apply_git_checkout_use(&first_request).unwrap();
    assert_eq!(
        apply_git_checkout_use(&first_request).unwrap(),
        first_receipt
    );
    let first = claim_from(&first_receipt);
    let second = claim_from(
        &apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "claim-two",
            "same-owner",
        ))
        .unwrap(),
    );
    assert_ne!(first.claim_id, second.claim_id);

    let changed = apply_git_checkout_use(&claim_request(
        &fixture,
        &instance,
        "claim-one",
        "changed-owner",
    ))
    .unwrap_err();
    assert_eq!(changed.code, "checkout_use_operation_conflict");

    let wrong_release = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("wrong-release"),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: operation("missing-claim"),
        },
    };
    assert_eq!(
        apply_git_checkout_use(&wrong_release).unwrap_err().code,
        "checkout_use_claim_missing"
    );

    let release_request = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("release-one"),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: first.claim_id.clone(),
        },
    };
    let released = apply_git_checkout_use(&release_request).unwrap();
    assert_receipt_correlation(&released, "release-one");
    let converged = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        operation_id: operation("release-one-converged"),
        ..release_request
    })
    .unwrap();
    assert_eq!(converged.operation_id, released.operation_id);
    assert_eq!(converged.request_digest, released.request_digest);
    assert_eq!(converged.revision, released.revision);
    match converged.outcome {
        GitCheckoutUseOutcomeV1::ClaimReleased { claim, .. } => {
            assert_eq!(claim.claim_id, first.claim_id);
        }
        outcome => panic!("expected converged release, got {outcome:?}"),
    }
    let permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            "permit-second-only",
            vec![second.claim_id.clone()],
        ))
        .unwrap(),
    );
    assert_eq!(permit.retiring_claims, vec![second]);
}

#[test]
fn terminal_permit_and_physical_requests_replay() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let permit_request = permit_request(&fixture, &instance, "terminal-permit", Vec::new());
    let permit = permit_from(&apply_git_checkout_use(&permit_request).unwrap());
    let physical_request = GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("terminal-physical"),
        instance: instance.clone(),
        permit_token: permit.permit_token.clone(),
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    };
    let forged_physical = GitCheckoutUsePhysicalRemovalRequestV1 {
        operation_id: operation("forged-terminal-physical"),
        permit_token: "0".repeat(permit.permit_token.len()),
        ..physical_request.clone()
    };
    assert_eq!(
        remove_git_checkout_with_permit(&forged_physical)
            .unwrap_err()
            .code,
        "checkout_use_phase_conflict"
    );
    assert!(fixture.linked.join(".git").is_file());
    let removed = remove_git_checkout_with_permit(&physical_request).unwrap();

    assert_eq!(
        remove_git_checkout_with_permit(&physical_request).unwrap(),
        removed
    );
    assert_eq!(
        remove_git_checkout_with_permit(&GitCheckoutUsePhysicalRemovalRequestV1 {
            operation_id: operation("different-terminal-physical"),
            ..physical_request.clone()
        })
        .unwrap_err()
        .code,
        "checkout_use_phase_conflict"
    );
    let permit_replay = apply_git_checkout_use(&permit_request).unwrap();
    assert_eq!(permit_replay.phase, GitCheckoutUsePhaseV1::Removed);
    match permit_replay.outcome {
        GitCheckoutUseOutcomeV1::Removed {
            permit: replayed,
            removal,
        } => {
            assert_eq!(replayed, permit);
            assert_eq!(removal.outcome, GitCheckoutRemovalOutcomeV1::Removed);
        }
        outcome => panic!("expected terminal removal, got {outcome:?}"),
    }
}

#[test]
fn physical_discard_policy_must_match_the_exact_permit() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            "clean-policy-permit",
            Vec::new(),
        ))
        .unwrap(),
    );
    let request = GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("mismatched-discard-physical"),
        instance,
        permit_token: permit.permit_token,
        policy: GitCheckoutRemovalPolicyV1::DiscardChanges,
    };

    let error = remove_git_checkout_with_permit(&request).unwrap_err();

    assert_eq!(error.code, "checkout_use_operation_conflict");
    assert!(fixture.linked.join(".git").is_file());
}

#[test]
fn removed_generation_accepts_only_the_new_exact_instance_at_the_next_revision() {
    let fixture = fixture();
    let old_instance = capture(&fixture);
    let permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &old_instance,
            "generation-permit",
            Vec::new(),
        ))
        .unwrap(),
    );
    let removed = remove_git_checkout_with_permit(&GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("generation-physical"),
        instance: old_instance.clone(),
        permit_token: permit.permit_token,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    })
    .unwrap();
    let removed_revision = removed.revision.value();

    git(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "--detach",
            fixture.linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    let new_instance = capture(&fixture);
    assert_ne!(new_instance, old_instance);
    let claimed = apply_git_checkout_use(&claim_request(
        &fixture,
        &new_instance,
        "new-generation-claim",
        "new-generation-owner",
    ))
    .unwrap();
    assert_eq!(claimed.phase, GitCheckoutUsePhaseV1::Active);
    assert_eq!(claimed.revision.value(), removed_revision + 1);
    assert_eq!(
        apply_git_checkout_use(&claim_request(
            &fixture,
            &old_instance,
            "stale-generation-claim",
            "stale-generation-owner",
        ))
        .unwrap_err()
        .code,
        "checkout_use_instance_conflict"
    );
}

#[test]
fn remove_before_terminal_retry_converges_through_already_absent() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            "crash-window-permit",
            Vec::new(),
        ))
        .unwrap(),
    );
    let request = GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("crash-window-physical"),
        instance: instance.clone(),
        permit_token: permit.permit_token,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    };
    let (authority, instance_digest) =
        Authority::for_instance(&fixture.repository, &instance).unwrap();
    let request_digest = physical_request_digest(&authority, &instance_digest, &request).unwrap();
    assert!(matches!(
        start_physical_removal(&authority, &instance_digest, &request, &request_digest).unwrap(),
        PhysicalStart::Execute
    ));
    assert_eq!(
        remove_git_checkout_with_permit(&request).unwrap_err().code,
        normalization_error("markedRemovalAmbiguous")
    );
    assert!(fixture.linked.join(".git").is_file());
    let in_flight = read_state(&authority).unwrap().unwrap().state;
    assert_eq!(in_flight.phase(), Phase::Removing);
    assert!(in_flight.physical().is_some());
    assert_eq!(
        super::super::remove_git_checkout_instance_at(&fixture.repository, &instance)
            .unwrap()
            .outcome,
        GitCheckoutRemovalOutcomeV1::Removed
    );

    let converged = remove_git_checkout_with_permit(&request).unwrap();
    assert_eq!(
        remove_git_checkout_with_permit(&request).unwrap(),
        converged
    );
    match converged.outcome {
        GitCheckoutUseOutcomeV1::Removed { removal, .. } => {
            assert_eq!(removal.outcome, GitCheckoutRemovalOutcomeV1::AlreadyAbsent);
        }
        outcome => panic!("expected terminal removal, got {outcome:?}"),
    }
}

#[test]
fn overlapping_physical_replay_never_invokes_a_second_executor_or_clears_the_marker() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            "overlap-permit",
            Vec::new(),
        ))
        .unwrap(),
    );
    let request = GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("overlap-physical"),
        instance: instance.clone(),
        permit_token: permit.permit_token,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    };
    let (entered_sender, entered_receiver) = std::sync::mpsc::sync_channel(0);
    let (continue_sender, continue_receiver) = std::sync::mpsc::sync_channel(0);
    let first_request = request.clone();
    let first = std::thread::spawn(move || {
        remove_git_checkout_with_permit_using(&first_request, |repository, instance, policy| {
            entered_sender.send(()).unwrap();
            continue_receiver.recv().unwrap();
            remove_git_checkout_instance_at_classified(repository, instance, policy)
        })
    });
    entered_receiver.recv().unwrap();

    let replay_error = remove_git_checkout_with_permit_using(&request, |_, _, _| {
        panic!("an in-flight physical replay must never invoke another executor")
    })
    .unwrap_err();
    assert_eq!(
        replay_error.code,
        normalization_error("markedRemovalAmbiguous")
    );
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    let in_flight = read_state(&authority).unwrap().unwrap().state;
    assert_eq!(in_flight.phase(), Phase::Removing);
    assert!(in_flight.physical().is_some());

    continue_sender.send(()).unwrap();
    let removed = first.join().unwrap().unwrap();
    assert_eq!(removed.phase, GitCheckoutUsePhaseV1::Removed);
}

#[test]
fn attempted_partial_physical_failure_never_rolls_back_or_reexecutes() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            "partial-permit",
            Vec::new(),
        ))
        .unwrap(),
    );
    let request = GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("partial-physical"),
        instance: instance.clone(),
        permit_token: permit.permit_token,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    };
    let invocations = std::sync::atomic::AtomicUsize::new(0);
    let error = remove_git_checkout_with_permit_using(&request, |_, instance, _| {
        invocations.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        fs::remove_dir_all(&instance.as_instance().git_dir).unwrap();
        Err(GitCheckoutPhysicalRemovalError::Attempted(
            GitCheckoutInstanceError::new(
                "worktree_remove_failed",
                "injected partial physical failure",
            ),
        ))
    })
    .unwrap_err();
    assert_eq!(error.code, normalization_error("markedRemovalAmbiguous"));
    assert!(fixture.linked.exists());

    let replay = remove_git_checkout_with_permit_using(&request, |_, _, _| {
        invocations.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        panic!("a partial attempted failure must never authorize reexecution")
    })
    .unwrap_err();
    assert_eq!(replay.code, normalization_error("markedRemovalAmbiguous"));
    assert_eq!(invocations.load(std::sync::atomic::Ordering::SeqCst), 1);
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    let in_flight = read_state(&authority).unwrap().unwrap().state;
    assert_eq!(in_flight.phase(), Phase::Removing);
    assert!(in_flight.physical().is_some());
    assert!(in_flight.last_abort().is_none());
}

#[test]
fn active_instance_never_accepts_a_different_instance_even_when_quiescent() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let claim = claim_from(
        &apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "quiescent-claim",
            "quiescent-owner",
        ))
        .unwrap(),
    );
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("quiescent-release"),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: claim.claim_id,
        },
    })
    .unwrap();
    let mut replacement = instance.clone();
    replacement.instance_token = format!("dwt1_{}", "0".repeat(32));

    assert_eq!(
        apply_git_checkout_use(&GitCheckoutUseRequestV1 {
            schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
            repository_path: fixture.repository.to_string_lossy().into_owned(),
            operation_id: operation("replacement-claim"),
            action: GitCheckoutUseActionV1::Claim {
                instance: replacement.clone(),
                owner_id: operation("replacement-owner"),
            },
        })
        .unwrap_err()
        .code,
        normalization_error("identity")
    );
    assert_eq!(
        apply_git_checkout_use(&permit_request(
            &fixture,
            &replacement,
            "replacement-permit",
            Vec::new(),
        ))
        .unwrap_err()
        .code,
        normalization_error("identity")
    );
    let (authority, original_digest) =
        Authority::for_instance(&fixture.repository, &instance).unwrap();
    let state = read_state(&authority).unwrap().unwrap().state;
    assert_eq!(state.phase(), Phase::Active);
    assert_eq!(state.instance_digest(), Some(original_digest.as_str()));
}

#[test]
fn admission_revalidation_never_recreates_a_missing_instance_token_or_lock() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let token_path = Path::new(&instance.git_dir).join(super::super::INSTANCE_TOKEN_FILE);
    let lock_path = Path::new(&instance.git_dir).join(super::super::INSTANCE_TOKEN_LOCK_FILE);
    fs::remove_file(&token_path).unwrap();
    if lock_path.exists() {
        fs::remove_file(&lock_path).unwrap();
    }

    let claim_error = apply_git_checkout_use(&claim_request(
        &fixture,
        &instance,
        "missing-token-claim",
        "missing-token-owner",
    ))
    .unwrap_err();
    assert_eq!(claim_error.code, normalization_error("identity"));
    assert!(!token_path.exists());
    assert!(!lock_path.exists());

    let permit_error = apply_git_checkout_use(&permit_request(
        &fixture,
        &instance,
        "missing-token-permit",
        Vec::new(),
    ))
    .unwrap_err();
    assert_eq!(permit_error.code, normalization_error("identity"));
    assert!(!token_path.exists());
    assert!(!lock_path.exists());

    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    assert!(read_state(&authority).unwrap().is_none());
}

#[test]
fn replacement_objects_cannot_hide_staged_dirty_data_from_admitted_removal() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let tracked = fixture.linked.join("tracked.txt");
    fs::write(&tracked, "replacement tree\n").unwrap();
    git(&fixture.linked, &["add", "tracked.txt"]);
    let replacement_tree = git(&fixture.linked, &["write-tree"]);
    let replacement_commit = git(
        &fixture.linked,
        &["commit-tree", &replacement_tree, "-m", "replacement tree"],
    );
    let real_head = git(&fixture.linked, &["rev-parse", "HEAD"]);
    git(
        &fixture.repository,
        &["replace", &real_head, &replacement_commit],
    );
    assert_eq!(
        git(
            &fixture.linked,
            &["status", "--porcelain=v1", "--untracked-files=all"]
        ),
        "",
        "the forged replacement must reproduce the plain-Git clean-status exploit"
    );

    let error = remove_git_checkout_instance_admitted(
        &fixture.repository,
        &instance,
        GitCheckoutRemovalPolicyV1::RequireClean,
    )
    .unwrap_err();
    assert_eq!(error.code, normalization_error("git"));
    assert!(fixture.linked.join(".git").is_file());
    assert_eq!(fs::read_to_string(tracked).unwrap(), "replacement tree\n");
}

#[test]
fn refused_dirty_legacy_remove_exactly_aborts_and_a_later_retry_can_finish() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let released_claim = claim_from(
        &apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "dirty-released-claim",
            "dirty-released-owner",
        ))
        .unwrap(),
    );
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("dirty-release"),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: released_claim.claim_id,
        },
    })
    .unwrap();
    let dirty = fixture.linked.join("dirty.txt");
    fs::write(&dirty, "keep\n").unwrap();
    assert_eq!(
        remove_git_checkout_instance_admitted(
            &fixture.repository,
            &instance,
            GitCheckoutRemovalPolicyV1::RequireClean,
        )
        .unwrap_err()
        .code,
        normalization_error("git")
    );
    assert!(fixture.linked.exists());
    let expectation = compaction_expectation("physical_failure_rollback");
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    let rolled_back = read_state(&authority).unwrap().unwrap().state;
    assert_eq!(
        rolled_back
            .claims
            .values()
            .filter(|claim| !claim.is_active())
            .count(),
        expectation["afterReleasedClaims"].as_u64().unwrap() as usize
    );
    assert_eq!(
        rolled_back.permit().is_some(),
        expectation["permitRetained"]
    );
    assert_eq!(
        rolled_back.last_abort().is_some(),
        expectation["lastAbortRetained"]
    );

    fs::remove_file(dirty).unwrap();
    assert_eq!(
        remove_git_checkout_instance_admitted(
            &fixture.repository,
            &instance,
            GitCheckoutRemovalPolicyV1::RequireClean,
        )
        .unwrap()
        .outcome,
        GitCheckoutRemovalOutcomeV1::Removed
    );
}

#[test]
fn strict_state_decoder_rejects_duplicate_and_wrong_width_rows() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let claim_receipt = claim_from(
        &apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "codec-claim",
            "codec-owner",
        ))
        .unwrap(),
    );
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    let loaded = read_state(&authority).unwrap().unwrap();
    let valid = encode_state(&loaded.state).unwrap();
    assert_eq!(decode_state(&authority, &valid).unwrap().revision, 1);

    let text = String::from_utf8(valid).unwrap();
    let claim_row = text
        .lines()
        .find(|line| line.starts_with("claim "))
        .unwrap();
    let duplicate = text.replace("claims 1\n", "claims 2\n").replace(
        &format!("{claim_row}\n"),
        &format!("{claim_row}\n{claim_row}\n"),
    );
    assert_eq!(
        decode_state(&authority, duplicate.as_bytes())
            .err()
            .unwrap()
            .code,
        "checkout_use_state_invalid"
    );
    let wrong_width = text.replace(
        &format!("path {}", authority.path_digest),
        &format!("path {}0", authority.path_digest),
    );
    assert_eq!(
        decode_state(&authority, wrong_width.as_bytes())
            .err()
            .unwrap()
            .code,
        "checkout_use_state_invalid"
    );

    let permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            "codec-permit",
            vec![claim_receipt.claim_id],
        ))
        .unwrap(),
    );
    let loaded = read_state(&authority).unwrap().unwrap();
    let valid = String::from_utf8(encode_state(&loaded.state).unwrap()).unwrap();
    let malformed = valid.replace(
        &format!("permit {} ", permit.permit_token),
        &format!("permit {} ", "0".repeat(permit.permit_token.len())),
    );
    assert_eq!(
        decode_state(&authority, malformed.as_bytes())
            .err()
            .unwrap()
            .code,
        "checkout_use_state_invalid"
    );
    let malformed_path = fixture._temporary.path().join("malformed-checkout-use");
    fs::write(&malformed_path, &malformed).unwrap();
    let malformed_oid = git(
        &fixture.repository,
        &["hash-object", "-w", malformed_path.to_str().unwrap()],
    );
    git(
        &fixture.repository,
        &["update-ref", &authority.reference, &malformed_oid],
    );
    assert_eq!(
        apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "must-not-overwrite-malformed",
            "malformed-owner",
        ))
        .unwrap_err()
        .code,
        "checkout_use_state_invalid"
    );
    assert_eq!(
        git(&fixture.repository, &["rev-parse", &authority.reference]),
        malformed_oid
    );
}

#[test]
fn authority_ref_rejects_an_oversized_blob_before_state_decode() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    let oversized_path = fixture._temporary.path().join("oversized-checkout-use");
    fs::write(&oversized_path, vec![b'x'; MAX_RECORD_BYTES + 1]).unwrap();
    let oversized_oid = git(
        &fixture.repository,
        &["hash-object", "-w", oversized_path.to_str().unwrap()],
    );
    git(
        &fixture.repository,
        &[
            "update-ref",
            "--no-deref",
            &authority.reference,
            &oversized_oid,
        ],
    );

    assert_eq!(
        read_state(&authority).err().unwrap().code,
        "checkout_use_record_too_large"
    );
}

#[test]
fn authority_blob_size_and_read_ignore_git_replacement_objects() {
    let fixture = fixture();
    let instance = capture(&fixture);
    apply_git_checkout_use(&claim_request(
        &fixture,
        &instance,
        "replacement-object-claim",
        "replacement-object-owner",
    ))
    .unwrap();
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    let original = read_state(&authority).unwrap().unwrap();
    let oversized_path = fixture._temporary.path().join("replacement-object-blob");
    fs::write(&oversized_path, vec![b'x'; MAX_RECORD_BYTES + 1]).unwrap();
    let oversized_oid = git(
        &fixture.repository,
        &["hash-object", "-w", oversized_path.to_str().unwrap()],
    );
    git(
        &fixture.repository,
        &["replace", &original.oid, &oversized_oid],
    );

    let reread = read_state(&authority).unwrap().unwrap();
    assert_eq!(reread.oid, original.oid);
    assert_eq!(
        encode_state(&reread.state).unwrap(),
        encode_state(&original.state).unwrap()
    );
}

#[cfg(unix)]
#[test]
fn authority_git_operations_disable_repository_hooks() {
    use std::os::unix::fs::PermissionsExt as _;

    let fixture = fixture();
    let hooks = fixture._temporary.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("reference-transaction");
    fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    let mut permissions = fs::metadata(&hook).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&hook, permissions).unwrap();
    git(
        &fixture.repository,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );

    let instance = capture(&fixture);
    let receipt = apply_git_checkout_use(&claim_request(
        &fixture,
        &instance,
        "hook-claim",
        "hook-owner",
    ))
    .unwrap();
    assert_eq!(receipt.phase, GitCheckoutUsePhaseV1::Active);
    let claim = claim_from(&receipt);
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("hook-release"),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: claim.claim_id,
        },
    })
    .unwrap();
    let permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            "hook-permit",
            Vec::new(),
        ))
        .unwrap(),
    );
    let removed = remove_git_checkout_with_permit(&GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("hook-physical"),
        instance,
        permit_token: permit.permit_token,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    })
    .unwrap();
    assert_eq!(removed.phase, GitCheckoutUsePhaseV1::Removed);
}

#[test]
fn symbolic_authority_ref_is_rejected_without_touching_its_target() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    let target = "refs/dure/checkout-use-test/sentinel";
    git(&fixture.repository, &["update-ref", target, "HEAD"]);
    git(
        &fixture.repository,
        &["symbolic-ref", &authority.reference, target],
    );

    let error = apply_git_checkout_use(&claim_request(
        &fixture,
        &instance,
        "symbolic-claim",
        "symbolic-owner",
    ))
    .unwrap_err();

    assert_eq!(error.code, "checkout_use_state_invalid");
    assert_eq!(
        git(&fixture.repository, &["rev-parse", target]),
        git(&fixture.repository, &["rev-parse", "HEAD"])
    );
}

#[test]
fn sha256_repository_uses_git_derived_64_digit_authority_oids_when_supported() {
    let Some(fixture) = fixture_with_init_args(&["init", "--object-format=sha256", "-b", "main"])
    else {
        return;
    };
    let instance = capture(&fixture);
    apply_git_checkout_use(&claim_request(
        &fixture,
        &instance,
        "sha256-claim",
        "sha256-owner",
    ))
    .unwrap();
    let (authority, instance_digest) =
        Authority::for_instance(&fixture.repository, &instance).unwrap();
    let loaded = read_state(&authority).unwrap().unwrap();

    assert_eq!(authority.path_digest.len(), 64);
    assert_eq!(instance_digest.len(), 64);
    assert_eq!(loaded.oid.len(), 64);
}

fn maximum_operation_id(prefix: char, index: usize) -> OperationIdV1 {
    operation(&format!("{prefix}{index:03}{}", "x".repeat(156)))
}

fn serialized_kind(value: &impl serde::Serialize) -> String {
    serde_json::to_value(value).unwrap()["kind"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn shared_checkout_use_v1_vector_matches_rust_codec_and_hash_framing() {
    let contract = shared_contract();
    let bounds = &contract["bounds"];
    assert_eq!(
        bounds["pathBytes"].as_u64().unwrap() as usize,
        dure_app_protocol::MAX_GIT_CHECKOUT_USE_PATH_BYTES_V1
    );
    assert_eq!(
        bounds["activeClaims"].as_u64().unwrap() as usize,
        MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1
    );
    assert_eq!(
        bounds["retainedClaims"].as_u64().unwrap() as usize,
        MAX_CLAIMS
    );
    assert_eq!(
        bounds["recordBytes"].as_u64().unwrap() as usize,
        MAX_RECORD_BYTES
    );
    assert_eq!(
        bounds["maxRevision"].as_str().unwrap(),
        MAX_GIT_CHECKOUT_USE_REVISION_V1.to_string()
    );
    assert_eq!(
        bounds["casAttempts"].as_u64().unwrap() as usize,
        MAX_CAS_ATTEMPTS
    );
    assert_eq!(
        contract["schemaVersion"].as_u64().unwrap(),
        u64::from(GIT_CHECKOUT_USE_SCHEMA_VERSION_V1)
    );
    assert_eq!(contract["refPrefix"].as_str().unwrap(), REF_PREFIX);
    assert_eq!(
        contract["creationLocator"],
        serde_json::json!({
            "requiresAbsolute": true,
            "requiresNormalLeaf": true,
            "rejectsTrailingSeparator": true,
        })
    );
    assert_eq!(
        bounds["oidWidths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|width| width.as_u64().unwrap())
            .collect::<Vec<_>>(),
        [40, 64]
    );
    let phase_tokens = [
        GitCheckoutUsePhaseV1::Creating,
        GitCheckoutUsePhaseV1::Active,
        GitCheckoutUsePhaseV1::Removing,
        GitCheckoutUsePhaseV1::Removed,
    ]
    .map(|phase| {
        serde_json::to_value(phase)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    });
    assert_eq!(
        contract["phases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|phase| phase.as_str().unwrap())
            .collect::<Vec<_>>(),
        phase_tokens
    );
    assert_eq!(
        contract["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|error| error.as_str().unwrap())
            .collect::<Vec<_>>(),
        CHECKOUT_USE_ERROR_CODES
    );
    assert_eq!(
        contract["instanceErrorNormalization"],
        serde_json::json!({
            "request": normalization_error("request"),
            "identity": normalization_error("identity"),
            "git": normalization_error("git"),
            "markedRemovalAmbiguous": normalization_error("markedRemovalAmbiguous"),
        })
    );
    assert_eq!(
        contract["releasedClaimCompaction"]
            .as_array()
            .unwrap()
            .iter()
            .map(|expectation| expectation["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["abort_removal", "physical_failure_rollback"]
    );
    assert!(
        contract["releasedClaimCompaction"]
            .as_array()
            .unwrap()
            .iter()
            .all(|expectation| expectation["retainsReleasedReservationClaim"] == true)
    );
    assert_eq!(
        contract["domains"]["path"].as_str().unwrap().as_bytes(),
        PATH_DOMAIN
    );
    assert_eq!(
        contract["domains"]["instance"].as_str().unwrap().as_bytes(),
        INSTANCE_DOMAIN
    );
    assert_eq!(
        contract["domains"]["request"].as_str().unwrap().as_bytes(),
        REQUEST_DOMAIN
    );
    assert_eq!(
        contract["domains"]["reservation"]
            .as_str()
            .unwrap()
            .as_bytes(),
        RESERVATION_DOMAIN
    );
    assert_eq!(
        contract["domains"]["permit"].as_str().unwrap().as_bytes(),
        PERMIT_DOMAIN
    );

    let fixture = fixture_with_init_args(&["init", "--object-format=sha1", "-b", "main"]).unwrap();
    assert_eq!(
        contract["sha1Vectors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|vector| vector["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "path-newline",
            "instance",
            "request-reserve",
            "request-abort-creation",
            "request-start-creation",
            "request-activate",
            "request-claim",
            "request-release",
            "request-permit",
            "request-abort-removal",
            "request-physical-remove",
            "reservation-token",
            "permit-token",
        ]
    );
    for vector in contract["sha1Vectors"].as_array().unwrap() {
        let domain = match vector["domain"].as_str().unwrap() {
            "path" => PATH_DOMAIN,
            "instance" => INSTANCE_DOMAIN,
            "request" => REQUEST_DOMAIN,
            "reservation" => RESERVATION_DOMAIN,
            "permit" => PERMIT_DOMAIN,
            domain => panic!("unknown shared digest domain {domain}"),
        };
        let fields = vector["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|field| field.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            digest_fields(&fixture.repository, domain, &fields).unwrap(),
            vector["oid"].as_str().unwrap()
        );
    }
    if let Some(sha256_fixture) =
        fixture_with_init_args(&["init", "--object-format=sha256", "-b", "main"])
    {
        let sha256_oids = contract["sha256Oids"].as_object().unwrap();
        assert_eq!(
            sha256_oids.len(),
            contract["sha1Vectors"].as_array().unwrap().len()
        );
        for vector in contract["sha1Vectors"].as_array().unwrap() {
            let id = vector["id"].as_str().unwrap();
            let domain = match vector["domain"].as_str().unwrap() {
                "path" => PATH_DOMAIN,
                "instance" => INSTANCE_DOMAIN,
                "request" => REQUEST_DOMAIN,
                "reservation" => RESERVATION_DOMAIN,
                "permit" => PERMIT_DOMAIN,
                domain => panic!("unknown shared digest domain {domain}"),
            };
            let fields = vector["fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|field| field.as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                digest_fields(&sha256_fixture.repository, domain, &fields).unwrap(),
                sha256_oids[id].as_str().unwrap(),
                "SHA-256 digest vector {id} drifted"
            );
        }
    }

    let instance = capture(&fixture);
    let placeholder_token = "0".repeat(40);
    let action_target = fixture._temporary.path().join("vector-action-target");
    let actions = [
        GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: action_target.to_string_lossy().into_owned(),
            owner_id: operation("vector-action-owner"),
        },
        GitCheckoutUseActionV1::AbortCreation {
            canonical_path: action_target.to_string_lossy().into_owned(),
            reservation_token: placeholder_token.clone(),
        },
        GitCheckoutUseActionV1::StartCreation {
            canonical_path: action_target.to_string_lossy().into_owned(),
            reservation_token: placeholder_token.clone(),
        },
        GitCheckoutUseActionV1::ActivateCreation {
            instance: instance.clone(),
            reservation_token: placeholder_token.clone(),
        },
        GitCheckoutUseActionV1::Claim {
            instance: instance.clone(),
            owner_id: operation("vector-action-owner"),
        },
        GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: operation("vector-action-claim"),
        },
        GitCheckoutUseActionV1::AcquireRemovalPermit {
            instance: instance.clone(),
            retiring_claim_ids: vec![operation("vector-action-claim")],
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        GitCheckoutUseActionV1::AbortRemoval {
            instance: instance.clone(),
            permit_token: placeholder_token,
        },
        GitCheckoutUseActionV1::RetireAbsentCheckout {
            checkout_path: fixture.linked.to_string_lossy().into_owned(),
        },
    ];
    let mut action_tokens = actions.iter().map(serialized_kind).collect::<Vec<_>>();
    action_tokens.push("physical_remove".to_string());
    assert_eq!(
        action_tokens,
        contract["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|action| action.as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    );

    let claim_acquired = apply_git_checkout_use(&claim_request(
        &fixture,
        &instance,
        "vector-claim",
        "vector-owner",
    ))
    .unwrap();
    let serialized_receipt = serde_json::to_string(&claim_acquired).unwrap();
    let receipt_fields = contract["receiptFields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|field| field.as_str().unwrap())
        .collect::<Vec<_>>();
    let receipt_value = serde_json::to_value(&claim_acquired).unwrap();
    let mut actual_fields = receipt_value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    actual_fields.sort_unstable();
    let mut expected_fields = receipt_fields.clone();
    expected_fields.sort_unstable();
    assert_eq!(actual_fields, expected_fields);
    let field_positions = receipt_fields
        .iter()
        .map(|field| serialized_receipt.find(&format!("\"{field}\"")).unwrap())
        .collect::<Vec<_>>();
    assert!(
        field_positions
            .windows(2)
            .all(|positions| positions[0] < positions[1])
    );
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    let record =
        String::from_utf8(encode_state(&read_state(&authority).unwrap().unwrap().state).unwrap())
            .unwrap();
    let row_order = record
        .lines()
        .map(|line| {
            if line == RECORD_HEADER {
                RECORD_HEADER
            } else if line.starts_with("claim ") {
                "claim..."
            } else {
                line.split(' ').next().unwrap()
            }
        })
        .collect::<Vec<_>>();
    let expected_rows = contract["recordRows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row.as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(row_order, expected_rows);

    let claim = claim_from(&claim_acquired);
    let claim_released = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("vector-release"),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: claim.claim_id,
        },
    })
    .unwrap();
    let removal_permit_request = permit_request(&fixture, &instance, "vector-permit", Vec::new());
    let removal_permitted = apply_git_checkout_use(&removal_permit_request).unwrap();
    let permit = permit_from(&removal_permitted);
    let removal_abort_request = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("vector-abort-removal"),
        action: GitCheckoutUseActionV1::AbortRemoval {
            instance: instance.clone(),
            permit_token: permit.permit_token.clone(),
        },
    };
    let removal_aborted = apply_git_checkout_use(&removal_abort_request).unwrap();
    assert_eq!(
        apply_git_checkout_use(&removal_abort_request).unwrap(),
        removal_aborted
    );
    let replayed_permit = apply_git_checkout_use(&removal_permit_request).unwrap();
    assert_eq!(replayed_permit.operation_id, removal_permitted.operation_id);
    assert_eq!(
        replayed_permit.request_digest,
        removal_permitted.request_digest
    );
    assert_eq!(replayed_permit.revision, removal_aborted.revision);
    assert_eq!(replayed_permit.phase, GitCheckoutUsePhaseV1::Active);
    match replayed_permit.outcome {
        GitCheckoutUseOutcomeV1::RemovalAborted { permit: replayed } => {
            assert_eq!(replayed, permit);
        }
        outcome => panic!("expected replayed removal abort, got {outcome:?}"),
    }
    let terminal_permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            "vector-terminal-permit",
            Vec::new(),
        ))
        .unwrap(),
    );
    let removed = remove_git_checkout_with_permit(&GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("vector-physical"),
        instance,
        permit_token: terminal_permit.permit_token,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    })
    .unwrap();

    let creation_target = fixture._temporary.path().join("vector-created");
    let creation_reserved = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("vector-reserve"),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: creation_target.to_string_lossy().into_owned(),
            owner_id: operation("vector-create-owner"),
        },
    })
    .unwrap();
    let reservation = match &creation_reserved.outcome {
        GitCheckoutUseOutcomeV1::CreationReserved { reservation } => reservation.clone(),
        _ => unreachable!(),
    };
    let creation_started = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("vector-start"),
        action: GitCheckoutUseActionV1::StartCreation {
            canonical_path: reservation.canonical_path.clone(),
            reservation_token: reservation.reservation_token.clone(),
        },
    })
    .unwrap();
    git(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "--detach",
            creation_target.to_str().unwrap(),
            "HEAD",
        ],
    );
    let created_instance =
        capture_git_checkout_instance_at(&fixture.repository, &creation_target).unwrap();
    let creation_activated = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("vector-activate"),
        action: GitCheckoutUseActionV1::ActivateCreation {
            instance: created_instance,
            reservation_token: reservation.reservation_token,
        },
    })
    .unwrap();
    let aborted_target = fixture._temporary.path().join("vector-aborted");
    let aborted_reservation_receipt = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("vector-abort-reserve"),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: aborted_target.to_string_lossy().into_owned(),
            owner_id: operation("vector-abort-owner"),
        },
    })
    .unwrap();
    assert_receipt_correlation(&aborted_reservation_receipt, "vector-abort-reserve");
    let aborted_reservation = match aborted_reservation_receipt.outcome {
        GitCheckoutUseOutcomeV1::CreationReserved { reservation } => reservation,
        _ => unreachable!(),
    };
    let creation_aborted = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("vector-abort-creation"),
        action: GitCheckoutUseActionV1::AbortCreation {
            canonical_path: aborted_reservation.canonical_path,
            reservation_token: aborted_reservation.reservation_token,
        },
    })
    .unwrap();
    let absent_target = fixture._temporary.path().join("vector-absent");
    git(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "--detach",
            absent_target.to_str().unwrap(),
            "HEAD",
        ],
    );
    let absent_instance =
        capture_git_checkout_instance_at(&fixture.repository, &absent_target).unwrap();
    let absent_claim = claim_from(
        &apply_git_checkout_use(&claim_request(
            &fixture,
            &absent_instance,
            "vector-absent-claim",
            "vector-absent-owner",
        ))
        .unwrap(),
    );
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("vector-absent-release"),
        action: GitCheckoutUseActionV1::Release {
            instance: absent_instance,
            claim_id: absent_claim.claim_id,
        },
    })
    .unwrap();
    git(
        &fixture.repository,
        &[
            "worktree",
            "remove",
            "--force",
            absent_target.to_str().unwrap(),
        ],
    );
    let absent_checkout_retired = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("vector-retire-absent"),
        action: GitCheckoutUseActionV1::RetireAbsentCheckout {
            checkout_path: absent_target.to_string_lossy().into_owned(),
        },
    })
    .unwrap();
    for (receipt, operation_id) in [
        (&creation_reserved, "vector-reserve"),
        (&creation_aborted, "vector-abort-creation"),
        (&creation_started, "vector-start"),
        (&creation_activated, "vector-activate"),
        (&claim_acquired, "vector-claim"),
        (&claim_released, "vector-release"),
        (&removal_permitted, "vector-permit"),
        (&removal_aborted, "vector-abort-removal"),
        (&removed, "vector-physical"),
        (&absent_checkout_retired, "vector-retire-absent"),
    ] {
        assert_receipt_correlation(receipt, operation_id);
    }
    let outcome_tokens = vec![
        serialized_kind(&creation_reserved.outcome),
        serialized_kind(&creation_aborted.outcome),
        serialized_kind(&creation_started.outcome),
        serialized_kind(&creation_activated.outcome),
        serialized_kind(&claim_acquired.outcome),
        serialized_kind(&claim_released.outcome),
        serialized_kind(&removal_permitted.outcome),
        serialized_kind(&removal_aborted.outcome),
        serialized_kind(&removed.outcome),
        serialized_kind(&absent_checkout_retired.outcome),
    ];
    assert_eq!(
        outcome_tokens,
        contract["outcomes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|outcome| outcome.as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    );
}

#[test]
fn shared_state_blob_cases_are_accepted_or_rejected_by_the_real_strict_decoder() {
    let fixture = fixture_with_init_args(&["init", "--object-format=sha1", "-b", "main"]).unwrap();
    let authority = Authority {
        git_common_dir: fixture.repository.join(".git"),
        repository: fixture.repository,
        canonical_path: "/checkout-use-vector".to_string(),
        path_digest: "0".repeat(40),
        reference: format!("{REF_PREFIX}{}", "0".repeat(40)),
        oid_width: 40,
    };

    for case in shared_contract()["stateBlobCases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let phase = case["phase"].as_str().unwrap();
        let record = case["record"].as_str().unwrap().as_bytes();
        match case["accept"].as_bool().unwrap() {
            true => {
                let state = decode_state(&authority, record)
                    .unwrap_or_else(|error| panic!("state blob case {id} failed: {error}"));
                assert_eq!(format!("{:?}", state.phase()).to_lowercase(), phase);
                assert_eq!(encode_state(&state).unwrap(), record);
            }
            false => assert_eq!(
                decode_state(&authority, record).err().unwrap().code,
                "checkout_use_state_invalid",
                "forged state blob case {id} was accepted"
            ),
        }
    }
}

#[test]
fn retained_claim_capacity_never_blocks_cleanup_or_terminal_removal() {
    let fixture = fixture();
    let instance = capture(&fixture);
    let owner = operation(&format!("o{}", "x".repeat(159)));
    let mut claim_ids = Vec::new();
    for index in 0..MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1 {
        let claim_id = maximum_operation_id('c', index);
        let receipt = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
            schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
            repository_path: fixture.repository.to_string_lossy().into_owned(),
            operation_id: claim_id.clone(),
            action: GitCheckoutUseActionV1::Claim {
                instance: instance.clone(),
                owner_id: owner.clone(),
            },
        })
        .unwrap();
        claim_ids.push(claim_from(&receipt).claim_id);
    }
    assert_eq!(
        apply_git_checkout_use(&claim_request(
            &fixture,
            &instance,
            "claim-over-capacity",
            "owner-over-capacity",
        ))
        .unwrap_err()
        .code,
        "checkout_use_capacity_exceeded"
    );

    for (index, claim_id) in claim_ids.into_iter().enumerate() {
        apply_git_checkout_use(&GitCheckoutUseRequestV1 {
            schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
            repository_path: fixture.repository.to_string_lossy().into_owned(),
            operation_id: maximum_operation_id('r', index),
            action: GitCheckoutUseActionV1::Release {
                instance: instance.clone(),
                claim_id,
            },
        })
        .unwrap();
    }
    let first_permit_operation = maximum_operation_id('p', 0);
    let permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            first_permit_operation.as_str(),
            Vec::new(),
        ))
        .unwrap(),
    );
    let aborted = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: maximum_operation_id('a', 0),
        action: GitCheckoutUseActionV1::AbortRemoval {
            instance: instance.clone(),
            permit_token: permit.permit_token,
        },
    })
    .unwrap();
    assert_eq!(aborted.phase, GitCheckoutUsePhaseV1::Active);

    let expectation = compaction_expectation("abort_removal");
    let (authority, _) = Authority::for_instance(&fixture.repository, &instance).unwrap();
    let compacted = read_state(&authority).unwrap().unwrap().state;
    assert_eq!(
        compacted
            .claims
            .values()
            .filter(|claim| !claim.is_active())
            .count(),
        expectation["afterReleasedClaims"].as_u64().unwrap() as usize
    );
    assert_eq!(compacted.permit().is_some(), expectation["permitRetained"]);
    assert_eq!(
        compacted.last_abort().is_some(),
        expectation["lastAbortRetained"]
    );
    let reacquired = apply_git_checkout_use(&claim_request(
        &fixture,
        &instance,
        "claim-after-capacity-compaction",
        "owner-after-capacity-compaction",
    ))
    .unwrap();
    assert_eq!(
        serialized_kind(&reacquired.outcome),
        expectation["nextOutcome"]
    );
    let reacquired_claim = claim_from(&reacquired);
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation("release-after-capacity-compaction"),
        action: GitCheckoutUseActionV1::Release {
            instance: instance.clone(),
            claim_id: reacquired_claim.claim_id,
        },
    })
    .unwrap();

    let terminal_permit_operation = maximum_operation_id('q', 0);
    let terminal_permit = permit_from(
        &apply_git_checkout_use(&permit_request(
            &fixture,
            &instance,
            terminal_permit_operation.as_str(),
            Vec::new(),
        ))
        .unwrap(),
    );
    let removed = remove_git_checkout_with_permit(&GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: maximum_operation_id('z', 0),
        instance: instance.clone(),
        permit_token: terminal_permit.permit_token,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    })
    .unwrap();
    assert_eq!(removed.phase, GitCheckoutUsePhaseV1::Removed);
    let terminal = read_state(&authority).unwrap().unwrap().state;
    assert!(encode_state(&terminal).unwrap().len() < MAX_RECORD_BYTES);
}
