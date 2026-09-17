use super::*;
use crate::browser_engine::runtime::ImageCapture;
use base64::{Engine, engine::general_purpose::STANDARD};
use dure_app::BrowserProfileIdV1;
use sha2::{Digest, Sha256};

mod construction;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn another_instances_dialog_loss_wakes_a_suspended_resource_wait() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-resource-profile-clock-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profiles:shared-clock");
    let profile_a = BrowserProfileIdV1::new("clock:a").unwrap();
    let profile_b = BrowserProfileIdV1::new("clock:b").unwrap();
    let runtime =
        BrowserRuntime::launch_profile(resource.clone(), &config, &root, &profile_spec(&profile_a))
            .await
            .unwrap();
    let mut handlers = Vec::new();
    let evidence = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        runtime.launch_binding(&config, Some(&profile_spec(&profile_b))).await?;
        let pages = runtime.observe().await?.pages;
        for page in &pages {
            let execution = runtime.execution(&page.page).await?;
            let target = runtime.host.lock().await.target_for(&page.page)?.clone();
            let connection = execution.binding.instance.connection().await;
            let mut handler = BrowserCdp::connect(connection.endpoint()).await?;
            let session = handler.attach(target.as_str()).await?;
            handler.request("Page.enable", json!({}), Some(&session)).await?;
            handlers.push((handler, session));
        }
        for (page, (handler, session)) in pages.iter().zip(handlers.iter_mut()) {
            // Trigger real dialogs through fixture-owned connections so setup
            // does not wait for an admitted action's post-effect renderer read.
            // These handlers also keep the native dialogs alive on observer loss.
            let trigger = handler.request("Runtime.evaluate", json!({"expression":"alert('profile clock')"}), Some(session));
            tokio::pin!(trigger);
            tokio::select! {
                result = trigger.as_mut() => {
                    result?;
                    return Err::<_, BrowserRuntimeError>("profile dialog did not suspend evaluation".into());
                },
                pending = async {
                    loop {
                        if runtime.dialog(&page.page.page_id).await?.dialog.is_some() {
                            return Ok::<_, BrowserRuntimeError>(());
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                } => { pending?; },
            }
        }
        println!("BROWSER_RESOURCE_PROFILE_CLOCK dialogs_observed");
        let request =
            serde_json::from_value(json!({"condition":{"kind":"text","text":"unreachable until the dialog closes"},"timeout_ms":1000}))
                .unwrap();
        let wait = runtime.wait(&pages[1].page, &request);
        tokio::pin!(wait);
        let suspended = tokio::time::timeout(std::time::Duration::from_secs(1), wait.as_mut())
            .await
            .is_err();
        runtime
            .execution(&pages[0].page)
            .await?
            .binding
            .events
            .close()
            .await;
        let after_loss = runtime.control().await;
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), wait.as_mut()).await;
        let peer_dialog = runtime.dialog(&pages[1].page.page_id).await?;
        Ok((suspended, after_loss, result, peer_dialog))
    })
    .await;
    let mut cleanup = Vec::new();
    for (mut handler, session) in handlers {
        cleanup.push(
            handler
                .request(
                    "Page.handleJavaScriptDialog",
                    json!({"accept":false}),
                    Some(&session),
                )
                .await,
        );
        handler.retire().await;
    }
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_RESOURCE_PROFILE_CLOCK root={} evidence={evidence:?} closed={closed:?} cleanup={cleanup:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(cleanup.iter().all(Result::is_ok), "{cleanup:?}");
    let (suspended, after_loss, result, peer_dialog) = evidence.unwrap().unwrap();
    assert!(suspended);
    assert_eq!(after_loss.phase, BrowserResourcePhase::OutcomeUnknown);
    assert!(peer_dialog.dialog.is_some());
    assert!(
        matches!(
            result,
            Ok(Err(BrowserRuntimeError::Observation(
                "browser_renderer_lifecycle_changed"
            )))
        ),
        "{result:?}"
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn one_resource_routes_two_profiles_and_releases_input_on_its_original_instance() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-resource-profile-routing-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profiles:one-resource");
    let profiles = [
        BrowserProfileIdV1::new("profile:a").unwrap(),
        BrowserProfileIdV1::new("profile:b").unwrap(),
    ];
    let runtime = BrowserRuntime::launch_profile(
        resource.clone(),
        &config,
        &root,
        &profile_spec(&profiles[0]),
    )
    .await
    .unwrap();
    let (url, stop_http, server) = super::super::service_worker::fixture().await;
    let manifest =
        json!({"name":"한글 첨부.txt","size":4,"sha256":format!("{:x}",Sha256::digest(b"peer"))});
    let chunk = |offset, bytes: &[u8]| {
        serde_json::from_value(
            json!({"file":manifest,"offset":offset,"base64":STANDARD.encode(bytes)}),
        )
        .unwrap()
    };
    let evidence: Result<_, BrowserRuntimeError> = async {
        // Both initial tabs use the same native construction path and Host.
        runtime.launch_binding(&config, Some(&profile_spec(&profiles[1]))).await?;
        let observed = runtime.observe().await?;
        let mut pages = profiles.iter().map(|profile| observed.pages.iter().find(|page| page.profile_id.as_ref()==Some(profile)).map(|page| page.page.clone()).ok_or("profile page missing")).collect::<Result<Vec<_>,_>>()?;
        let lease = runtime.request_control(BrowserControllerId::new("profile-agent").unwrap(), None).await?.controller.ok_or("controller missing")?;
        let mut reads = Vec::new();
        let mut captures = Vec::new();
        for (index, page) in pages.iter_mut().enumerate() {
            apply(&runtime, &lease, page, json!({"kind":"navigate","url":url})).await?;
            *page = runtime.host.lock().await.page_identity(&page.page_id)?;
            let label = format!("한글 프로필 {index}");
            let color = if index == 0 { "red" } else { "blue" };
            let script = format!("document.body.style.background='{color}';document.body.innerHTML='<h1 id=proof>{label}</h1><input id=file type=file>';document.cookie='profile={index};Path=/';localStorage.setItem('profile','{index}');window.contacts=[];document.onmouseup=e=>contacts.push('up');document.onkeyup=e=>contacts.push('key:'+e.key);true");
            apply(&runtime, &lease, page, json!({"kind":"evaluate","script":script})).await?;
            let query = serde_json::from_value(json!({"kind":"text","target":{"kind":"css","selector":"#proof"}})).unwrap();
            let text = runtime.query(page, &query).await?;
            let storage = apply(&runtime, &lease, page, json!({"kind":"evaluate","script":"({cookie:document.cookie,local:localStorage.getItem('profile')})"})).await?;
            let profile = runtime.profile_id(page).await?;
            reads.push((text,storage,profile));
            let screenshot = runtime.capture_image(page,&ImageCapture::default()).await?.file;
            captures.push(format!("{:x}",Sha256::digest(&screenshot.bytes)));
        }
        apply(&runtime,&lease,&pages[0],json!({"kind":"key_down","key":"Shift"})).await?;
        apply(&runtime,&lease,&pages[0],json!({"kind":"mouse","action":{"kind":"down"}})).await?;
        apply(&runtime,&lease,&pages[1],json!({"kind":"evaluate","script":"'selected second profile'"})).await?;
        let origin_contacts = apply(&runtime,&lease,&pages[0],json!({"kind":"evaluate","script":"contacts"})).await?;
        let peer_contacts = apply(&runtime,&lease,&pages[1],json!({"kind":"evaluate","script":"contacts"})).await?;
        apply(&runtime,&lease,&pages[1],json!({"kind":"key_down","key":"Shift"})).await?;
        let human = runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await?.controller.ok_or("handoff missing")?;
        let handoff_contacts = apply(&runtime,&human,&pages[1],json!({"kind":"evaluate","script":"contacts"})).await?;
        runtime.stage_upload(chunk(0,b"pe")).await?;
        let first_instance = runtime.host.lock().await.instance_for_page(&pages[0].page_id)?.clone();
        runtime.retire_binding(&first_instance).await?;
        let staged = runtime.stage_upload(chunk(2,b"er")).await?;
        let upload = apply(&runtime,&human,&pages[1],json!({"kind":"upload","target":{"kind":"css","selector":"#file"},"files":[staged["id"]]})).await?;
        let attached = apply(&runtime,&human,&pages[1],json!({"kind":"evaluate","script":"(async()=>({name:document.querySelector('#file').files[0].name,text:await document.querySelector('#file').files[0].text()}))()"})).await?;
        let after = runtime.observe().await?;
        Ok((pages,reads,captures,origin_contacts,peer_contacts,handoff_contacts,human,upload,attached,after))
    }.await;
    let closed = runtime.close(&resource).await;
    let _ = stop_http.send(());
    let server = server.await;
    println!(
        "BROWSER_RESOURCE_PROFILE_ROUTING root={} evidence={evidence:?} closed={closed:?} server={server:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(server.is_ok(), "{server:?}");
    let (
        pages,
        reads,
        captures,
        origin_contacts,
        peer_contacts,
        handoff_contacts,
        human,
        _upload,
        attached,
        after,
    ) = evidence.unwrap();
    for (index, (text, storage, profile)) in reads.into_iter().enumerate() {
        assert_eq!(text["data"]["text"], format!("한글 프로필 {index}"));
        assert_eq!(storage["result"]["local"], index.to_string());
        assert_eq!(storage["result"]["cookie"], format!("profile={index}"));
        assert_eq!(profile, Some(profiles[index].clone()));
    }
    assert_ne!(captures[0], captures[1]);
    assert_eq!(origin_contacts["result"], json!(["up", "key:Shift"]));
    assert_eq!(peer_contacts["result"], json!([]));
    assert_eq!(handoff_contacts["result"], json!(["key:Shift"]));
    assert_eq!(
        attached["result"],
        json!({"name":"한글 첨부.txt","text":"peer"})
    );
    assert_eq!(after.control.phase, BrowserResourcePhase::Ready);
    assert_eq!(after.control.controller, Some(human));
    assert_eq!(after.pages.len(), 1);
    assert_eq!(after.pages[0].page, pages[1]);
    assert_eq!(after.pages[0].profile_id, Some(profiles[1].clone()));
}
