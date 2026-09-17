use super::*;
use crate::browser_engine::{NativeBrowserEngineConfig, chromium::OwnedChromium};
use hmux_session_protocol::browser_resource::*;
use std::path::Path;

mod observation;

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine configuration"]
async fn browser_instance_census_preserves_other_instances_live_pages() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-browser-instances-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("resource:instances").unwrap(),
        generation: BrowserResourceGeneration::new("generation:1").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:1").unwrap(),
    };
    let host = Arc::new(Mutex::new(BrowserResourceHost::new(identity.clone())));
    let mut browsers = Vec::new();
    let mut connections = Vec::new();
    let evidence: Result<_, String> = async {
        let mut targets = Vec::new();
        let mut sessions = Vec::new();
        for index in 0..2 {
            browsers.push(
                OwnedChromium::launch(&config.chromium, &root)
                    .await
                    .map_err(|error| format!("{error:?}"))?,
            );
            let target = browsers[index]
                .launch_page()
                .await
                .map_err(|error| format!("{error:?}"))?;
            let mut cdp = BrowserCdp::connect(browsers[index].endpoint()).await?;
            let session = cdp.attach(target.as_str()).await?;
            let document = BrowserDocumentId::new(cdp.document(&session).await?)
                .map_err(|error| error.to_string())?;
            cdp.request(
                "Runtime.evaluate",
                json!({"expression":"window.profileValue='별도 프로필 상태'","returnByValue":true}),
                Some(&session),
            )
            .await?;
            host.lock()
                .await
                .register_page(
                    browsers[index].connection().instance().clone(),
                    target.clone(),
                    document,
                )
                .map_err(|error| format!("{error:?}"))?;
            targets.push(target);
            sessions.push(session);
            connections.push(cdp);
        }
        let initial = host.lock().await.pages();
        let mut sources = Vec::new();
        for (index, cdp) in connections.iter().enumerate() {
            let (barriers, _) = mpsc::channel(32);
            let monitor = monitor(
                Arc::clone(&host),
                cdp.clone(),
                barriers,
                browsers[index].connection().instance().clone(),
                Arc::new(tokio::sync::Notify::new()),
            )
            .await;
            sources.push(Source {
                cdp: cdp.clone(),
                resources: BTreeMap::from([(identity.resource_id.clone(), monitor)]),
            });
        }
        sources[0].census().await?;
        let after_a = host.lock().await.pages();
        connections[0]
            .request("Target.closeTarget", json!({"targetId":targets[0]}), None)
            .await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let census = connections[0]
                    .request("Target.getTargets", json!({}), None)
                    .await?;
                let live = census["targetInfos"]
                    .as_array()
                    .ok_or("fixture census missing")?;
                if !live
                    .iter()
                    .any(|target| target["targetId"].as_str() == Some(targets[0].as_str()))
                {
                    return Ok::<_, &'static str>(());
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| "fixture target retirement timeout")??;
        sources[0].census().await?;
        let after_close = host.lock().await.pages();
        sources[1].census().await?;
        let after_b = host.lock().await.pages();
        let actual_peer = connections[1]
            .request(
                "Runtime.evaluate",
                json!({"expression":"window.profileValue","returnByValue":true}),
                Some(&sessions[1]),
            )
            .await?;
        Ok((initial, after_a, after_close, after_b, actual_peer))
    }
    .await;
    for cdp in &connections {
        cdp.retire().await;
    }
    let mut retired = Vec::new();
    for browser in &mut browsers {
        retired.push(browser.close().await);
    }
    println!(
        "BROWSER_INSTANCE_CENSUS root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.iter().all(Result::is_ok), "{retired:?}");
    let (initial, after_a, after_close, after_b, actual_peer) = evidence.unwrap();
    assert_eq!(initial.len(), 2);
    assert_eq!(actual_peer["result"]["value"], "별도 프로필 상태");
    assert_eq!(
        after_a, initial,
        "One instance's census must preserve the other instance's live page"
    );
    assert_eq!(after_close, vec![initial[1].clone()]);
    assert_eq!(after_b, after_close);
}
