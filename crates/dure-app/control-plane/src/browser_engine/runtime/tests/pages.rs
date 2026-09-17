use super::*;
use crate::browser_engine::{
    NativeBrowserEngine,
    cdp::BrowserCdp,
    chromium::OwnedChromium,
    runtime::{
        download, events::BrowserEventMonitor, instance::BrowserInstanceLease,
        lifecycle::ResourceRetirement, upload,
    },
};
use futures_util::{SinkExt, StreamExt};
use hmux_host::browser_resource::BrowserResourceHost;
use std::sync::Arc;
use tokio::sync::{Mutex, oneshot};
use tokio_tungstenite::{
    accept_async, client_async,
    tungstenite::{Message, http::Uri},
};

mod boundaries;
mod cancellation;
mod history;
mod identity;
mod profile_destination;
mod windows;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_new_page_reply_retires_its_shared_instance_and_preserves_an_independent_page() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-new-page-loss-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("new-page:owner");
    let (chromium, engine) = crate::browser_engine::tests::exclusive_engine(&config, &root)
        .await
        .unwrap();
    let endpoint = engine.chromium.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/new-page-loss",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = oneshot::channel();
    let (effect, observed_effect) = oneshot::channel();
    let proxy = tokio::spawn(lose_reply(
        listener,
        endpoint,
        "Target.createTarget",
        effect,
        stopped,
    ));
    let runtime = with_event_connection(chromium, engine, resource.clone(), &address)
        .await
        .unwrap();
    let peer = runtime
        .share_instance(identity("new-page:peer"))
        .await
        .unwrap();
    let independent = BrowserRuntime::launch(identity("new-page:independent"), &config, &root)
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let controller = BrowserControllerId::new("agent").unwrap();
        let page = first_page(&runtime).await?;
        let lease = runtime
            .request_control(controller.clone(), None)
            .await?
            .controller
            .unwrap();
        let independent_page = first_page(&independent).await?;
        let independent_lease = independent
            .request_control(controller, None)
            .await?
            .controller
            .unwrap();
        apply(
            &independent,
            &independent_lease,
            &independent_page,
            json!({"kind":"evaluate","script":"window.proof='분리된 작업';true"}),
        )
        .await?;
        let action = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"new_page","url":"about:blank"}),
        )
        .await;
        let acknowledged = timeout(Duration::from_secs(5), observed_effect)
            .await
            .map_err(|_| "fixture_page_creation_timeout")?
            .map_err(|_| "fixture_page_creation_unobserved")?;
        let target = BrowserTargetId::new(
            acknowledged["result"]["targetId"]
                .as_str()
                .ok_or("fixture_created_target_missing")?,
        )
        .unwrap();
        let phases = (runtime.control().await.phase, peer.control().await.phase);
        let owned = runtime.host.lock().await.owns_page_target(&target);
        let browser_exited = runtime.test_binding().instance.browser_has_exited().await?;
        let worker_exited = runtime
            .test_binding()
            .engine
            .lock()
            .await
            .child
            .try_wait()
            .map_err(|_| "fixture_worker_wait_failed")?
            .is_some();
        let orphan_live = if browser_exited {
            None
        } else {
            let census = runtime
                .test_binding()
                .cdp
                .clone()
                .request("Target.getTargets", json!({}), None)
                .await?;
            Some(
                census["targetInfos"]
                    .as_array()
                    .ok_or("fixture_census_missing")?
                    .iter()
                    .any(|info| info["targetId"].as_str() == Some(target.as_str())),
            )
        };
        let independent_value = apply(
            &independent,
            &independent_lease,
            &independent_page,
            json!({"kind":"evaluate","script":"window.proof"}),
        )
        .await?;
        let independent_after = first_page(&independent).await?;
        Ok((
            action,
            acknowledged,
            phases,
            owned,
            browser_exited,
            worker_exited,
            orphan_live,
            independent_value,
            independent_page,
            independent_after,
        ))
    }
    .await;
    let peer_first_close = peer.close(&peer.control().await.resource).await;
    let closed = runtime.close(&resource).await;
    let peer_closed = peer.close(&peer.control().await.resource).await;
    let independent_closed = independent
        .close(&independent.control().await.resource)
        .await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_NEW_PAGE_REPLY_LOSS root={} evidence={evidence:?} peer_first_close={peer_first_close:?} closed={closed:?} peer_closed={peer_closed:?} independent_closed={independent_closed:?} proxy_closed={proxy_closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(peer_closed.is_ok(), "{peer_closed:?}");
    assert!(independent_closed.is_ok(), "{independent_closed:?}");
    assert!(proxy_closed.is_ok(), "{proxy_closed:?}");
    let (
        action,
        acknowledged,
        phases,
        _owned,
        browser_exited,
        worker_exited,
        orphan_live,
        value,
        before,
        after,
    ) = evidence.unwrap();
    assert!(matches!(action, Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown));
    assert!(acknowledged["result"]["targetId"].as_str().is_some());
    assert_eq!(value["result"], json!("분리된 작업"));
    assert_eq!(after, before);
    assert!(
        browser_exited && worker_exited,
        "Unaccounted new page survives: orphan_live={orphan_live:?}"
    );
    assert_eq!(
        phases,
        (BrowserResourcePhase::Closed, BrowserResourcePhase::Closed)
    );
}

async fn with_event_connection(
    chromium: OwnedChromium,
    engine: NativeBrowserEngine,
    resource: BrowserResourceIdentity,
    address: &str,
) -> Result<BrowserRuntime, BrowserRuntimeError> {
    let command = engine.chromium.endpoint().to_owned();
    with_connections(chromium, engine, resource, &command, address).await
}

pub(super) async fn with_connections(
    mut chromium: OwnedChromium,
    mut engine: NativeBrowserEngine,
    resource: BrowserResourceIdentity,
    command: &str,
    address: &str,
) -> Result<BrowserRuntime, BrowserRuntimeError> {
    let host = Arc::new(Mutex::new(BrowserResourceHost::new(resource.clone())));
    let prepared: Result<_, BrowserRuntimeError> = async {
        let cdp = BrowserCdp::connect(command).await?;
        let downloads = download::prepare(&chromium).await?;
        let tabs = engine.require(json!({"action":"tab_list"})).await?;
        for tab in tabs["tabs"].as_array().ok_or("fixture_tabs_missing")? {
            host.lock().await.reserve_page_target(
                &resource,
                engine.chromium.instance().clone(),
                BrowserTargetId::new(tab["targetId"].as_str().ok_or("fixture_target_missing")?)
                    .unwrap(),
            )?;
        }
        let events = BrowserEventMonitor::start(
            Arc::clone(&host),
            address,
            engine.chromium.instance().clone(),
            Arc::new(tokio::sync::Notify::new()),
        )
        .await?;
        Ok((cdp, downloads, events))
    }
    .await;
    let (cdp, downloads, events) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = engine.close().await;
            let _ = chromium.close().await;
            return Err(error);
        }
    };
    let directory = engine.runtime_root().to_owned();
    let uploads = Arc::new(Mutex::new(upload::BrowserUploads::new(
        engine.runtime_root(),
    )));
    let retirement = ResourceRetirement::new(&resource, &host, &events, &cdp, &uploads);
    let profile = chromium.profile_id().map(profile_spec);
    let instance = Arc::new(BrowserInstanceLease::owned(
        chromium,
        engine,
        downloads,
        retirement.clone(),
    ));
    Ok(BrowserRuntime::from_binding(
        host,
        uploads,
        directory,
        crate::browser_engine::runtime::BrowserBinding {
            engine: instance.engine(),
            downloads: instance.downloads(),
            instance,
            events,
            cdp,
            retirement,
        },
        profile,
    ))
}

pub(super) async fn lose_reply(
    listener: TcpListener,
    endpoint: String,
    method: &'static str,
    effect: oneshot::Sender<Value>,
    mut stopped: oneshot::Receiver<()>,
) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut client = accept_async(stream).await.unwrap();
    let uri: Uri = endpoint.parse().unwrap();
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap()))
        .await
        .unwrap();
    let (mut chrome, _) = client_async(endpoint, stream).await.unwrap();
    let mut effect = Some(effect);
    let mut intercepted = None;
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            message = client.next() => {
                let Some(Ok(message)) = message else { break; };
                if let Ok(text) = message.to_text() {
                    let request: Value = serde_json::from_str(text).unwrap();
                    if request["method"] == method && intercepted.is_none() {
                        intercepted = Some(request["id"].clone());
                    }
                }
                if chrome.send(message).await.is_err() { break; }
            }
            message = chrome.next() => {
                let Some(Ok(message)) = message else { break; };
                if effect.is_some() {
                    if let Ok(text) = message.to_text() {
                        let response: Value = serde_json::from_str(text).unwrap();
                        if intercepted.as_ref().is_some_and(|id| response["id"]==*id) {
                            assert!(response.get("result").is_some(), "{response}");
                            let _ = effect.take().unwrap().send(response);
                            // Lose only this real reply. Keep target events and all
                            // later traffic on the same retained source connection.
                            continue;
                        }
                    }
                }
                if client.send(message).await.is_err() { break; }
            }
        }
    }
    let _ = client.close(None).await;
    let _ = chrome.close(None).await;
}
