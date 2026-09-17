use super::*;
mod background;
mod cloning;
mod deletion;
mod gated_page;
use crate::browser_engine::cdp::BrowserCdp;
use crate::browser_engine::runtime::events::BrowserEventMonitor;
use gated_page::GatedPage;
use hmux_host::browser_resource::BrowserResourceHost;
use std::sync::Arc;
use tokio::sync::Mutex;

mod persistence;
mod replacement;
mod retirement;
mod routing;
mod shared;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn shared_profile_observation_belongs_to_each_resources_explicit_pages() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-routing-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let (mut chromium, mut engine) = crate::browser_engine::tests::exclusive_engine(&config, &root)
        .await
        .unwrap();
    let address = engine.chromium.endpoint().to_owned();
    let mut cdp = BrowserCdp::connect(&address).await.unwrap();
    let mut monitors = Vec::new();
    let result: Result<_, BrowserRuntimeError> = async {
        let mut hosts = Vec::new();
        let mut targets = Vec::new();
        for name in ["profile:a", "profile:b"] {
            let target = cdp.request("Target.createTarget", json!({"url":"about:blank"}), None).await?["targetId"].as_str().unwrap().to_owned();
            let session = cdp.attach(&target).await?;
            let document = BrowserDocumentId::new(cdp.document(&session).await?).unwrap();
            let mut id = identity(name);
            id.workspace_id = BrowserWorkspaceId::new(format!("workspace:{name}")).unwrap();
            let mut host = BrowserResourceHost::new(id);
            host.register_page(engine.chromium.instance().clone(), BrowserTargetId::new(&target).unwrap(), document)?;
            hosts.push(Arc::new(Mutex::new(host)));
            targets.push((target, session));
        }
        monitors.push(BrowserEventMonitor::start(Arc::clone(&hosts[0]), &address, engine.chromium.instance().clone(), Arc::new(tokio::sync::Notify::new())).await?);
        monitors.push(monitors[0].share(Arc::clone(&hosts[1]), Arc::new(tokio::sync::Notify::new())).await?);
        for (index, (_, session)) in targets.iter().enumerate() {
            cdp.request("Runtime.evaluate", json!({"expression":format!("console.log('resource-{index}');true"),"returnByValue":true}), Some(session)).await?;
        }
        for (monitor,(target,_)) in monitors.iter().zip(&targets) {
            monitor.synchronize(&BrowserTargetId::new(target).unwrap()).await?;
        }
        let mut projected = Vec::new();
        for host in &hosts {
            let host = host.lock().await;
            projected.push(host.pages().iter().map(|page|host.target_for(page).unwrap().as_str().to_owned()).collect::<Vec<_>>());
        }
        let mut console = Vec::new();
        for host in &hosts {
            let host = host.lock().await;
            let entries = host.pages().into_iter().flat_map(|page|host.console_snapshot(&page.resource, &page.page_id, Default::default()).unwrap().entries).map(|entry|entry.text).collect::<Vec<_>>();
            console.push(entries);
        }
        // A second resource cannot claim a page already assigned by this source.
        let mut duplicate = BrowserResourceHost::new(identity("profile:duplicate"));
        duplicate.register_page(engine.chromium.instance().clone(), BrowserTargetId::new(&targets[0].0).unwrap(), BrowserDocumentId::new("duplicate-document").unwrap())?;
        let conflict = monitors[0].share(Arc::new(Mutex::new(duplicate)), Arc::new(tokio::sync::Notify::new())).await.err();
        let popup = cdp.request("Runtime.evaluate", json!({"expression":"window.open('about:blank') ? 'opened' : 'blocked'","returnByValue":true,"userGesture":true}), Some(&targets[0].1)).await?;
        println!("BROWSER_PROFILE_POPUP {popup:?}");
        monitors[0].synchronize_events().await?;
        let popup_counts = (hosts[0].lock().await.pages().len(), hosts[1].lock().await.pages().len());
        monitors[0].close().await;
        cdp.request("Runtime.evaluate", json!({"expression":"console.log('resource-1-after-close');true","returnByValue":true}), Some(&targets[1].1)).await?;
        monitors[1].synchronize(&BrowserTargetId::new(&targets[1].0).unwrap()).await?;
        let after_close = {
            let host = hosts[1].lock().await;
            let page = host.page_for_target(&BrowserTargetId::new(&targets[1].0).unwrap()).unwrap();
            host.console_snapshot(&page.resource, &page.page_id, Default::default())?.entries.into_iter().map(|entry|entry.text).collect::<Vec<_>>()
        };
        Ok((targets.into_iter().map(|(target,_)|target).collect::<Vec<_>>(),projected,console,conflict,popup_counts,after_close))
    }.await;
    for monitor in &monitors {
        monitor.close().await;
    }
    cdp.retire().await;
    let retired = engine.close().await;
    let browser_retired = chromium.close().await;
    assert!(browser_retired.is_ok(), "{browser_retired:?}");
    println!(
        "BROWSER_PROFILE_ROUTING root={} result={result:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (targets, projected, console, conflict, popup_counts, after_close) = result.unwrap();
    assert_eq!(console, vec![vec!["resource-0"], vec!["resource-1"]]);
    assert_eq!(conflict, Some("browser_page_owner_conflict"));
    assert_eq!(popup_counts, (2, 1));
    assert_eq!(after_close, vec!["resource-1", "resource-1-after-close"]);
    assert_eq!(
        projected,
        targets
            .into_iter()
            .map(|target| vec![target])
            .collect::<Vec<_>>(),
        "A resource observer must not import the other resource's pages from a shared browser endpoint"
    );
}
