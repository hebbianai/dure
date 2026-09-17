use super::*;
use crate::browser_engine::chromium::OwnedChromium;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

mod activation;

#[tokio::test]
async fn closing_an_unstarted_resource_retires_control_and_uploads_idempotently() {
    let root = tempfile::tempdir().unwrap();
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("browser:unstarted").unwrap(),
        generation: BrowserResourceGeneration::new("generation:1").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:1").unwrap(),
    };
    let runtime = BrowserRuntime::new(identity.clone(), root.path());
    let file =
        json!({"name":"pending.txt","size":4,"sha256":format!("{:x}",Sha256::digest(b"peer"))});
    let chunk = |offset, bytes: &[u8]| {
        serde_json::from_value(json!({"file":file,"offset":offset,"base64":STANDARD.encode(bytes)}))
            .unwrap()
    };
    runtime
        .request_control(
            BrowserControllerId::new("controller:unstarted").unwrap(),
            None,
        )
        .await
        .unwrap();
    runtime
        .uploads
        .lock()
        .await
        .stage(chunk(0, b"pe"))
        .await
        .unwrap();
    runtime.close(&identity).await.unwrap();
    let closed = runtime.control().await;
    let continuation = runtime.uploads.lock().await.stage(chunk(2, b"er")).await;
    runtime.close(&identity).await.unwrap();
    assert_eq!(closed.phase, BrowserResourcePhase::Closed);
    assert!(closed.controller.is_none());
    assert_eq!(continuation.unwrap_err(), "browser_upload_offset_invalid");
    assert_eq!(runtime.control().await, closed);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn retiring_one_profile_instance_preserves_peer_page_control_and_upload() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-instance-retirement-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("profiles:retirement").unwrap(),
        generation: BrowserResourceGeneration::new("generation:1").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:1").unwrap(),
    };
    let host = Arc::new(Mutex::new(BrowserResourceHost::new(identity.clone())));
    let uploads = Arc::new(Mutex::new(upload::BrowserUploads::new(&root)));
    let file =
        json!({"name":"프로필 첨부.txt","size":4,"sha256":format!("{:x}",Sha256::digest(b"peer"))});
    let chunk = |offset, bytes: &[u8]| {
        serde_json::from_value(json!({"file":file,"offset":offset,"base64":STANDARD.encode(bytes)}))
            .unwrap()
    };
    let mut browsers = Vec::new();
    let mut retirements = Vec::new();
    let evidence: Result<_, String> = async {
        for index in 0..2 {
            let profile = dure_app::BrowserProfileIdV1::new(format!("profile:{index}"))
                .map_err(|error| error.to_string())?;
            browsers.push(
                OwnedChromium::launch_profile(&config.chromium, &root, &profile)
                    .await
                    .map_err(|error| format!("{error:?}"))?,
            );
            let browser = &mut browsers[index];
            let target = browser.launch_page().await.map_err(|error| format!("{error:?}"))?;
            host.lock().await.reserve_page_target(
                &identity,
                browser.connection().instance().clone(),
                target,
            ).map_err(|error| format!("{error:?}"))?;
            let cdp = BrowserCdp::connect(browser.endpoint()).await?;
            let events = events::BrowserEventMonitor::start(
                Arc::clone(&host),
                browser.endpoint(),
                browser.connection().instance().clone(), Arc::new(tokio::sync::Notify::new())).await?;
            retirements.push(ResourceRetirement::new(&identity, &host, &events, &cdp, &uploads));
        }
        let pages = host.lock().await.pages();
        let lease = host.lock().await.request_control(
            BrowserControllerId::new("profile-controller").unwrap(), None,
        ).map_err(|error| format!("{error:?}"))?.controller.ok_or("controller missing")?;
        uploads.lock().await.stage(chunk(0, b"pe")).await?;
        retirements[0].begin().await.map_err(|error| format!("{error:?}"))?;
        browsers[0].close().await.map_err(|error| format!("{error:?}"))?;
        retirements[0].complete().await.map_err(|error| format!("{error:?}"))?;
        let after_first = host.lock().await.projection();
        let peer_pages = host.lock().await.pages();
        let staged = uploads.lock().await.stage(chunk(2, b"er")).await;
        let authority = BrowserActionAuthority {
            lease: lease.clone(),
            page: pages[1].clone(),
            command_sequence: after_first.next_command_sequence,
            operation_id: BrowserOperationId::new("peer:after-retirement").unwrap(),
        };
        let admitted = host.lock().await.begin_action(&lease.controller_id, &authority, None);
        let (admission_error, peer_value) = match admitted {
            Ok(permit) => {
                let target = host.lock().await.dispatch_target(&permit)
                    .map_err(|error| format!("{error:?}"))?.clone();
                let mut cdp = retirements[1].cdp.get().unwrap().clone();
                let session = cdp.attach(target.as_str()).await?;
                let value = cdp.request("Runtime.evaluate", json!({
                    "expression":"document.body.textContent='한글 다른 프로필';document.body.textContent",
                    "returnByValue":true,
                }), Some(&session)).await;
                host.lock().await.finish_action(permit, if value.is_ok() {
                    BrowserActionOutcome::Completed
                } else { BrowserActionOutcome::OutcomeUnknown })
                    .map_err(|error| format!("{error:?}"))?;
                (None, Some(value))
            }
            Err(error) => (Some(error), None),
        };
        Ok((pages, lease, after_first, peer_pages, staged, admission_error, peer_value))
    }.await;
    let mut cleanup = Vec::new();
    for (index, browser) in browsers.iter_mut().enumerate() {
        if let Some(retirement) = retirements.get(index) {
            cleanup.push(
                retirement
                    .begin()
                    .await
                    .map_err(|error| format!("{error:?}")),
            );
        }
        let retired = browser.close().await.map_err(|error| format!("{error:?}"));
        let confirmed = retired.is_ok();
        cleanup.push(retired);
        if confirmed && let Some(retirement) = retirements.get(index) {
            cleanup.push(
                retirement
                    .complete()
                    .await
                    .map_err(|error| format!("{error:?}")),
            );
        }
    }
    let final_control = host.lock().await.projection();
    let final_upload = uploads.lock().await.stage(chunk(2, b"er")).await;
    println!(
        "BROWSER_INSTANCE_RETIREMENT root={} evidence={evidence:?} cleanup={cleanup:?} final={final_control:?} upload={final_upload:?}",
        root.display()
    );
    assert!(cleanup.iter().all(Result::is_ok), "{cleanup:?}");
    let (pages, lease, after_first, peer_pages, staged, admission_error, peer_value) =
        evidence.unwrap();
    assert_eq!(after_first.phase, BrowserResourcePhase::Ready);
    assert_eq!(after_first.controller, Some(lease));
    assert_eq!(peer_pages, vec![pages[1].clone()]);
    assert_eq!(staged.unwrap()["complete"], true);
    assert_eq!(admission_error, None);
    assert_eq!(
        peer_value.unwrap().unwrap()["result"]["value"],
        "한글 다른 프로필"
    );
    assert_eq!(final_control.phase, BrowserResourcePhase::Closed);
    assert_eq!(final_upload.unwrap_err(), "browser_upload_offset_invalid");
}
