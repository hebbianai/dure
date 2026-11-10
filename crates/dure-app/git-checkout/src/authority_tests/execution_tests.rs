use super::*;

fn admit_git_checkout_creation(
    repository: &Path,
    target: &Path,
    owner: &OperationIdV1,
    inputs: &[&str],
) -> Result<Option<AdmittedGitCheckoutCreation>, GitCheckoutUseError> {
    prepare_git_checkout_creation(repository, target, owner, inputs)?
        .map(GitCheckoutCreationOperation::admit)
        .transpose()
}

fn reserve(fixture: &Fixture, target: &Path, owner: &str) -> GitCheckoutUseRequestV1 {
    GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: fixture.repository.to_string_lossy().into_owned(),
        operation_id: operation(owner),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: target.to_string_lossy().into_owned(),
            owner_id: operation(owner),
        },
    }
}

#[test]
fn rejected_preflight_never_publishes_a_creation_reservation() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("rejected-preflight");
    let owner = operation("preflight-owner");
    let request = reserve(&fixture, &target, owner.as_str());
    let authority = prepare_request(&request).unwrap().authority;
    let prepared = prepare_git_checkout_creation(&fixture.repository, &target, &owner, &["HEAD"])
        .unwrap()
        .unwrap();
    assert!(read_state(&authority).unwrap().is_none());
    drop(prepared);
    assert!(read_state(&authority).unwrap().is_none());
    admit_git_checkout_creation(
        &fixture.repository,
        &target,
        &operation("new-preflight"),
        &["HEAD"],
    )
    .unwrap()
    .unwrap()
    .abort_if_absent()
    .unwrap();
    assert!(!target.exists());
}

#[test]
fn a_failed_creator_cannot_abort_a_partial_or_registered_checkout() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("partial-execution");
    let owner = operation("partial-owner");
    let authority = prepare_request(&reserve(&fixture, &target, owner.as_str()))
        .unwrap()
        .authority;
    let creation = admit_git_checkout_creation(&fixture.repository, &target, &owner, &["HEAD"])
        .unwrap()
        .unwrap();
    let before = read_state(&authority).unwrap().unwrap().oid;
    fs::create_dir(&target).unwrap();
    fs::write(target.join("retained"), b"partial user data").unwrap();
    assert_eq!(
        creation.abort_if_absent().unwrap_err().code,
        "checkout_use_creation_reconcile_required"
    );
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    assert_eq!(
        fs::read(target.join("retained")).unwrap(),
        b"partial user data"
    );
    assert!(
        admit_git_checkout_creation(
            &fixture.repository,
            &target,
            &operation("partial-newcomer"),
            &["HEAD"]
        )
        .is_err()
    );

    let target = fixture._temporary.path().join("registered-execution");
    let owner = operation("registered-owner");
    let creation = admit_git_checkout_creation(&fixture.repository, &target, &owner, &["HEAD"])
        .unwrap()
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
    // Retain every file, but leave Git registration at the original location.
    let retained = target.with_extension("retained");
    fs::rename(&target, &retained).unwrap();
    assert!(!target.exists());
    assert_eq!(
        creation.abort_if_absent().unwrap_err().code,
        "checkout_use_creation_reconcile_required"
    );
    assert!(retained.is_dir());
}

#[test]
fn a_failed_creator_discards_only_a_checkout_git_left_initializing() {
    let fixture = fixture();
    let add_locked = |target: &Path, reason: &str| {
        let target = target.to_str().unwrap();
        git(
            &fixture.repository,
            &["worktree", "add", "--detach", target, "HEAD"],
        );
        git(
            &fixture.repository,
            &["worktree", "lock", "--reason", reason, target],
        );
    };

    let target = fixture._temporary.path().join("killed-execution");
    let creation = admit_git_checkout_creation(
        &fixture.repository,
        &target,
        &operation("killed-owner"),
        &["HEAD"],
    )
    .unwrap()
    .unwrap();
    add_locked(&target, "initializing");
    assert!(creation.abort_if_absent().unwrap());
    assert!(!target.exists());

    let target = fixture._temporary.path().join("operator-locked-execution");
    let creation = admit_git_checkout_creation(
        &fixture.repository,
        &target,
        &operation("operator-locked-owner"),
        &["HEAD"],
    )
    .unwrap()
    .unwrap();
    add_locked(&target, "held by an operator");
    assert_eq!(
        creation.abort_if_absent().unwrap_err().code,
        "checkout_use_creation_reconcile_required"
    );
    assert!(target.join(".git").exists());
}

#[test]
fn preflight_abort_retires_only_its_own_unstarted_reservation() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("interrupted-preflight");
    let owner = operation("interrupted-preflight-owner");
    let request = reserve(&fixture, &target, owner.as_str());
    apply_git_checkout_use(&request).unwrap();
    let authority = prepare_request(&request).unwrap().authority;
    let before = read_state(&authority).unwrap().unwrap().oid;
    prepare_git_checkout_creation(
        &fixture.repository,
        &target,
        &operation("other-preflight"),
        &["HEAD"],
    )
    .unwrap()
    .unwrap()
    .abort()
    .unwrap();
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    prepare_git_checkout_creation(&fixture.repository, &target, &owner, &["HEAD"])
        .unwrap()
        .unwrap()
        .abort()
        .unwrap();
    assert_eq!(
        read_state(&authority).unwrap().unwrap().state.phase(),
        Phase::Removed
    );
    assert!(admit_git_checkout_creation(&fixture.repository, &target, &owner, &["HEAD"]).is_err());
    admit_git_checkout_creation(
        &fixture.repository,
        &target,
        &operation("after-interrupted-preflight"),
        &["HEAD"],
    )
    .unwrap()
    .unwrap()
    .abort_if_absent()
    .unwrap();
    assert!(!target.exists());
}

#[test]
fn a_bound_creation_abort_is_terminal_for_its_owner_but_not_a_newcomer() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("failed-execution");
    let owner = operation("failed-owner");
    let creation = admit_git_checkout_creation(&fixture.repository, &target, &owner, &["HEAD"])
        .unwrap()
        .unwrap();
    creation.abort_if_absent().unwrap();
    assert_eq!(
        admit_git_checkout_creation(&fixture.repository, &target, &owner, &["HEAD"])
            .err()
            .unwrap()
            .code,
        "checkout_use_phase_conflict"
    );
    let newcomer = admit_git_checkout_creation(
        &fixture.repository,
        &target,
        &operation("new-after-failure"),
        &["HEAD"],
    )
    .unwrap()
    .unwrap();
    newcomer.abort_if_absent().unwrap();
}

#[test]
fn admitted_creation_recovers_without_a_second_claim_or_physical_checkout() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("executed-checkout");
    let owner = operation("execution-owner");
    let acquire = || admit_git_checkout_creation(&fixture.repository, &target, &owner, &["HEAD"]);
    let authority = prepare_request(&reserve(&fixture, &target, owner.as_str()))
        .unwrap()
        .authority;
    drop(acquire().unwrap().unwrap());
    let started = read_state(&authority).unwrap().unwrap();
    assert_eq!(started.state.phase(), Phase::Creating);
    assert_eq!(started.state.claims.len(), 1);
    assert!(!target.exists());
    let recovered = acquire().unwrap().unwrap();
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, started.oid);
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
    drop(recovered);
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, started.oid);
    acquire().unwrap().unwrap().activate().unwrap();
    let registration = claim_git_checkout_registration(&target, &owner, None)
        .unwrap()
        .unwrap();
    let activated = read_state(&authority).unwrap().unwrap();
    assert_eq!(activated.state.phase(), Phase::Active);
    assert_eq!(activated.state.claims.len(), 1);
    assert!(acquire().unwrap().is_none());
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, activated.oid);
    release_git_checkout_registration(&registration, &owner, &operation("release-execution"))
        .unwrap();
    assert!(claim_git_checkout_registration(&target, &owner, None).is_err());
}

#[test]
fn recovery_cannot_change_inputs_or_borrow_a_replacement_execution_inode() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("bound-execution");
    let owner = operation("bound-execution-owner");
    let acquire =
        |input: &str| admit_git_checkout_creation(&fixture.repository, &target, &owner, &[input]);
    drop(acquire("original").unwrap().unwrap());
    assert_eq!(
        acquire("different").err().unwrap().code,
        "checkout_use_creation_reconcile_required"
    );
    let original = acquire("original").unwrap().unwrap();
    let authority = prepare_request(&reserve(&fixture, &target, owner.as_str()))
        .unwrap()
        .authority;
    let before = read_state(&authority).unwrap().unwrap().oid;
    let path = authority
        .git_common_dir
        .join("dure-checkout-execution-v1")
        .join(&authority.path_digest);
    let retained = path.with_extension("retained");
    fs::rename(&path, &retained).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(
        acquire("original").err().unwrap().code,
        "checkout_use_creation_reconcile_required"
    );
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    let anchor = original.execution_anchor().unwrap();
    let mut command = hebbian_bounded_process::CommandSpec::new("git");
    command.args(["--version"]);
    assert_eq!(
        hebbian_bounded_process::run_unix_bound_command(
            &command,
            &[anchor],
            None,
            std::time::Duration::from_secs(2),
            1024
        )
        .unwrap_err(),
        hebbian_bounded_process::UnixBoundCommandFailure::DirectoryAnchorChanged
    );
    assert_eq!(
        original.abort_if_absent().unwrap_err().code,
        "checkout_use_creation_reconcile_required"
    );
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    assert!(!target.exists());
}

#[test]
fn a_free_execution_lease_does_not_authorize_an_unbound_historical_start() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("unbound-execution");
    let request = reserve(&fixture, &target, "unbound-owner");
    let GitCheckoutUseOutcomeV1::CreationReserved { reservation } =
        apply_git_checkout_use(&request).unwrap().outcome
    else {
        panic!("reservation missing");
    };
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        operation_id: operation("legacy-start"),
        action: GitCheckoutUseActionV1::StartCreation {
            canonical_path: reservation.canonical_path,
            reservation_token: reservation.reservation_token,
        },
        ..request.clone()
    })
    .unwrap();
    let authority = prepare_request(&request).unwrap().authority;
    let before = read_state(&authority).unwrap().unwrap().oid;
    assert_eq!(
        admit_git_checkout_creation(
            &fixture.repository,
            &target,
            &request.operation_id,
            &["HEAD"]
        )
        .err()
        .unwrap()
        .code,
        "checkout_use_creation_reconcile_required"
    );
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    assert_eq!(
        admit_git_checkout_creation(
            &fixture.repository,
            &target,
            &operation("unbound-newcomer"),
            &["HEAD"]
        )
        .err()
        .unwrap()
        .code,
        "checkout_use_phase_conflict"
    );
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    assert!(!target.exists());
}

#[test]
fn an_aborted_creator_cannot_use_its_historical_reservation_to_restart() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("aborted-execution");
    let request = reserve(&fixture, &target, "aborted-owner");
    let GitCheckoutUseOutcomeV1::CreationReserved { reservation } =
        apply_git_checkout_use(&request).unwrap().outcome
    else {
        panic!("reservation missing");
    };
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        operation_id: operation("abort-owner"),
        action: GitCheckoutUseActionV1::AbortCreation {
            canonical_path: reservation.canonical_path,
            reservation_token: reservation.reservation_token,
        },
        ..request.clone()
    })
    .unwrap();
    assert_eq!(
        admit_git_checkout_creation(
            &fixture.repository,
            &target,
            &request.operation_id,
            &["HEAD"]
        )
        .err()
        .unwrap()
        .code,
        "checkout_use_phase_conflict"
    );
    assert!(
        admit_git_checkout_creation(
            &fixture.repository,
            &target,
            &operation("new-owner"),
            &["HEAD"]
        )
        .unwrap()
        .is_some()
    );
    assert!(!target.exists());
}

fn abandon_started_creation(fixture: &Fixture, target: &Path, owner: &str) -> Authority {
    let owner_id = operation(owner);
    let authority = prepare_request(&reserve(fixture, target, owner))
        .unwrap()
        .authority;
    // Dropping the admitted creation is what a dead creator leaves behind: a
    // started reservation and a free execution lease, with no abort committed.
    drop(
        admit_git_checkout_creation(&fixture.repository, target, &owner_id, &["original"])
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        read_state(&authority).unwrap().unwrap().state.phase(),
        Phase::Creating
    );
    authority
}

fn prepare_newcomer(
    fixture: &Fixture,
    target: &Path,
    newcomer: &OperationIdV1,
) -> GitCheckoutCreationOperation {
    prepare_git_checkout_creation(&fixture.repository, target, newcomer, &["next"])
        .unwrap()
        .unwrap()
}

fn assert_reserved_by(authority: &Authority, owner: &OperationIdV1) {
    let state = read_state(authority).unwrap().unwrap().state;
    assert_eq!(state.phase(), Phase::Creating);
    assert_eq!(state.reservation().unwrap().operation_id, owner.as_str());
    assert_eq!(
        state.claims.keys().map(String::as_str).collect::<Vec<_>>(),
        [owner.as_str()]
    );
}

#[test]
fn a_free_lease_alone_never_displaces_another_operations_reservation() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("unvouched");
    let authority = abandon_started_creation(&fixture, &target, "unvouched-owner");
    let before = read_state(&authority).unwrap().unwrap().oid;
    assert_eq!(
        prepare_newcomer(&fixture, &target, &operation("unvouched-newcomer"))
            .admit()
            .err()
            .unwrap()
            .code,
        "checkout_use_phase_conflict"
    );
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
}

#[test]
fn a_vouched_owner_of_a_started_creation_yields_its_path() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("finished-started");
    let owner = operation("finished-started-owner");
    let authority = abandon_started_creation(&fixture, &target, owner.as_str());
    let newcomer = operation("finished-started-newcomer");
    let creation = prepare_newcomer(&fixture, &target, &newcomer);
    assert_eq!(creation.retirable_owner().unwrap(), Some(owner.clone()));
    assert!(creation.retire_finished_owner(&owner).unwrap());
    let admitted = creation.admit().unwrap();
    assert_reserved_by(&authority, &newcomer);
    assert!(!target.exists());
    admitted.abort_if_absent().unwrap();
}

#[test]
fn a_vouched_owner_of_an_unstarted_reservation_yields_its_path() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("finished-reserved");
    let owner = operation("finished-reserved-owner");
    let request = reserve(&fixture, &target, owner.as_str());
    apply_git_checkout_use(&request).unwrap();
    let authority = prepare_request(&request).unwrap().authority;
    let newcomer = operation("finished-reserved-newcomer");
    let creation = prepare_newcomer(&fixture, &target, &newcomer);
    assert_eq!(creation.retirable_owner().unwrap(), Some(owner.clone()));
    assert!(creation.retire_finished_owner(&owner).unwrap());
    let admitted = creation.admit().unwrap();
    assert_reserved_by(&authority, &newcomer);
    admitted.abort_if_absent().unwrap();
}

#[test]
fn retirement_names_the_exact_owner_and_never_the_callers_own_operation() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("exact-owner");
    let owner = operation("exact-owner-owner");
    let authority = abandon_started_creation(&fixture, &target, owner.as_str());
    let before = read_state(&authority).unwrap().unwrap().oid;
    let creation = prepare_newcomer(&fixture, &target, &operation("exact-owner-newcomer"));
    assert!(
        !creation
            .retire_finished_owner(&operation("exact-owner-someone-else"))
            .unwrap()
    );
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    drop(creation);
    let own = prepare_git_checkout_creation(&fixture.repository, &target, &owner, &["original"])
        .unwrap()
        .unwrap();
    assert_eq!(own.retirable_owner().unwrap(), None);
    assert!(!own.retire_finished_owner(&owner).unwrap());
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
}

#[test]
fn a_finished_owner_keeps_its_path_until_the_partial_directory_is_gone() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("finished-partial");
    let owner = operation("finished-partial-owner");
    let authority = abandon_started_creation(&fixture, &target, owner.as_str());
    let before = read_state(&authority).unwrap().unwrap().oid;
    fs::create_dir(&target).unwrap();
    fs::write(target.join("retained"), b"partial user data").unwrap();
    let newcomer = operation("finished-partial-newcomer");
    let creation = prepare_newcomer(&fixture, &target, &newcomer);
    assert!(!creation.retire_finished_owner(&owner).unwrap());
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    assert_eq!(
        fs::read(target.join("retained")).unwrap(),
        b"partial user data"
    );
    assert_eq!(
        creation.admit().err().unwrap().code,
        "checkout_use_phase_conflict"
    );

    fs::remove_dir_all(&target).unwrap();
    let creation = prepare_newcomer(&fixture, &target, &newcomer);
    assert!(creation.retire_finished_owner(&owner).unwrap());
    creation.admit().unwrap().abort_if_absent().unwrap();
}

#[test]
fn a_finished_owner_keeps_its_path_while_git_still_registers_it() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("finished-registered");
    let owner = operation("finished-registered-owner");
    let authority = abandon_started_creation(&fixture, &target, owner.as_str());
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
    let retained = target.with_extension("retained");
    fs::rename(&target, &retained).unwrap();
    let before = read_state(&authority).unwrap().unwrap().oid;
    let creation = prepare_newcomer(&fixture, &target, &operation("finished-registered-next"));
    assert!(!creation.retire_finished_owner(&owner).unwrap());
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    assert!(retained.is_dir());
}

#[test]
fn a_start_not_bound_to_the_lease_is_never_offered_for_retirement() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("finished-unbound");
    let owner = operation("finished-unbound-owner");
    let request = reserve(&fixture, &target, owner.as_str());
    let GitCheckoutUseOutcomeV1::CreationReserved { reservation } =
        apply_git_checkout_use(&request).unwrap().outcome
    else {
        panic!("reservation missing");
    };
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        operation_id: operation("finished-unbound-start"),
        action: GitCheckoutUseActionV1::StartCreation {
            canonical_path: reservation.canonical_path,
            reservation_token: reservation.reservation_token,
        },
        ..request.clone()
    })
    .unwrap();
    let authority = prepare_request(&request).unwrap().authority;
    let before = read_state(&authority).unwrap().unwrap().oid;
    let creation = prepare_newcomer(&fixture, &target, &operation("finished-unbound-next"));
    assert_eq!(creation.retirable_owner().unwrap(), None);
    assert!(!creation.retire_finished_owner(&owner).unwrap());
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
}

#[test]
fn a_running_creation_cannot_be_observed_for_retirement_until_it_ends() {
    let fixture = fixture();
    let target = fixture._temporary.path().join("running-creation");
    let owner = operation("running-creation-owner");
    let authority = prepare_request(&reserve(&fixture, &target, owner.as_str()))
        .unwrap()
        .authority;
    let original = admit_git_checkout_creation(&fixture.repository, &target, &owner, &["original"])
        .unwrap()
        .unwrap();
    let before = read_state(&authority).unwrap().unwrap().oid;
    let (finished, completion) = std::sync::mpsc::channel();
    let newcomer = {
        let repository = fixture.repository.clone();
        let target = target.clone();
        std::thread::spawn(move || {
            let observed = prepare_git_checkout_creation(
                &repository,
                &target,
                &operation("running-creation-newcomer"),
                &["next"],
            )
            .and_then(|creation| creation.unwrap().retirable_owner());
            finished.send(()).unwrap();
            observed
        })
    };
    let early = completion.recv_timeout(std::time::Duration::from_millis(200));
    assert_eq!(read_state(&authority).unwrap().unwrap().oid, before);
    drop(original);
    let observed = newcomer.join().unwrap();
    assert_eq!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout));
    assert_eq!(observed.unwrap(), Some(owner));
}
