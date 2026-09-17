use super::*;

#[tokio::test]
async fn unavailable_git_allows_registration_and_retains_the_directory_until_close() {
    let fixture = Fixture::new(false).await;
    let git_file = fixture.checkout.join(".git");
    let original = std::fs::read(&git_file).unwrap();
    std::fs::write(&git_file, "gitdir: missing-checkout-metadata\n").unwrap();
    let result = fixture.register("unavailable-git").await;
    std::fs::write(&git_file, original).unwrap();
    let registered = result.expect("optional Git metadata must not prevent Agent registration");
    assert!(registered.binding.registration.is_none());
    assert_eq!(fixture.removal("still-in-use"), Err("checkout_use_in_use"));
    fixture
        .runtime
        .close_agent_registration(registered.binding)
        .await
        .unwrap();
    assert_eq!(fixture.removal("after-close"), Ok(()));
    fixture.store.close().await;
}

#[tokio::test]
async fn unavailable_git_cannot_bypass_a_prior_removal_permit() {
    let fixture = Fixture::new(false).await;
    let permit = fixture.removal_operation("prior-removal").admit().unwrap();
    let git_file = fixture.checkout.join(".git");
    let original = std::fs::read(&git_file).unwrap();
    std::fs::write(&git_file, "gitdir: missing-checkout-metadata\n").unwrap();
    let result = fixture.register("unavailable-git").await;
    std::fs::write(&git_file, original).unwrap();
    assert!(
        matches!(result, Err(SessionCheckoutError::Checkout(error)) if error.code == "checkout_use_phase_conflict")
    );
    permit.abort().unwrap();
    // Replay uses the frozen directory selection, even though Git is back.
    let registered = fixture.register("unavailable-git").await.unwrap();
    assert!(registered.binding.registration.is_none());
    assert_eq!(fixture.removal("still-in-use"), Err("checkout_use_in_use"));
    fixture
        .runtime
        .close_agent_registration(registered.binding)
        .await
        .unwrap();
    assert_eq!(fixture.removal("after-close"), Ok(()));
    fixture.store.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn unreadable_git_metadata_does_not_prevent_registration_or_close() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new(false).await;
    let git_file = fixture.checkout.join(".git");
    let permissions = std::fs::metadata(&git_file).unwrap().permissions();
    std::fs::set_permissions(&git_file, std::fs::Permissions::from_mode(0o000)).unwrap();
    let result = fixture.register("unreadable-git").await;
    std::fs::set_permissions(&git_file, permissions).unwrap();
    let registered = result.unwrap();
    assert!(registered.binding.registration.is_none());
    assert_eq!(fixture.removal("still-in-use"), Err("checkout_use_in_use"));
    fixture
        .runtime
        .close_agent_registration(registered.binding)
        .await
        .unwrap();
    assert_eq!(fixture.removal("after-close"), Ok(()));
    fixture.store.close().await;
}

#[tokio::test]
async fn unreadable_common_directory_metadata_keeps_folder_registration_available() {
    let fixture = Fixture::new(false).await;
    let common = Path::new(&fixture.registration.instance.git_dir).join("commondir");
    let original = std::fs::read(&common).unwrap();
    std::fs::remove_file(&common).unwrap();
    std::fs::create_dir(&common).unwrap();
    let result = fixture.register("unreadable-common-directory").await;
    std::fs::remove_dir(&common).unwrap();
    std::fs::write(&common, original).unwrap();
    let registered = result.unwrap();
    assert!(registered.binding.registration.is_none());
    assert_eq!(
        fixture.removal("unreadable-common-in-use"),
        Err("checkout_use_in_use")
    );
    fixture
        .runtime
        .close_agent_registration(registered.binding)
        .await
        .unwrap();
    assert_eq!(fixture.removal("after-common-close"), Ok(()));
    fixture.store.close().await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn unavailable_git_can_launch_and_close_a_native_session() {
    let fixture = Fixture::new(true).await;
    let git_file = fixture.checkout.join(".git");
    let original = std::fs::read(&git_file).unwrap();
    std::fs::write(&git_file, "gitdir: missing-checkout-metadata\n").unwrap();
    let registered = fixture.register("unavailable-native-git").await.unwrap();
    let outcome = fixture
        .runtime
        .advance(fixture.request(&registered.root))
        .await;
    std::fs::write(&git_file, original).unwrap();
    let blocked = fixture.removal("native-still-in-use");
    fixture
        .runtime
        .close_agent_registration(registered.binding)
        .await
        .unwrap();
    assert!(matches!(
        outcome.unwrap(),
        ManagedCreateAdvanceResolution::Current(_)
    ));
    assert_eq!(blocked, Err("checkout_use_in_use"));
    assert_eq!(fixture.removal("after-native-close"), Ok(()));
    fixture.store.close().await;
}

#[tokio::test]
async fn a_missing_git_executable_allows_registration_and_runtime_free_recovery() {
    let fixture = Fixture::new(false).await;
    let root = fixture.checkout.parent().unwrap();
    let empty_bin = root.join("empty-bin");
    std::fs::create_dir(&empty_bin).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "agent_registration::tests::unavailable_git::missing_git_child",
            "--nocapture",
        ])
        .env("DURE_MISSING_GIT_FIXTURE", root)
        .env("PATH", empty_bin)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let registered: AgentCheckoutRegistrationV1 =
        serde_json::from_slice(&std::fs::read(root.join("registered.json")).unwrap()).unwrap();
    assert!(registered.binding.registration.is_none());
    assert_eq!(
        fixture.removal("after-registering-process-exit"),
        Err("checkout_use_in_use")
    );
    fixture
        .store
        .begin_agent_registration_close(&registered.binding)
        .await
        .unwrap();
    crate::reconcile_catalog_checkout_users(
        fixture.store.clone(),
        || panic!("unlaunched cleanup must not resolve a runtime executable"),
        hmux_client::LocalSessionCatalog::new(&fixture.runtime.discovery_root),
        fixture.registration.clone(),
    )
    .await
    .unwrap();
    assert_eq!(fixture.removal("after-recovery"), Ok(()));
    fixture.store.close().await;
}

#[tokio::test]
async fn missing_git_child() {
    let Some(root) = std::env::var_os("DURE_MISSING_GIT_FIXTURE") else {
        return;
    };
    let root = PathBuf::from(root);
    assert_eq!(
        Command::new("git")
            .arg("--version")
            .output()
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::NotFound
    );
    let store = SqliteDomainStore::open(root.join("state.sqlite3"))
        .await
        .unwrap();
    let registered = crate::register_agent_checkout(
        store.clone(),
        hmux_client::LocalSessionCatalog::new(root.join("discovery")),
        operation("missing-git"),
        AgentBootstrapV1 {
            agent_id: agent_id(),
            runtime_workspace_id: workspace_id(),
            provider_id: ProviderIdV1::new("local-shell").unwrap(),
            working_directory: root.join("checkout").to_str().unwrap().into(),
            display_name: "Agent".into(),
        },
    )
    .await
    .unwrap();
    std::fs::write(
        root.join("registered.json"),
        serde_json::to_vec(&registered).unwrap(),
    )
    .unwrap();
    store.close().await;
}
