use super::*;

#[test]
fn path_claim_survives_reopen_and_rejects_a_different_directory() {
    let fixture = tempfile::tempdir().unwrap();
    let cwd = fixture.path().join("cwd");
    fs::create_dir(&cwd).unwrap();
    let root = fixture.path().join("authority");
    let id = OperationIdV1::new("retained").unwrap();
    DirectoryUseGuard::at(root.clone())
        .unwrap()
        .claim(&cwd, &id)
        .unwrap();
    let mut reopened = DirectoryUseGuard::at(root).unwrap();
    assert_eq!(
        reopened.state.claims["retained"],
        dunce::canonicalize(&cwd).unwrap()
    );
    reopened.claim(&cwd, &id).unwrap();
    assert!(reopened.claim(fixture.path(), &id).is_err());
}

fn instance(path: &Path) -> GitCheckoutInstanceV1 {
    let canonical = dunce::canonicalize(path).unwrap();
    let common = canonical.parent().unwrap().join("repository/.git");
    GitCheckoutInstanceV1 {
        schema_version: 1,
        canonical_path: canonical.to_str().unwrap().into(),
        git_common_dir: common.to_str().unwrap().into(),
        git_dir: common.join("worktrees/unused").to_str().unwrap().into(),
        instance_token: format!("dwt1_{}", "0".repeat(32)),
    }
}

#[test]
fn nested_directory_claim_protects_only_its_checkout_and_survives_reopen() {
    let fixture = tempfile::tempdir().unwrap();
    let nested = fixture.path().join("checkout/nested");
    let neighbor = fixture.path().join("checkout-neighbor");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir(&neighbor).unwrap();
    let root = fixture.path().join("authority");
    DirectoryUseGuard::at(root.clone())
        .unwrap()
        .claim(&nested, &OperationIdV1::new("nested").unwrap())
        .unwrap();
    let mut guard = DirectoryUseGuard::at(root).unwrap();
    assert_eq!(
        guard
            .begin_removal(&instance(nested.parent().unwrap()))
            .unwrap_err()
            .code,
        "checkout_use_in_use"
    );
    guard.begin_removal(&instance(&neighbor)).unwrap();
}

#[test]
fn persisted_removal_excludes_new_claims_until_exact_abort() {
    let fixture = tempfile::tempdir().unwrap();
    let checkout = fixture.path().join("checkout");
    fs::create_dir(&checkout).unwrap();
    let instance = instance(&checkout);
    let root = fixture.path().join("authority");
    DirectoryUseGuard::at(root.clone())
        .unwrap()
        .begin_removal(&instance)
        .unwrap();
    let mut recovered = DirectoryUseGuard::at(root).unwrap();
    let owner = OperationIdV1::new("after-interruption").unwrap();
    assert_eq!(
        recovered.claim(&checkout, &owner).unwrap_err().code,
        "checkout_use_phase_conflict"
    );
    let mut foreign = instance.clone();
    foreign.instance_token = format!("dwt1_{}", "1".repeat(32));
    assert!(recovered.begin_removal(&foreign).is_err());
    recovered.finish_removal(&foreign).unwrap();
    assert!(recovered.claim(&checkout, &owner).is_err());
    recovered.finish_removal(&instance).unwrap();
    recovered.claim(&checkout, &owner).unwrap();
}

#[test]
fn concurrent_directory_admission_and_removal_have_one_winner() {
    let fixture = tempfile::tempdir().unwrap();
    let checkout = fixture.path().join("checkout");
    fs::create_dir(&checkout).unwrap();
    let instance = instance(&checkout);
    let root = fixture.path().join("authority");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let claim_root = root.clone();
    let claim_barrier = barrier.clone();
    let claimant = std::thread::spawn(move || {
        claim_barrier.wait();
        DirectoryUseGuard::at(claim_root)
            .unwrap()
            .claim(&checkout, &OperationIdV1::new("racing").unwrap())
    });
    barrier.wait();
    let removal = DirectoryUseGuard::at(root)
        .unwrap()
        .begin_removal(&instance);
    assert_ne!(claimant.join().unwrap().is_ok(), removal.is_ok());
}

#[test]
fn corrupt_durable_state_and_invalid_directories_fail_closed() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("authority");
    let mut guard = DirectoryUseGuard::at(root.clone()).unwrap();
    let owner = OperationIdV1::new("invalid").unwrap();
    assert!(
        guard
            .claim(&fixture.path().join("missing"), &owner)
            .is_err()
    );
    assert!(guard.claim(Path::new("relative"), &owner).is_err());
    drop(guard);
    fs::write(root.join("state.json"), b"{broken").unwrap();
    assert!(DirectoryUseGuard::at(root.clone()).is_err());
    fs::write(
        root.join("state.json"),
        br#"{"claims":{"owner":"relative"},"removing":{}}"#,
    )
    .unwrap();
    assert!(DirectoryUseGuard::at(root).is_err());
}
