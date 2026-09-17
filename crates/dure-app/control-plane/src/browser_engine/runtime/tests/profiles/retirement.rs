use super::*;
use dure_app::BrowserProfileIdV1;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn default_profile_closes_with_an_isolated_peer_and_reopens_its_storage() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-retirement-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let (url, stop, server) = super::super::service_worker::fixture().await;
    let selected = BrowserProfileIdV1::new("default").unwrap();
    let peer = BrowserProfileIdV1::new("isolated-peer").unwrap();
    let mut results = Vec::new();
    for cycle in 0..4 {
        let mut runtimes = Vec::new();
        let evidence: Result<_, BrowserRuntimeError> = async {
            for (name, profile) in [("retirement:default", &selected), ("retirement:peer", &peer)] {
                runtimes.push(
                    BrowserRuntime::launch_profile(identity(name), &config, &root, &profile_spec(profile))
                        .await?,
                );
            }
            let owner = &runtimes[0];
            let peer_before = runtimes[1].control().await;
            let lease = owner.request_control(BrowserControllerId::new("retirement-agent").unwrap(), None)
                .await?.controller.ok_or("fixture_controller_missing")?;
            let page = first_page(owner).await?;
            apply(owner, &lease, &page, json!({"kind":"navigate", "url":url})).await?;
            let page = first_page(owner).await?;
            let value = apply(owner, &lease, &page, json!({"kind":"evaluate", "script":format!("(()=>{{const prior=localStorage.getItem('retirement');localStorage.setItem('retirement','한글 {cycle}');return prior;}})()") })).await?;
            let peer_after = runtimes[1].control().await;
            Ok((value, peer_before, peer_after))
        }.await;
        let mut retired = Vec::new();
        // Await both owners even when one close fails; a failed cycle is not
        // retried with a new profile or hidden by a later successful cycle.
        for runtime in &runtimes {
            retired.push(runtime.close(&runtime.control().await.resource).await);
        }
        println!(
            "BROWSER_PROFILE_RETIREMENT root={} cycle={cycle} evidence={evidence:?} retired={retired:?}",
            root.display()
        );
        let failed = evidence.is_err() || retired.iter().any(Result::is_err);
        results.push((cycle, evidence, retired));
        if failed {
            break;
        }
    }
    let _ = stop.send(());
    let server_retired = server.await;
    assert!(server_retired.is_ok(), "{server_retired:?}");
    for (cycle, evidence, retired) in &results {
        assert_eq!(retired.len(), 2);
        assert!(
            retired.iter().all(Result::is_ok),
            "cycle={cycle} {retired:?}"
        );
        let (value, before, after) = evidence.as_ref().unwrap();
        assert_eq!(before, after, "isolated peer changed");
        let expected = if *cycle == 0 {
            Value::Null
        } else {
            json!(format!("한글 {}", cycle - 1))
        };
        assert_eq!(value["result"], expected);
    }
    assert_eq!(results.len(), 4);
}
