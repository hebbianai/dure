use super::*;
use dure_app::BrowserProfileIdV1;

const WRITE: &str = r#"(async()=>{
  window.profileProofStage='synchronous storage';
  document.cookie='profile_cookie=stored; Max-Age=86400; Path=/';
  localStorage.setItem('profile-value','한글 저장');
  sessionStorage.setItem('tab-value','original tab');
  window.profileProofStage='IndexedDB';
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('profile-proof',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  await new Promise((resolve,reject)=>{const t=db.transaction('values','readwrite');t.objectStore('values').put('저장된 IDB','key');t.oncomplete=resolve;t.onerror=()=>reject(t.error)});db.close();
  window.profileProofStage='CacheStorage';
  await (await caches.open('profile-proof')).put('/saved',new Response('저장된 cache'));
  window.profileProofStage='ServiceWorker register';
  await navigator.serviceWorker.register('/sw.js');
  window.profileProofStage='ServiceWorker ready';
  await navigator.serviceWorker.ready;
  window.profileProofStage='complete';
  return true;
})()"#;

const READ: &str = r#"(async()=>{
  let idb=null;
  if((await indexedDB.databases()).some(db=>db.name==='profile-proof')) {
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('profile-proof',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    idb=await new Promise((resolve,reject)=>{const r=db.transaction('values').objectStore('values').get('key');r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error)});db.close();
  }
  const cached=await caches.match('/saved');
  return {cookie:document.cookie,local:localStorage.getItem('profile-value'),session:sessionStorage.getItem('tab-value'),idb,cache:cached?await cached.text():null,workers:(await navigator.serviceWorker.getRegistrations()).length};
})()"#;

async fn evaluate(runtime: &BrowserRuntime, script: &str) -> Result<Value, BrowserRuntimeError> {
    let page = first_page(runtime).await?;
    let lease = runtime
        .control()
        .await
        .controller
        .ok_or("fixture_control_missing")?;
    let result = apply(
        runtime,
        &lease,
        &page,
        json!({"kind":"evaluate","script":script}),
    )
    .await;
    if result.is_err() {
        let mut cdp = runtime.test_binding().cdp.clone();
        let target = runtime.host.lock().await.target_for(&page).cloned();
        if let Ok(target) = target
            && let Ok(session) = cdp.attach(target.as_str()).await
        {
            let diagnostic = cdp.request("Runtime.evaluate", json!({"expression":"({stage:window.profileProofStage,url:location.href})","returnByValue":true}), Some(&session)).await;
            println!("BROWSER_PROFILE_EVALUATION diagnostic={diagnostic:?}");
        }
    }
    Ok(result?["result"].clone())
}

async fn navigate(runtime: &BrowserRuntime, url: &str) -> Result<(), BrowserRuntimeError> {
    let lease = runtime
        .request_control(BrowserControllerId::new("profile-agent").unwrap(), None)
        .await?
        .controller
        .ok_or("fixture_control_missing")?;
    let page = first_page(runtime).await?;
    apply(runtime, &lease, &page, json!({"kind":"navigate","url":url})).await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn persistent_profile_runtime_shares_storage_isolates_tabs_and_reopens_after_native_exit() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-persistent-profile-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let (url, stop_http, server) = super::super::service_worker::fixture().await;
    let selected = BrowserProfileIdV1::new("persistent-selected").unwrap();
    let other = BrowserProfileIdV1::new("persistent-other").unwrap();
    let mut runtimes = Vec::new();
    let evidence: Result<_, BrowserRuntimeError> = async {
        runtimes.push(
            BrowserRuntime::launch_profile(
                identity("persistent:owner"),
                &config,
                &root,
                &profile_spec(&selected),
            )
            .await?,
        );
        navigate(&runtimes[0], &url).await?;
        let written = evaluate(&runtimes[0], WRITE).await?;
        let worker_network = runtimes[0]
            .network(&first_page(&runtimes[0]).await?)
            .await?;
        runtimes.push(
            runtimes[0]
                .share_instance(identity("persistent:peer"))
                .await?,
        );
        navigate(&runtimes[1], &url).await?;
        let shared = evaluate(&runtimes[1], READ).await?;
        let origin = evaluate(&runtimes[0], READ).await?;
        runtimes.push(
            BrowserRuntime::launch_profile(
                identity("persistent:other"),
                &config,
                &root,
                &profile_spec(&other),
            )
            .await?,
        );
        navigate(&runtimes[2], &url).await?;
        let isolated = evaluate(&runtimes[2], READ).await?;
        let duplicate = BrowserRuntime::launch_profile(
            identity("persistent:duplicate"),
            &config,
            &root,
            &profile_spec(&selected),
        )
        .await;
        let duplicate_code = match duplicate {
            Ok(runtime) => {
                runtimes.push(runtime);
                None
            }
            Err(BrowserRuntimeError::Engine(error)) => Some(error.code),
            Err(error) => return Err(error),
        };
        let old_instance = runtimes[0]
            .test_binding()
            .instance
            .connection()
            .await
            .instance()
            .clone();
        runtimes[0].close(&identity("persistent:owner")).await?;
        let peer_after_close = evaluate(&runtimes[1], READ).await?;
        runtimes[1].close(&identity("persistent:peer")).await?;
        let exited = runtimes[1]
            .test_binding()
            .instance
            .browser_has_exited()
            .await?;
        runtimes.push(
            BrowserRuntime::launch_profile(
                identity("persistent:reopened"),
                &config,
                &root,
                &profile_spec(&selected),
            )
            .await?,
        );
        let reopened = runtimes.last().unwrap();
        navigate(reopened, &url).await?;
        let persisted = evaluate(reopened, READ).await?;
        let new_instance = reopened
            .test_binding()
            .instance
            .connection()
            .await
            .instance()
            .clone();
        let isolated_after = evaluate(&runtimes[2], READ).await?;
        let profile_ids = vec![
            runtimes[0].test_binding().instance.profile_id().await,
            runtimes[1].test_binding().instance.profile_id().await,
            reopened.test_binding().instance.profile_id().await,
        ];
        Ok((
            (written, worker_network),
            shared,
            origin,
            isolated,
            duplicate_code,
            peer_after_close,
            exited,
            persisted,
            old_instance,
            new_instance,
            isolated_after,
            profile_ids,
        ))
    }
    .await;
    let mut closed = Vec::new();
    for runtime in &runtimes {
        closed.push(runtime.close(&runtime.control().await.resource).await);
    }
    let _ = stop_http.send(());
    let server_retired = server.await;
    println!(
        "BROWSER_PERSISTENT_PROFILE root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok), "{closed:?}");
    assert!(server_retired.is_ok(), "{server_retired:?}");
    let (
        (written, worker_network),
        shared,
        origin,
        isolated,
        duplicate,
        peer_after,
        exited,
        persisted,
        old_instance,
        new_instance,
        isolated_after,
        profile_ids,
    ) = evidence.unwrap();
    let stored = json!({"cookie":"profile_cookie=stored","local":"한글 저장","session":null,"idb":"저장된 IDB","cache":"저장된 cache","workers":1});
    assert_eq!(written, true);
    assert!(worker_network.complete);
    assert!(
        worker_network
            .requests
            .iter()
            .any(|request| request.url == format!("{url}/sw.js")),
        "The worker's initial script fetch must remain observed: {worker_network:?}"
    );
    assert_eq!(shared, stored);
    let mut original = stored.clone();
    original["session"] = "original tab".into();
    assert_eq!(origin, original);
    assert_eq!(peer_after, stored);
    assert_eq!(persisted, stored);
    assert_eq!(
        isolated,
        json!({"cookie":"","local":null,"session":null,"idb":null,"cache":null,"workers":0})
    );
    assert_eq!(isolated_after, isolated);
    assert_eq!(duplicate, Some("browser_profile_exit_unconfirmed"));
    assert!(exited);
    assert_ne!(old_instance, new_instance);
    assert_eq!(profile_ids, vec![Some(selected); 3]);
}
