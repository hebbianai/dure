use super::*;
use std::os::unix::fs::PermissionsExt;
use tokio::time::{Duration, timeout};

#[tokio::test]
async fn unactivated_admission_closes_or_cancels_without_starting_a_native_child() {
    for close_before_drop in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("unexpected-child");
        let executable = root.path().join("chromium-fixture");
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf spawned > '{}'\nexit 1\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = NativeBrowserEngineConfig {
            executable: executable.clone(),
            chromium: executable,
        };
        let identity = BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("browser:unactivated").unwrap(),
            generation: BrowserResourceGeneration::new("generation:1").unwrap(),
            workspace_id: BrowserWorkspaceId::new("workspace:1").unwrap(),
        };
        let runtime = BrowserRuntime::new(identity.clone(), root.path());
        let pending = runtime.admit_owned_binding(&config, None).await.unwrap();
        let closing = if close_before_drop {
            Some(timeout(Duration::from_secs(2), runtime.close(&identity)).await)
        } else {
            None
        };
        drop(pending);
        let cleanup = timeout(Duration::from_secs(2), runtime.close(&identity)).await;
        assert!(matches!(cleanup, Ok(Ok(()))), "{cleanup:?}");
        if let Some(closing) = closing {
            assert!(matches!(closing, Ok(Ok(()))), "{closing:?}");
        }
        assert!(!marker.exists(), "inactive admission launched Chromium");
        assert_eq!(runtime.control().await.phase, BrowserResourcePhase::Closed);
        assert!(runtime.bindings.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn unactivated_profile_retains_its_exact_owner_for_canceled_deletion_retry() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("unexpected-child");
    let executable = root.path().join("chromium-fixture");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nprintf spawned > '{}'\nexit 1\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = NativeBrowserEngineConfig {
        executable: executable.clone(),
        chromium: executable,
    };
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("browser:unactivated-profile").unwrap(),
        generation: BrowserResourceGeneration::new("generation:1").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:1").unwrap(),
    };
    let profile: dure_app::BrowserProfileSpecV1 = serde_json::from_value(json!({
        "profileId":"profile:retained", "label":"Retained", "scope":"isolated"
    }))
    .unwrap();
    let other = dure_app::BrowserProfileIdV1::new("profile:other").unwrap();
    let runtime = BrowserRuntime::new(identity.clone(), root.path());
    let pending = runtime
        .admit_owned_binding(&config, Some(&profile))
        .await
        .unwrap();
    let before = runtime.bindings.lock().unwrap().clone();
    assert_eq!(before.len(), 1);
    let (instance, owner) = before.iter().next().unwrap();

    // Cancel after admission fenced the owner, before polling native cleanup.
    let retirement = runtime
        .begin_profile_retirement(profile.profile_id())
        .await
        .unwrap();
    drop(retirement);
    drop(pending);
    let closed = timeout(Duration::from_secs(2), runtime.close(&identity)).await;
    assert!(matches!(closed, Ok(Ok(()))), "{closed:?}");
    assert_eq!(runtime.control().await.phase, BrowserResourcePhase::Closed);
    assert!(runtime.profile_source(profile.profile_id()).await.is_none());
    for _ in 0..2 {
        let matched = runtime
            .begin_profile_retirement(profile.profile_id())
            .await
            .unwrap();
        let matched = timeout(Duration::from_secs(2), matched).await;
        assert!(matches!(matched, Ok(Ok(true))), "{matched:?}");
        let unrelated = runtime.begin_profile_retirement(&other).await.unwrap();
        assert!(!unrelated.await.unwrap());
        let retained = runtime.bindings.lock().unwrap();
        assert_eq!(retained.len(), 1);
        assert!(Arc::ptr_eq(retained.get(instance).unwrap(), owner));
    }
    let final_close = timeout(Duration::from_secs(2), runtime.close(&identity)).await;
    assert!(matches!(final_close, Ok(Ok(()))), "{final_close:?}");
    assert!(!marker.exists(), "retirement retry launched Chromium");
}
