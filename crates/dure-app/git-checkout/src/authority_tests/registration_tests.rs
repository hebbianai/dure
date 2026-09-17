use super::*;
use crate::GitCheckoutRegistrationV1;

#[test]
fn registration_claim_reads_are_exact_active_and_do_not_write_git() {
    let fixture = fixture();
    let registration = capture_git_checkout_registration(&fixture.linked)
        .unwrap()
        .unwrap();
    let (authority, _) =
        Authority::for_instance(&fixture.repository, &registration.instance).unwrap();
    assert!(read_git_checkout_claims(&registration).unwrap().is_empty());
    assert!(read_state(&authority).unwrap().is_none());
    let owner = operation("observed-registration");
    claim_git_checkout_registration(&fixture.linked, &owner, Some(&registration)).unwrap();
    let before = read_state(&authority).unwrap().unwrap().oid;
    let claims = read_git_checkout_claims(&registration).unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].claim_id, owner);
    assert_eq!(claims[0].owner_id, owner);
    let mut different = registration.clone();
    different.instance.instance_token = format!("dwt1_{}", "0".repeat(32));
    assert_ne!(
        different.instance.instance_token,
        registration.instance.instance_token
    );
    assert!(read_git_checkout_claims(&different).unwrap().is_empty());
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    release_git_checkout_registration(&registration, &owner, &operation("release-observed"))
        .unwrap();
    let released = read_state(&authority).unwrap().unwrap().oid;
    assert!(read_git_checkout_claims(&registration).unwrap().is_empty());
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, released);
}

#[test]
fn capture_freezes_a_nested_checkout_without_creating_a_membership_claim() {
    let fixture = fixture();
    let nested = fixture.linked.join("nested");
    fs::create_dir(&nested).unwrap();
    let nested = nested.canonicalize().unwrap();
    let registration = capture_git_checkout_registration(&nested).unwrap().unwrap();
    let (authority, _) =
        Authority::for_instance(&fixture.repository, &registration.instance).unwrap();
    assert!(read_state(&authority).unwrap().is_none());
    let registration_id = operation("captured-registration");
    assert_eq!(
        claim_git_checkout_registration(&nested, &registration_id, Some(&registration)).unwrap(),
        Some(registration.clone()),
    );
    let claimed = read_state(&authority).unwrap().unwrap();
    assert_eq!(claimed.state.claims.len(), 1);
    assert!(claimed.state.claims[registration_id.as_str()].is_active());
    assert_eq!(
        capture_git_checkout_registration(&nested).unwrap(),
        Some(registration)
    );
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, claimed.oid);
}

#[test]
fn capture_preserves_non_linked_directories_without_masking_broken_git_metadata() {
    let fixture = fixture();
    assert_eq!(
        capture_git_checkout_registration(&fixture.repository).unwrap(),
        None
    );
    let directory = fixture._temporary.path().join("plain");
    fs::create_dir(&directory).unwrap();
    assert_eq!(capture_git_checkout_registration(&directory).unwrap(), None);
    fs::write(directory.join(".git"), "gitdir: missing-administration").unwrap();
    assert!(capture_git_checkout_registration(&directory).is_err());
}

#[test]
fn primary_root_registration_does_not_require_git_repository_format_support() {
    let fixture = fixture();
    let nested = fixture.repository.join("nested");
    fs::create_dir(&nested).unwrap();
    git(
        &fixture.repository,
        &["config", "core.repositoryformatversion", "1"],
    );
    git(
        &fixture.repository,
        &[
            "config",
            "extensions.dureUnsupportedRegistrationFixture",
            "true",
        ],
    );
    let config = fs::read(fixture.repository.join(".git/config")).unwrap();
    let output = git_result(&fixture.repository, &["rev-parse", "--show-toplevel"]);
    assert!(
        !output.status.success(),
        "the installed Git must reject this fixture format"
    );
    for directory in [&fixture.repository, &nested] {
        assert_eq!(capture_git_checkout_registration(directory).unwrap(), None);
        assert_eq!(
            claim_git_checkout_registration(directory, &operation("ordinary-folder"), None)
                .unwrap(),
            None,
        );
    }
    assert_eq!(
        fs::read(fixture.repository.join(".git/config")).unwrap(),
        config
    );
    // A linked checkout still needs its exact Git membership; the root shortcut
    // must not turn an unresolved linked user into an unprotected directory.
    assert_eq!(
        capture_git_checkout_registration(&fixture.linked)
            .unwrap_err()
            .code,
        "worktree_git_failed",
    );
}

#[test]
fn git_directory_with_commondir_still_requires_linked_checkout_observation() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join(".git")).unwrap();
    fs::write(
        directory.path().join(".git/commondir"),
        "../missing-common\n",
    )
    .unwrap();
    assert!(capture_git_checkout_registration(directory.path()).is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_git_directory_does_not_gain_primary_root_shortcut() {
    let directory = tempfile::tempdir().unwrap();
    let administration = directory.path().join("administration");
    fs::create_dir(&administration).unwrap();
    std::os::unix::fs::symlink(&administration, directory.path().join(".git")).unwrap();
    assert!(capture_git_checkout_registration(directory.path()).is_err());
}

fn creation_ready_to_activate(
    owner: &str,
) -> (
    Fixture,
    GitCheckoutRegistrationV1,
    OperationIdV1,
    GitCheckoutUseRequestV1,
) {
    let fixture = fixture();
    let target = fixture._temporary.path().join("created-registration");
    let registration_id = operation("created-registration");
    let request = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: registration_id.clone(),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: target.to_string_lossy().into_owned(),
            owner_id: operation(owner),
        },
    };
    let reserved = apply_git_checkout_use(&request).unwrap();
    let GitCheckoutUseOutcomeV1::CreationReserved { reservation } = reserved.outcome else {
        panic!("creation was not reserved");
    };
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        operation_id: operation("start-created-registration"),
        action: GitCheckoutUseActionV1::StartCreation {
            canonical_path: reservation.canonical_path.clone(),
            reservation_token: reservation.reservation_token.clone(),
        },
        ..request.clone()
    })
    .unwrap();
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
    let registration = GitCheckoutRegistrationV1 {
        repository_path: request.repository_path.clone(),
        instance: capture_git_checkout_instance_at(&fixture.repository, &target).unwrap(),
    };
    let activation = GitCheckoutUseRequestV1 {
        operation_id: operation("activate-created-registration"),
        action: GitCheckoutUseActionV1::ActivateCreation {
            instance: registration.instance.clone(),
            reservation_token: reservation.reservation_token,
        },
        ..request
    };
    (fixture, registration, registration_id, activation)
}

fn created_registration(owner: &str) -> (Fixture, GitCheckoutRegistrationV1, OperationIdV1) {
    let (fixture, registration, registration_id, activation) = creation_ready_to_activate(owner);
    apply_git_checkout_use(&activation).unwrap();
    (fixture, registration, registration_id)
}

#[test]
fn registration_does_not_activate_a_started_creator() {
    let (fixture, registration, registration_id, activation) =
        creation_ready_to_activate("created-registration");
    let target = Path::new(&registration.instance.canonical_path);
    let (authority, _) =
        Authority::for_instance(&fixture.repository, &registration.instance).unwrap();
    let before = read_state(&authority).unwrap().unwrap().oid;
    for expected in [Some(&registration), None] {
        assert_eq!(
            claim_git_checkout_registration(target, &registration_id, expected)
                .unwrap_err()
                .code,
            "checkout_use_operation_conflict"
        );
    }
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    apply_git_checkout_use(&activation).unwrap();
    assert_eq!(
        claim_git_checkout_registration(target, &registration_id, Some(&registration)),
        Ok(Some(registration.clone()))
    );
}

#[test]
fn completed_creation_reuses_its_registration_without_a_second_claim() {
    let (fixture, registration, registration_id) = created_registration("created-registration");
    let target = Path::new(&registration.instance.canonical_path);
    let (authority, _) =
        Authority::for_instance(&fixture.repository, &registration.instance).unwrap();
    let before = read_state(&authority).unwrap().unwrap();
    for expected in [Some(&registration), None] {
        assert_eq!(
            claim_git_checkout_registration(target, &registration_id, expected),
            Ok(Some(registration.clone())),
            "registration must resolve the claim already retained by creation activation"
        );
    }
    let after = read_state(&authority).unwrap().unwrap();
    assert_eq!(
        after.oid, before.oid,
        "recovery must not mint another claim"
    );
    assert_eq!(after.state.claims.len(), 1);
    assert_eq!(
        apply_git_checkout_use(&claim_request(
            &fixture,
            &registration.instance,
            registration_id.as_str(),
            registration_id.as_str(),
        ))
        .unwrap_err()
        .code,
        "checkout_use_operation_conflict",
        "a different low-level operation payload must still conflict"
    );

    let newcomer = operation("same-workspace-new-registration");
    claim_git_checkout_registration(target, &newcomer, Some(&registration)).unwrap();
    assert_eq!(
        read_state(&authority).unwrap().unwrap().state.claims.len(),
        2
    );
    release_git_checkout_registration(
        &registration,
        &registration_id,
        &operation("release-creator"),
    )
    .unwrap();
    assert_eq!(
        claim_git_checkout_registration(target, &registration_id, Some(&registration))
            .unwrap_err()
            .code,
        "checkout_use_phase_conflict"
    );
    assert_eq!(
        claim_git_checkout_registration(target, &newcomer, Some(&registration)),
        Ok(Some(registration.clone()))
    );
    assert_eq!(
        apply_git_checkout_use(&permit_request(
            &fixture,
            &registration.instance,
            "remove-after-creator-release",
            Vec::new(),
        ))
        .unwrap_err()
        .code,
        "checkout_use_in_use"
    );
}

#[test]
fn creation_registration_cannot_borrow_another_owners_activation() {
    let (fixture, registration, registration_id) = created_registration("different-owner");
    let (authority, _) =
        Authority::for_instance(&fixture.repository, &registration.instance).unwrap();
    let before = read_state(&authority).unwrap().unwrap().oid;
    assert_eq!(
        claim_git_checkout_registration(
            Path::new(&registration.instance.canonical_path),
            &registration_id,
            Some(&registration),
        )
        .unwrap_err()
        .code,
        "checkout_use_operation_conflict"
    );
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
}

#[test]
fn creation_registration_recovery_observes_removal_and_exact_path() {
    let (fixture, registration, registration_id) = created_registration("created-registration");
    let target = Path::new(&registration.instance.canonical_path);
    let moved = fixture
        ._temporary
        .path()
        .join("temporarily-moved-created-checkout");
    fs::rename(target, &moved).unwrap();
    let missing = claim_git_checkout_registration(target, &registration_id, Some(&registration));
    fs::rename(&moved, target).unwrap();

    let permit = apply_git_checkout_use(&permit_request(
        &fixture,
        &registration.instance,
        "retire-created-registration",
        vec![registration_id.clone()],
    ))
    .unwrap();
    let removing = claim_git_checkout_registration(target, &registration_id, Some(&registration));
    let permit = permit_from(&permit);
    remove_git_checkout_with_permit(&GitCheckoutUsePhysicalRemovalRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: registration.repository_path.clone(),
        operation_id: operation("physically-remove-created-registration"),
        instance: registration.instance.clone(),
        permit_token: permit.permit_token,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    })
    .unwrap();
    let removed = claim_git_checkout_registration(target, &registration_id, Some(&registration));
    assert!(!target.exists());
    assert_eq!(
        [missing, removing, removed].map(|result| result.unwrap_err().code),
        [
            "worktree_identity_changed",
            "checkout_use_phase_conflict",
            "checkout_use_phase_conflict",
        ]
    );
}

#[cfg(unix)]
#[test]
fn registration_canonicalizes_directory_aliases_before_comparing_membership() {
    let fixture = fixture();
    let alias = fixture._temporary.path().join("checkout-alias");
    std::os::unix::fs::symlink(&fixture.linked, &alias).unwrap();
    let expected = capture_git_checkout_registration(&fixture.linked)
        .unwrap()
        .unwrap();
    assert_eq!(
        capture_git_checkout_registration(&alias).unwrap(),
        Some(expected.clone())
    );
    let owner = operation("aliased-registration");
    assert_eq!(
        claim_git_checkout_registration(&alias, &owner, Some(&expected)).unwrap(),
        Some(expected.clone())
    );
    assert_eq!(read_git_checkout_claims(&expected).unwrap().len(), 1);
    release_git_checkout_registration(&expected, &owner, &operation("release-alias")).unwrap();
}
