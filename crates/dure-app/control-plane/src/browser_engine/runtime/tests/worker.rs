use super::*;
use std::os::unix::fs::PermissionsExt;

fn config() -> NativeBrowserEngineConfig {
    NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap()
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn worker_reconnect_spawn_failure_settles_action_before_dispatch() {
    let root = tempfile::Builder::new()
        .prefix("dure-worker-spawn-fail-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("worker:spawn-fail");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let binding = runtime.test_binding();
    let original = binding.engine.lock().await.config.executable.clone();
    let evidence:Result<_,BrowserRuntimeError>=async {
        let page=first_page(&runtime).await?;
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"disconnect"})).await?;
        binding.engine.lock().await.config.executable=root.join("absent-engine");
        let attempted=runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(json!({"kind":"evaluate","script":"window.never=true"})).unwrap()).await;
        let state=runtime.control().await;
        binding.engine.lock().await.config.executable=original.clone();
        let observed=runtime.observe().await?;
        let value=apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"window.never??null"})).await?;
        Ok(json!({"before_dispatch":matches!(attempted,Err(BrowserRuntimeError::Engine(error))if error.code=="browser_engine_spawn_failed"&&!error.outcome_unknown),"phase":state.phase,"in_flight":state.in_flight,"page":page,"observed":observed,"value":value}))
    }.await;
    binding.engine.lock().await.config.executable = original;
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_WORKER_SPAWN_FAIL root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let result = evidence.unwrap();
    assert_eq!(result["before_dispatch"], true);
    assert_eq!(result["phase"], "ready");
    assert!(result["in_flight"].is_null());
    assert_eq!(result["observed"]["pages"][0]["page"], result["page"]);
    assert!(result["value"]["result"].is_null());
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn worker_reconnect_failure_during_input_transfer_preserves_the_fence() {
    let root = tempfile::Builder::new()
        .prefix("dure-worker-transfer-fail-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("worker:transfer-fail");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let binding = runtime.test_binding();
    let original = binding.engine.lock().await.config.executable.clone();
    let evidence:Result<_,BrowserRuntimeError>=async {
        let page=first_page(&runtime).await?;
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"key_down","key":"Shift"})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"disconnect"})).await?;
        binding.engine.lock().await.config.executable=root.join("absent-engine");
        let transferred=runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await;
        Ok(json!({"unknown":matches!(transferred,Err(BrowserRuntimeError::Engine(error))if error.code=="browser_input_drain_unobserved"&&error.outcome_unknown),"state":runtime.control().await,"lease":lease}))
    }.await;
    binding.engine.lock().await.config.executable = original;
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_WORKER_TRANSFER_FAIL root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let result = evidence.unwrap();
    assert_eq!(result["unknown"], true);
    assert_eq!(result["state"]["phase"], "outcome_unknown");
    assert_eq!(result["state"]["controller"], result["lease"]);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn worker_disconnect_reconnect_preserves_pages_input_and_peer_authority() {
    let root = tempfile::Builder::new()
        .prefix("dure-worker-reconnect-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("worker:owner");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let mut peer = None;
    let evidence: Result<_,BrowserRuntimeError> = async {
        peer = Some(runtime.share_instance(identity("worker:peer")).await?);
        let peer = peer.as_ref().unwrap();
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(), None).await?.controller.unwrap();
        let page = first_page(&runtime).await?;
        let peer_page = first_page(peer).await?;
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.innerHTML='<input value=한글><button>Increment</button>';window.node=document.querySelector('input');window.count=0;document.querySelector('button').onclick=()=>window.count++;window.node.focus();document.addEventListener('keyup',event=>window.released=event.key);true"})).await?;
        apply(peer,&peer_lease,&peer_page,json!({"kind":"evaluate","script":"window.peerValue='동료';true"})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"key_down","key":"Shift"})).await?;
        let snapshot=runtime.snapshot(&page,&Default::default()).await?;
        let reference=click_reference(&snapshot)?;
        let before=runtime.control().await;
        let binding=runtime.test_binding();
        let old_pid=binding.engine.lock().await.process_id();
        let disconnected=apply(&runtime,&lease,&page,json!({"kind":"disconnect"})).await?;
        let stopped={let mut engine=binding.engine.lock().await;engine.disconnected()&&engine.child.try_wait().map_err(|_|"fixture_child_wait_failed")?.is_some()};
        let after=runtime.control().await;
        let next=apply(&runtime,&lease,&page,json!({"kind":"click","target":{"kind":"reference","reference":reference}})).await?;
        let new_pid=binding.engine.lock().await.process_id();
        apply(&runtime,&lease,&page,json!({"kind":"key_up","key":"Shift"})).await?;
        let retained=apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"({same:window.node===document.querySelector('input'),value:window.node.value,count:window.count,released:window.released})"})).await?;
        let peer_retained=apply(peer,&peer_lease,&peer_page,json!({"kind":"evaluate","script":"window.peerValue"})).await?;
        let observed=runtime.observe().await?;
        let human=runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await?.controller.unwrap();
        let stale=runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(json!({"kind":"disconnect"})).unwrap()).await;
        let unchanged_pid=binding.engine.lock().await.process_id();
        apply(&runtime,&human,&page,json!({"kind":"disconnect"})).await?;
        // A peer's next request reconnects the shared worker to its own Host page.
        let peer_again=apply(peer,&peer_lease,&peer_page,json!({"kind":"evaluate","script":"window.peerValue"})).await?;
        Ok(json!({"before":before,"after":after,"stopped":stopped,"old_pid":old_pid,"new_pid":new_pid,"unchanged_pid":unchanged_pid,"disconnected":disconnected,"next":next,"retained":retained,"peer_retained":peer_retained,"peer_again":peer_again,"page":page,"observed":observed,"stale":matches!(stale,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::ControllerChanged)))}))
    }.await;
    let peer_closed = if let Some(peer) = peer {
        Some(peer.close(&identity("worker:peer")).await)
    } else {
        None
    };
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_WORKER_RECONNECT root={} evidence={evidence:?} peer_closed={peer_closed:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(peer_closed.is_some_and(|result| result.is_ok()));
    let result = evidence.unwrap();
    assert_eq!(result["disconnected"]["closed"], true);
    assert_eq!(result["stopped"], true);
    assert_ne!(result["old_pid"], result["new_pid"]);
    assert_eq!(result["new_pid"], result["unchanged_pid"]);
    for key in [
        "resource",
        "current_page",
        "controller",
        "keyboard",
        "pointer",
    ] {
        assert_eq!(result["before"][key], result["after"][key], "{key}");
    }
    assert_eq!(
        result["retained"]["result"],
        json!({"same":true,"value":"한글","count":1,"released":"Shift"})
    );
    assert_eq!(result["peer_retained"]["result"], "동료");
    assert_eq!(result["peer_again"], result["peer_retained"]);
    assert_eq!(result["observed"]["pages"][0]["page"], result["page"]);
    assert_eq!(result["stale"], true);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn worker_reconnect_caller_cancellation_retains_startup_until_resource_close() {
    let root = tempfile::Builder::new()
        .prefix("dure-worker-cancel-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("worker:cancel");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let marker = root.join("entered");
    let release = root.join("release");
    let executable = root.join("delayed-engine");
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    let original = runtime
        .test_binding()
        .engine
        .lock()
        .await
        .config
        .executable
        .clone();
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\ntouch {}\nwhile [ ! -f {} ]; do sleep 0.02; done\nexec {} \"$@\"\n",
            quote(&marker),
            quote(&release),
            quote(&original)
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let evidence:Result<_,BrowserRuntimeError>=async {
        let page=first_page(&runtime).await?;
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"disconnect"})).await?;
        runtime.test_binding().engine.lock().await.config.executable=executable;
        let mut observing=Box::pin(runtime.observe());
        tokio::select! {
            result=&mut observing => return Err(if result.is_ok(){"fixture_reconnect_not_delayed"}else{"fixture_reconnect_failed"}.into()),
            result=timeout(Duration::from_secs(10),async {while !marker.exists(){sleep(Duration::from_millis(5)).await;}}) => {result.map_err(|_|"fixture_reconnect_not_entered")?;}
        }
        drop(observing);
        let retained=runtime.test_binding().engine.try_lock().is_err();
        let mut closing=Box::pin(runtime.close(&resource));
        tokio::select! {
            _=&mut closing => return Err("fixture_close_abandoned_startup".into()),
            result=timeout(Duration::from_secs(5),async {while runtime.control().await.phase!=BrowserResourcePhase::Retiring{sleep(Duration::from_millis(5)).await;}}) => {result.map_err(|_|"fixture_retirement_not_entered")?;}
        }
        std::fs::write(&release,b"release").map_err(|_|"fixture_release_failed")?;
        closing.await?;
        Ok(json!({"retained":retained,"phase":runtime.control().await.phase}))
    }.await;
    std::fs::write(&release, b"release").unwrap();
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_WORKER_CANCEL root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert_eq!(evidence.unwrap(), json!({"retained":true,"phase":"closed"}));
}
