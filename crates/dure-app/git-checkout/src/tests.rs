use super::*;

#[path = "tests/clean_preflight_tests.rs"]
mod clean_preflight_tests;

#[cfg(unix)]
#[path = "tests/git_capture_tests.rs"]
mod git_capture_tests;

struct Fixture {
    _temporary: tempfile::TempDir,
    repository: PathBuf,
    linked: PathBuf,
}

fn git(repository: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    command.arg("-C").arg(repository).args(args);
    scrub_git_environment(&mut command);
    let output = command.output().unwrap();
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

fn authority_hash(repository: &Path, bytes: &[u8], write: bool) -> String {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository)
        .arg("-c")
        .arg(if cfg!(windows) {
            "core.hooksPath=NUL"
        } else {
            "core.hooksPath=/dev/null"
        })
        .arg("hash-object");
    if write {
        command.arg("-w");
    }
    command
        .arg("--stdin")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    scrub_git_environment(&mut command);
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "git hash-object failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end_matches(['\r', '\n'])
        .to_string()
}

fn authority_digest(repository: &Path, domain: &[u8], fields: &[&str]) -> String {
    let mut bytes = Vec::from(domain);
    bytes.push(0);
    for field in fields {
        bytes.extend_from_slice(field.as_bytes());
        bytes.push(0);
    }
    authority_hash(repository, &bytes, false)
}

fn install_active_checkout_claim(repository: &Path, instance: &GitCheckoutInstanceV1) -> String {
    let path_digest = authority_digest(
        repository,
        b"dure-checkout-use-path-v1",
        &[&instance.canonical_path],
    );
    let instance_digest = authority_digest(
        repository,
        b"dure-checkout-use-instance-v1",
        &[
            &instance.schema_version.to_string(),
            &instance.canonical_path,
            &instance.git_common_dir,
            &instance.git_dir,
            &instance.instance_token,
        ],
    );
    let request_digest = authority_digest(
        repository,
        b"dure-checkout-use-request-v1",
        &[
            "claim",
            &path_digest,
            &instance_digest,
            "owner-1",
            "claim-1",
        ],
    );
    let record = format!(
        concat!(
            "dure-checkout-use-v1\n",
            "revision 1\n",
            "phase active\n",
            "path {path_digest}\n",
            "instance {instance_digest}\n",
            "reservation - - - -\n",
            "creation-start - - - -\n",
            "activation - - -\n",
            "permit - - - -\n",
            "physical - - -\n",
            "last-abort - - - -\n",
            "terminal none - - -\n",
            "claims 1\n",
            "claim active owner-1 claim-1 {request_digest} 1 - - -\n"
        ),
        path_digest = path_digest,
        instance_digest = instance_digest,
        request_digest = request_digest,
    );
    let state_oid = authority_hash(repository, record.as_bytes(), true);
    let reference = format!("refs/dure/checkout-use/v1/{path_digest}");
    git(
        repository,
        &[
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
            "update-ref",
            "--no-deref",
            &reference,
            &state_oid,
        ],
    );
    reference
}

fn fixture() -> Fixture {
    let temporary = tempfile::tempdir().unwrap();
    let repository = temporary.path().join("repository");
    std::fs::create_dir(&repository).unwrap();
    git(&repository, &["init", "-b", "main"]);
    git(
        &repository,
        &["config", "user.name", "Worktree Identity Test"],
    );
    git(
        &repository,
        &["config", "user.email", "worktree-identity@example.invalid"],
    );
    git(&repository, &["config", "commit.gpgsign", "false"]);
    std::fs::write(repository.join("tracked.txt"), "base\n").unwrap();
    git(&repository, &["add", "tracked.txt"]);
    git(&repository, &["commit", "-m", "base"]);
    let linked = temporary.path().join("linked");
    git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            "agent/original",
            linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    Fixture {
        _temporary: temporary,
        repository,
        linked,
    }
}

fn remove_error(
    result: Result<GitCheckoutRemovalReceiptV1, GitCheckoutInstanceError>,
) -> GitCheckoutInstanceError {
    result.unwrap_err()
}

fn capture(
    repository: &Path,
    checkout: &Path,
) -> Result<GitCheckoutInstanceV1, GitCheckoutInstanceError> {
    capture_git_checkout_instance(&GitCheckoutCaptureRequestV1 {
        repository_path: repository.to_string_lossy().into_owned(),
        checkout_path: checkout.to_string_lossy().into_owned(),
    })
}

fn remove(
    repository: &Path,
    instance: &GitCheckoutInstanceV1,
) -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutInstanceError> {
    remove_git_checkout_instance(&GitCheckoutRemovalRequestV1 {
        repository_path: repository.to_string_lossy().into_owned(),
        instance: instance.clone(),
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    })
}

#[test]
fn typed_requests_use_one_strict_camel_case_contract() {
    let capture: GitCheckoutCaptureRequestV1 = serde_json::from_value(serde_json::json!({
        "repositoryPath": "/repository",
        "checkoutPath": "/repository/.worktrees/task"
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(&capture).unwrap(),
        serde_json::json!({
            "repositoryPath": "/repository",
            "checkoutPath": "/repository/.worktrees/task"
        })
    );
    assert!(
        serde_json::from_value::<GitCheckoutCaptureRequestV1>(serde_json::json!({
            "repositoryPath": "/repository",
            "checkoutPath": "/repository/.worktrees/task",
            "fallbackPath": "/replacement"
        }))
        .is_err()
    );
}

#[test]
fn capture_is_stable_versioned_and_private_to_the_linked_admin_dir() {
    let fixture = fixture();
    let first = capture(&fixture.repository, &fixture.linked).unwrap();
    let second = capture(&fixture.repository, &fixture.linked).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.schema_version, 1);
    assert!(valid_instance_token(&first.instance_token));
    assert_eq!(
        Path::new(&first.git_dir).parent(),
        Some(Path::new(&first.git_common_dir).join("worktrees").as_path())
    );
    assert_eq!(
        std::fs::read_to_string(Path::new(&first.git_dir).join(INSTANCE_TOKEN_FILE)).unwrap(),
        first.instance_token
    );
    assert!(
        std::fs::metadata(Path::new(&first.git_dir).join(INSTANCE_TOKEN_FILE))
            .unwrap()
            .is_file()
    );
    assert!(
        !Path::new(&first.git_common_dir)
            .join(INSTANCE_TOKEN_FILE)
            .exists()
    );
}

#[test]
fn a_prior_checkout_use_blocks_removal_before_the_checkout_is_touched() {
    let fixture = fixture();
    let captured = capture(&fixture.repository, &fixture.linked).unwrap();
    let _authority_ref = install_active_checkout_claim(&fixture.repository, &captured);

    let error = remove(&fixture.repository, &captured).unwrap_err();

    assert_eq!(error.code, "checkout_use_in_use");
    assert!(
        fixture.linked.exists(),
        "an exact active claim must block physical removal"
    );
}

#[test]
fn checkout_locations_distinguish_absent_paths_from_unresolved_locations() {
    let fixture = fixture();
    let missing = fixture._temporary.path().join("missing");
    let outside = fixture._temporary.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    let paths = vec![
        missing.to_string_lossy().into_owned(),
        outside.to_string_lossy().into_owned(),
        fixture.linked.to_string_lossy().into_owned(),
    ];
    let observed = serde_json::to_value(locate_checkouts(&paths).unwrap()).unwrap();
    assert_eq!(
        observed[0],
        serde_json::json!({"schemaVersion": 1, "absentPath": paths[0]})
    );
    assert_eq!(observed[1], serde_json::Value::Null);
    assert_eq!(
        observed[2]["canonicalPath"],
        fixture.linked.canonicalize().unwrap().to_str().unwrap()
    );
}

#[cfg(unix)]
#[test]
fn checkout_locations_do_not_mistake_a_symlink_loop_for_absence() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("loop");
    std::os::unix::fs::symlink("loop", &path).unwrap();
    let observed = locate_checkouts(&[path.to_string_lossy().into_owned()]).unwrap();
    assert_eq!(
        serde_json::to_value(observed).unwrap(),
        serde_json::json!([null])
    );
}

#[test]
fn checkout_locations_converge_nested_paths_and_preserve_unresolved_entries() {
    let fixture = fixture();
    let nested = fixture.linked.join("nested");
    std::fs::create_dir(&nested).unwrap();
    let missing = fixture._temporary.path().join("missing");
    let paths = [
        fixture.linked.to_string_lossy().into_owned(),
        nested.to_string_lossy().into_owned(),
        missing.to_string_lossy().into_owned(),
    ];

    let locations = paths
        .iter()
        .map(|path| locate_checkout(Path::new(path)).ok())
        .collect::<Vec<_>>();

    assert_eq!(locations[0], locations[1]);
    assert_eq!(locations[0].as_ref().unwrap().schema_version, 1);
    assert_eq!(locations[2], None);
}

#[cfg(windows)]
#[test]
fn windows_capture_uses_the_ordinary_wire_path_and_removes_exactly() {
    let fixture = fixture();
    let captured = capture_git_checkout_instance_at(&fixture.repository, &fixture.linked).unwrap();
    assert!(!captured.canonical_path.starts_with(r"\\?\"));
    assert_eq!(captured.canonical_path, fixture.linked.to_str().unwrap());

    assert_eq!(
        remove_git_checkout_instance_at(&fixture.repository, &captured)
            .unwrap()
            .outcome,
        GitCheckoutRemovalOutcomeV1::Removed
    );
    assert_eq!(
        remove_git_checkout_instance_at(&fixture.repository, &captured)
            .unwrap()
            .outcome,
        GitCheckoutRemovalOutcomeV1::AlreadyAbsent
    );
}

#[test]
fn capture_requires_the_exact_linked_root_in_the_same_repository() {
    let local = fixture();
    assert_eq!(
        capture_git_checkout_instance_at(&local.repository, &local.repository)
            .unwrap_err()
            .code,
        "worktree_not_linked"
    );
    let nested = local.linked.join("nested");
    std::fs::create_dir(&nested).unwrap();
    assert_eq!(
        capture_git_checkout_instance_at(&local.repository, &nested)
            .unwrap_err()
            .code,
        "worktree_path_not_exact"
    );

    let foreign = fixture();
    assert_eq!(
        capture_git_checkout_instance_at(&local.repository, &foreign.linked)
            .unwrap_err()
            .code,
        "worktree_foreign_repository"
    );
}

#[test]
fn capture_rejects_the_repository_checkout_through_a_canonical_alias() {
    let fixture = fixture();
    let repository_alias = fixture.linked.join(".");
    let git_dir = PathBuf::from(git(
        &fixture.linked,
        &["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
    ));

    let error = capture_git_checkout_instance_at(&repository_alias, &fixture.linked).unwrap_err();

    assert_eq!(error.code, "worktree_path_not_distinct");
    assert!(!git_dir.join(INSTANCE_TOKEN_FILE).exists());
}

#[test]
fn capture_rejects_a_repository_subdirectory_inside_the_target_checkout() {
    let fixture = fixture();
    let repository_subdirectory = fixture.linked.join("nested");
    std::fs::create_dir(&repository_subdirectory).unwrap();
    let git_dir = PathBuf::from(git(
        &fixture.linked,
        &["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
    ));

    let error =
        capture_git_checkout_instance_at(&repository_subdirectory, &fixture.linked).unwrap_err();

    assert_eq!(error.code, "worktree_path_not_distinct");
    assert!(!git_dir.join(INSTANCE_TOKEN_FILE).exists());
}

#[cfg(unix)]
#[test]
fn capture_and_remove_preserve_a_trailing_newline_in_the_checkout_path() {
    let fixture = fixture();
    let newline_path = PathBuf::from(format!("{}\n", fixture.linked.display()));
    git(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "--detach",
            newline_path.to_str().unwrap(),
            "HEAD",
        ],
    );
    let plain = capture_git_checkout_instance_at(&fixture.repository, &fixture.linked).unwrap();

    let captured = capture_git_checkout_instance_at(&fixture.repository, &newline_path).unwrap();

    assert_eq!(
        captured.canonical_path,
        std::fs::canonicalize(&newline_path)
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_ne!(captured.canonical_path, plain.canonical_path);
    assert_ne!(captured.instance_token, plain.instance_token);
    assert_eq!(
        remove_git_checkout_instance_at(&fixture.repository, &captured)
            .unwrap()
            .outcome,
        GitCheckoutRemovalOutcomeV1::Removed
    );
    assert!(!newline_path.exists());
    assert!(fixture.linked.exists());
    assert_eq!(
        capture_git_checkout_instance_at(&fixture.repository, &fixture.linked).unwrap(),
        plain
    );
}

#[test]
fn same_path_aba_with_a_missing_replacement_token_is_preserved() {
    let fixture = fixture();
    let original = capture_git_checkout_instance_at(&fixture.repository, &fixture.linked).unwrap();
    git(
        &fixture.repository,
        &["worktree", "remove", fixture.linked.to_str().unwrap()],
    );
    git(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "-b",
            "agent/replacement-missing",
            fixture.linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    assert!(
        !Path::new(&original.git_dir)
            .join(INSTANCE_TOKEN_FILE)
            .exists()
    );

    let error = remove_error(remove_git_checkout_instance_at(
        &fixture.repository,
        &original,
    ));
    assert_eq!(error.code, "worktree_token_unavailable");
    assert_eq!(
        error.removal_failure_disposition(),
        GitCheckoutRemovalFailureDisposition::Retryable
    );
    assert!(fixture.linked.join(".git").is_file());
    assert_eq!(
        git(&fixture.linked, &["branch", "--show-current"]),
        "agent/replacement-missing"
    );
}

#[test]
fn same_path_aba_with_a_different_replacement_token_is_preserved() {
    let fixture = fixture();
    let original = capture(&fixture.repository, &fixture.linked).unwrap();
    git(
        &fixture.repository,
        &["worktree", "remove", fixture.linked.to_str().unwrap()],
    );
    git(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "-b",
            "agent/replacement-token",
            fixture.linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    let replacement = capture(&fixture.repository, &fixture.linked).unwrap();
    assert_eq!(replacement.canonical_path, original.canonical_path);
    assert_eq!(replacement.git_common_dir, original.git_common_dir);
    assert_eq!(replacement.git_dir, original.git_dir);
    assert_ne!(replacement.instance_token, original.instance_token);

    let error = remove_error(remove(&fixture.repository, &original));
    assert_eq!(error.code, "worktree_identity_changed");
    assert_eq!(
        error.removal_failure_disposition(),
        GitCheckoutRemovalFailureDisposition::CheckoutReplaced
    );
    assert_eq!(
        git(&fixture.linked, &["branch", "--show-current"]),
        "agent/replacement-token"
    );
}

#[test]
fn same_path_replacement_with_a_different_git_directory_is_preserved() {
    let fixture = fixture();
    let original = capture(&fixture.repository, &fixture.linked).unwrap();
    git(
        &fixture.repository,
        &["worktree", "remove", fixture.linked.to_str().unwrap()],
    );
    let replacement_source = fixture._temporary.path().join("replacement-source");
    git(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "-b",
            "agent/replacement-directory",
            replacement_source.to_str().unwrap(),
            "HEAD",
        ],
    );
    git(
        &fixture.repository,
        &[
            "worktree",
            "move",
            replacement_source.to_str().unwrap(),
            fixture.linked.to_str().unwrap(),
        ],
    );
    let replacement = capture(&fixture.repository, &fixture.linked).unwrap();
    assert_ne!(replacement.git_dir, original.git_dir);

    let error = remove_error(remove(&fixture.repository, &original));
    assert_eq!(error.code, "worktree_identity_changed");
    assert_eq!(
        error.removal_failure_disposition(),
        GitCheckoutRemovalFailureDisposition::CheckoutReplaced
    );
    assert_eq!(
        git(&fixture.linked, &["branch", "--show-current"]),
        "agent/replacement-directory"
    );
}

#[test]
fn same_path_replacement_from_another_repository_is_terminally_classified() {
    let local = fixture();
    let original = capture(&local.repository, &local.linked).unwrap();
    git(
        &local.repository,
        &["worktree", "remove", local.linked.to_str().unwrap()],
    );
    let foreign = fixture();
    git(
        &foreign.repository,
        &[
            "worktree",
            "move",
            foreign.linked.to_str().unwrap(),
            local.linked.to_str().unwrap(),
        ],
    );

    let error = remove_error(remove(&local.repository, &original));
    assert_eq!(error.code, "worktree_identity_changed");
    assert_eq!(
        error.removal_failure_disposition(),
        GitCheckoutRemovalFailureDisposition::CheckoutReplaced
    );
    assert_eq!(
        git(&local.linked, &["branch", "--show-current"]),
        "agent/original"
    );
}

#[test]
fn a_non_linked_exact_target_is_terminally_classified() {
    let fixture = fixture();
    let original = capture(&fixture.repository, &fixture.linked).unwrap();
    let cause =
        observe_checkout(Path::new(&original.git_common_dir), &fixture.repository).unwrap_err();
    assert_eq!(cause.code, "worktree_not_linked");

    let error = exact_target_observation_error(cause);
    assert_eq!(error.code, "worktree_identity_changed");
    assert_eq!(
        error.removal_failure_disposition(),
        GitCheckoutRemovalFailureDisposition::CheckoutReplaced
    );
}

#[test]
fn branch_and_head_changes_do_not_invalidate_the_instance() {
    let fixture = fixture();
    let captured = capture_git_checkout_instance_at(&fixture.repository, &fixture.linked).unwrap();
    git(&fixture.linked, &["switch", "-c", "agent/advanced"]);
    git(
        &fixture.linked,
        &["commit", "--allow-empty", "-m", "advance HEAD"],
    );

    let receipt = remove_git_checkout_instance_at(&fixture.repository, &captured).unwrap();
    assert_eq!(receipt.schema_version, 1);
    assert_eq!(receipt.outcome, GitCheckoutRemovalOutcomeV1::Removed);
    assert_eq!(receipt.instance, captured);
    assert!(!fixture.linked.exists());
}

#[test]
fn a_moved_checkout_is_outside_the_captured_removal_scope_and_is_preserved() {
    let fixture = fixture();
    let captured = capture_git_checkout_instance_at(&fixture.repository, &fixture.linked).unwrap();
    let moved = fixture._temporary.path().join("moved");
    git(
        &fixture.repository,
        &[
            "worktree",
            "move",
            fixture.linked.to_str().unwrap(),
            moved.to_str().unwrap(),
        ],
    );

    let error = remove_error(remove_git_checkout_instance_at(
        &fixture.repository,
        &captured,
    ));
    assert_eq!(error.code, "worktree_path_unavailable");
    assert_eq!(
        error.removal_failure_disposition(),
        GitCheckoutRemovalFailureDisposition::Retryable
    );
    assert!(moved.join(".git").is_file());
    assert_eq!(git(&moved, &["branch", "--show-current"]), "agent/original");
}

#[test]
fn dirty_checkout_is_preserved_by_plain_remove() {
    let fixture = fixture();
    let captured = capture_git_checkout_instance_at(&fixture.repository, &fixture.linked).unwrap();
    std::fs::write(fixture.linked.join("uncommitted.txt"), "keep me\n").unwrap();

    let error = remove_error(remove_git_checkout_instance_at(
        &fixture.repository,
        &captured,
    ));
    assert_eq!(error.code, "worktree_remove_failed");
    assert_eq!(
        error.removal_failure_disposition(),
        GitCheckoutRemovalFailureDisposition::Retryable
    );
    assert_eq!(
        std::fs::read_to_string(fixture.linked.join("uncommitted.txt")).unwrap(),
        "keep me\n"
    );
    assert!(fixture.linked.join(".git").is_file());
}

#[test]
fn explicitly_confirmed_discard_removes_the_dirty_exact_checkout() {
    let fixture = fixture();
    let captured = capture(&fixture.repository, &fixture.linked).unwrap();
    std::fs::write(fixture.linked.join("uncommitted.txt"), "discard me\n").unwrap();
    let request: GitCheckoutRemovalRequestV1 = serde_json::from_value(serde_json::json!({
        "repositoryPath": fixture.repository,
        "instance": captured,
        "policy": "discard_changes"
    }))
    .unwrap();

    let receipt = remove_git_checkout_instance(&request).unwrap();

    assert_eq!(receipt.outcome, GitCheckoutRemovalOutcomeV1::Removed);
    assert!(!fixture.linked.exists());
}

#[test]
fn successful_remove_is_idempotently_already_absent() {
    let fixture = fixture();
    let captured = capture(&fixture.repository, &fixture.linked).unwrap();
    assert_eq!(
        remove(&fixture.repository, &captured).unwrap().outcome,
        GitCheckoutRemovalOutcomeV1::Removed
    );
    let retry = remove(&fixture.repository, &captured).unwrap();
    assert_eq!(retry.schema_version, 1);
    assert_eq!(retry.outcome, GitCheckoutRemovalOutcomeV1::AlreadyAbsent);
    assert_eq!(retry.instance, captured);
}

#[test]
fn repository_replacement_after_capture_is_retryable_observation_failure() {
    let fixture = fixture();
    let captured = capture_git_checkout_instance_at(&fixture.repository, &fixture.linked).unwrap();
    let moved_repository = fixture._temporary.path().join("moved-repository");
    std::fs::rename(&fixture.repository, &moved_repository).unwrap();
    std::fs::create_dir(&fixture.repository).unwrap();

    let error = remove_error(remove_git_checkout_instance_at(
        &fixture.repository,
        &captured,
    ));
    assert_eq!(error.code, "worktree_git_failed");
    assert_eq!(
        error.removal_failure_disposition(),
        GitCheckoutRemovalFailureDisposition::Retryable
    );
    assert!(fixture.linked.join(".git").is_file());
}

#[test]
fn malformed_expected_instances_are_request_errors() {
    let fixture = fixture();
    let captured = capture_git_checkout_instance_at(&fixture.repository, &fixture.linked).unwrap();
    let invalid = [
        GitCheckoutInstanceV1 {
            schema_version: 2,
            ..captured.clone()
        },
        GitCheckoutInstanceV1 {
            instance_token: "bad".to_string(),
            ..captured.clone()
        },
        GitCheckoutInstanceV1 {
            git_dir: captured.git_common_dir.clone(),
            ..captured.clone()
        },
    ];

    for instance in invalid {
        let error = remove_error(remove_git_checkout_instance_at(
            &fixture.repository,
            &instance,
        ));
        assert_eq!(error.code, "worktree_request_invalid");
        assert_eq!(
            error.removal_failure_disposition(),
            GitCheckoutRemovalFailureDisposition::Rejected
        );
        assert!(fixture.linked.join(".git").is_file());
    }

    let missing_repository = fixture._temporary.path().join("missing-repository");
    let malformed = GitCheckoutInstanceV1 {
        schema_version: 2,
        ..captured
    };
    let error = remove_error(remove_git_checkout_instance_at(
        &missing_repository,
        &malformed,
    ));
    assert_eq!(error.code, "worktree_request_invalid");
    assert_eq!(
        error.removal_failure_disposition(),
        GitCheckoutRemovalFailureDisposition::Rejected
    );
}
