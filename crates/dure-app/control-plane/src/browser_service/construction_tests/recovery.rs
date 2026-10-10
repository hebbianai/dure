use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn recovery_reclaims_closed_failed_create_slots_before_reopening_profile() {
    let chromium = PathBuf::from(std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap());
    let fixture = Fixture::new(&chromium).await;
    let created = fixture.service.dispatch(&fixture.store, &json!({"kind":"profile_create","operation_id":"recovery:profile","label":"Recoverable"})).await.unwrap();
    let id = created["result"]["profile"]["profile"]["profileId"]
        .as_str()
        .unwrap();
    let native = fixture
        .service
        .root
        .address_for(fixture.service.root.durable())
        .unwrap()
        .join("browser-profiles");
    std::fs::create_dir(&native).unwrap();
    std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700)).unwrap();
    let root = native.join(format!("{:x}", Sha256::digest(id.as_bytes())));
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let claim = root.join("native-claim.json");
    std::fs::write(
        &claim,
        json!({"schemaVersion":1,"profileId":id,"instanceId":"legacy-owner"}).to_string(),
    )
    .unwrap();
    std::fs::set_permissions(&claim, std::fs::Permissions::from_mode(0o600)).unwrap();
    let evidence: Result<(), BackendDispatchError> = async {
        for index in 0..8 {
            let error = fixture.service.dispatch(&fixture.store, &json!({"kind":"create","operation_id":format!("recovery:blocked-{index}"),"profile_id":id})).await.unwrap_err();
            assert_eq!(error.code, "browser_profile_exit_unconfirmed");
        }
        assert_eq!(fixture.service.slots.available_permits(), 0);
        let error = fixture.service.dispatch(&fixture.store, &json!({"kind":"profile_recover","operation_id":"recovery:witness","profile_id":id})).await.unwrap_err();
        assert_eq!(error.code, "browser_profile_recovery_restart_required");
        // A fixture boot transition exercises legacy compatibility without
        // rebooting this test host. Native new-claim recovery has separate QA.
        let witness = root.join("native-recovery.json");
        let mut value: Value = serde_json::from_slice(&std::fs::read(&witness).unwrap()).unwrap();
        value["boot"] = "00000000-0000-0000-0000-000000000000".into();
        std::fs::write(&witness, value.to_string()).unwrap();
        fixture.service.dispatch(&fixture.store, &json!({"kind":"profile_recover","operation_id":"recovery:after-restart","profile_id":id})).await?;
        assert_eq!(fixture.service.slots.available_permits(), 8);
        let created = fixture.service.dispatch(&fixture.store, &json!({"kind":"create","operation_id":"recovery:reopen","profile_id":id})).await?;
        fixture.service.dispatch(&fixture.store, &json!({"kind":"close","operation_id":"recovery:close","resource":created["result"]["control"]["resource"]})).await?;
        Ok(())
    }.await;
    let cleanup = fixture.finish().await;
    assert!(evidence.is_ok(), "{evidence:?}");
    assert!(cleanup.is_ok(), "{cleanup:?}");
}
