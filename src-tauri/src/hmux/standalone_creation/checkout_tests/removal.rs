use super::*;
use dure_app::GitCheckoutRemovalOutcomeV1;
use dure_git_checkout::{claim_git_checkout_registration, release_git_checkout_registration};

impl Fixture {
    fn remove_checkout(
        &self,
        policy: GitCheckoutRemovalPolicyV1,
    ) -> Result<dure_app::GitCheckoutRemovalReceiptV1, dure_git_checkout::GitCheckoutInstanceError>
    {
        tauri::async_runtime::block_on(crate::git_checkout_instance::remove_git_checkout_instance(
            self.app.handle().clone(),
            self.registration.repository_path.clone(),
            self.registration.instance.clone(),
            policy,
        ))
    }
}

fn without_runtime_activation<T>(action: impl FnOnce() -> T) -> T {
    let install = environment_path("HMUX_INSTALL_ROOT");
    assert!(install.starts_with(environment_path("HOME")));
    let current = install.join("current");
    let held = install.join("current-held-by-removal-fixture");
    assert!(std::fs::symlink_metadata(&current)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(!held.exists());
    std::fs::rename(&current, &held).unwrap();
    let result = action();
    let reactivated = std::fs::symlink_metadata(&current).is_ok();
    if reactivated {
        assert!(std::fs::symlink_metadata(&current)
            .unwrap()
            .file_type()
            .is_symlink());
    }
    std::fs::rename(held, current).unwrap();
    assert!(
        !reactivated,
        "checkout removal must not activate a runtime without managed work"
    );
    result
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_tauri_removal_reconciles_an_exactly_retired_standalone() {
    let fixture = Fixture::new();
    let created = fixture.create().unwrap();
    fixture.abandon_and_wait_for_retirement(created.clone());
    assert_eq!(
        read_git_checkout_claims(&fixture.registration)
            .unwrap()
            .len(),
        1
    );

    // Call the actual desktop command, not the service reconciliation helper.
    let removed = without_runtime_activation(|| {
        fixture.remove_checkout(GitCheckoutRemovalPolicyV1::RequireClean)
    });
    let still_exists = fixture.checkout.exists();
    if removed.is_err() {
        // Preserve the original removal observation before exact fixture cleanup.
        fixture.close(&created);
    }
    assert!(
        removed.is_ok(),
        "desktop removal stranded a retired session claim: {removed:?}"
    );
    assert!(
        !still_exists,
        "successful removal must remove the actual fixture checkout"
    );
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_tauri_removal_preserves_live_sessions_under_both_policies() {
    let fixture = Fixture::new();
    let created = fixture.create().unwrap();
    let catalog = product_catalog().unwrap();
    let selector = SessionSelector::new(&created.session_id, Some(created.workspace_id.clone()));
    let before = catalog.find(&selector).unwrap();
    let refusals = without_runtime_activation(|| {
        [
            GitCheckoutRemovalPolicyV1::RequireClean,
            GitCheckoutRemovalPolicyV1::DiscardChanges,
        ]
        .map(|policy| fixture.remove_checkout(policy).map_err(|error| error.code))
    });
    let after = catalog.find(&selector).unwrap();
    let health = probe_local_session_exact(&catalog, &after);
    let claims = read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .len();
    let still_exists = fixture.checkout.exists();
    fixture.close(&created);
    assert!(refusals
        .iter()
        .all(|result| matches!(result, Err("checkout_use_in_use"))));
    assert!(before.same_generation(&after));
    assert_eq!(before.provider_process, after.provider_process);
    assert_eq!(
        (health, claims, still_exists),
        (SessionProbeStatus::Healthy, 1, true)
    );
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_tauri_live_managed_claim_needs_no_runtime_activation() {
    let fixture = Fixture::new();
    let created = fixture
        .manager
        .create_managed_shell(
            fixture.app.handle(),
            "live-managed-removal".into(),
            "live-managed-removal".into(),
            "local-workspace".into(),
            fixture.checkout.to_str().unwrap().into(),
            24,
            80,
            Default::default(),
            Default::default(),
        )
        .unwrap();
    let catalog = product_catalog().unwrap();
    let selector = SessionSelector::new(
        &created.session.session_id,
        Some(created.session.workspace_id.clone()),
    );
    let before = catalog.find(&selector).unwrap();
    let refused = without_runtime_activation(|| {
        fixture.remove_checkout(GitCheckoutRemovalPolicyV1::DiscardChanges)
    });
    let after = catalog.find(&selector).unwrap();
    let health = probe_local_session_exact(&catalog, &after);
    fixture
        .manager
        .stop_managed_create_chain_v2(
            fixture.app.handle(),
            &created.idempotency_key,
            &created.session.session_id,
            &created.session.workspace_id,
        )
        .unwrap();
    assert_eq!(refused.unwrap_err().code, "checkout_use_in_use");
    assert!(before.same_generation(&after));
    assert_eq!(health, SessionProbeStatus::Healthy);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_tauri_removal_preserves_foreign_claims_after_its_own_session_retires() {
    let fixture = Fixture::new();
    let created = fixture.create().unwrap();
    fixture.abandon_and_wait_for_retirement(created);
    let foreign = OperationIdV1::new("another-checkout-owner").unwrap();
    claim_git_checkout_registration(&fixture.checkout, &foreign, Some(&fixture.registration))
        .unwrap();
    let refused = without_runtime_activation(|| {
        fixture.remove_checkout(GitCheckoutRemovalPolicyV1::DiscardChanges)
    });
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    let still_exists = fixture.checkout.exists();
    // Release only this fixture's extra registration after observing refusal.
    release_git_checkout_registration(
        &fixture.registration,
        &foreign,
        &OperationIdV1::new("finish-foreign-owner-fixture").unwrap(),
    )
    .unwrap();
    assert_eq!(refused.unwrap_err().code, "checkout_use_in_use");
    assert!(still_exists);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].claim_id, foreign);
    assert_eq!(
        fixture
            .remove_checkout(GitCheckoutRemovalPolicyV1::RequireClean)
            .unwrap()
            .outcome,
        GitCheckoutRemovalOutcomeV1::Removed,
    );
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_tauri_empty_checkout_removal_needs_no_runtime_and_replays() {
    let fixture = Fixture::new();
    let (removed, replayed) = without_runtime_activation(|| {
        (
            fixture.remove_checkout(GitCheckoutRemovalPolicyV1::RequireClean),
            fixture.remove_checkout(GitCheckoutRemovalPolicyV1::RequireClean),
        )
    });
    assert_eq!(
        removed.unwrap().outcome,
        GitCheckoutRemovalOutcomeV1::Removed
    );
    assert_eq!(
        replayed.unwrap().outcome,
        GitCheckoutRemovalOutcomeV1::AlreadyAbsent
    );
    assert!(!fixture.checkout.exists());
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_tauri_removal_replies_through_the_actual_async_ipc_handler() {
    let fixture = Fixture::new();
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::git_checkout_instance::remove_git_checkout_instance
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "checkout-removal", Default::default())
        .build()
        .unwrap();
    let webview: &tauri::Webview<tauri::test::MockRuntime> = window.as_ref();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    // Exercise the generated command wrapper and AppHandle injection, with a
    // bounded observation if a panicked async command loses its response.
    webview.clone().on_message(
        tauri::webview::InvokeRequest {
            cmd: "remove_git_checkout_instance".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "repo": fixture.registration.repository_path,
                "instance": fixture.registration.instance,
                "policy": "require_clean",
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
        Box::new(move |_, _, response, _, _| {
            let _ = sender.send(response);
        }),
    );
    let response = receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("desktop removal must reply without a nested-runtime panic");
    let tauri::ipc::InvokeResponse::Ok(receipt) = response else {
        panic!("the actual IPC command refused an unused fixture checkout");
    };
    let receipt: serde_json::Value = receipt.deserialize().unwrap();
    assert_eq!(receipt["outcome"], "removed");
    assert!(!fixture.checkout.exists());
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_checkout_reconciliation_uses_only_configured_namespaces() {
    let fixture = Fixture::new();
    let created = fixture.create().unwrap();
    fixture.abandon_and_wait_for_retirement(created);
    let source = product_catalog().unwrap();
    let primary = environment_path("HOME").join("uninitialized-removal-primary");
    tauri::async_runtime::block_on(async {
        let store = dure_app_sqlite::SqliteDomainStore::open(
            environment_path("DURE_HOME").join("backend/application-state.sqlite3"),
        )
        .await
        .unwrap();
        for configured in [false, true] {
            let catalog = hmux_client::LocalSessionCatalog::with_read_only_discovery_roots(
                &primary,
                if configured {
                    vec![source.discovery_root().to_path_buf()]
                } else {
                    Vec::new()
                },
            )
            .unwrap();
            dure_session_runtime::reconcile_catalog_checkout_users(
                store.clone(),
                || panic!("standalone reconciliation must not resolve an executable"),
                catalog,
                fixture.registration.clone(),
            )
            .await
            .unwrap();
            assert_eq!(
                read_git_checkout_claims(&fixture.registration)
                    .unwrap()
                    .len(),
                usize::from(!configured),
            );
        }
        store.close().await;
    });
    assert!(
        !primary.exists(),
        "observation must not initialize the caller namespace"
    );
    fixture
        .remove_checkout(GitCheckoutRemovalPolicyV1::RequireClean)
        .unwrap();
}
