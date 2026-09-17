use super::*;
use std::time::Duration;
use tokio::time::{sleep, timeout};

async fn scenario(retire: Option<usize>) {
    let scripts = tempfile::Builder::new()
        .prefix("dure-browser-profile-admission-")
        .tempdir_in("/tmp")
        .unwrap();
    let marker = scripts.path().join("started");
    let release = scripts.path().join("release");
    let executable = scripts.path().join("chromium");
    let chromium = PathBuf::from(std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap());
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    std::fs::write(&executable, format!(
        "#!/bin/sh\nprintf 'started\\n' >> {}\nwhile [ ! -f {} ]; do sleep 0.02; done\nexec {} \"$@\"\n",
        quote(&marker), quote(&release), quote(&chromium)
    )).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let fixture = Arc::new(Fixture::new(&executable).await);
    let launch = |operation: &'static str| {
        let fixture = Arc::clone(&fixture);
        tokio::spawn(async move {
            fixture.service.dispatch(&fixture.store, &json!({"kind":"create","workspace_id":"workspace:construction","operation_id":operation,"init_scripts":["window.startup='shared';"]})).await
        })
    };
    let origin = launch("profile:pending-origin");
    let starting = timeout(Duration::from_secs(5), async {
        while !marker.is_file() {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    let before = timeout(Duration::from_secs(2), fixture.list()).await;
    let peer = launch("profile:pending-peer");
    let listed = timeout(Duration::from_secs(5), async {
        loop {
            let list = fixture.list().await?;
            if list["result"]["resources"]
                .as_array()
                .is_some_and(|resources| resources.len() == 2)
            {
                return Ok::<_, BackendDispatchError>(list);
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    let origin_resource = before
        .as_ref()
        .ok()
        .and_then(|value| value.as_ref().ok())
        .and_then(|value| value.pointer("/result/resources/0/resource"))
        .cloned();
    let peer_resource = listed
        .as_ref()
        .ok()
        .and_then(|value| value.as_ref().ok())
        .and_then(|value| value.pointer("/result/resources"))
        .and_then(Value::as_array)
        .and_then(|resources| {
            resources
                .iter()
                .map(|resource| &resource["resource"])
                .find(|resource| Some(*resource) != origin_resource.as_ref())
        })
        .cloned();
    let both_pending = !origin.is_finished() && !peer.is_finished();
    let selected = match retire {
        Some(0) => origin_resource.clone(),
        Some(_) => peer_resource.clone(),
        None => None,
    };
    let mut closing = selected.clone().map(|resource| {
        let fixture = Arc::clone(&fixture);
        tokio::spawn(async move {
            fixture.service.dispatch(&fixture.store, &json!({"kind":"close","resource":resource,"operation_id":"profile:pending-close"})).await
        })
    });
    let closed_early = match closing.as_mut() {
        Some(closing) => Some(timeout(Duration::from_secs(3), closing).await),
        None => None,
    };
    let during_close = fixture.list().await;
    // Release the owned launcher before any assertions, including failure paths.
    std::fs::write(&release, b"release").unwrap();
    let origin_result = timeout(Duration::from_secs(40), origin).await;
    let peer_result = timeout(Duration::from_secs(40), peer).await;
    let closed_late = match (closed_early.as_ref(), closing.as_mut()) {
        (Some(Err(_)), Some(closing)) => Some(timeout(Duration::from_secs(40), closing).await),
        _ => None,
    };
    let mut views = Vec::new();
    for resource in [origin_resource, peer_resource].into_iter().flatten() {
        views.push(
            fixture
                .service
                .dispatch(
                    &fixture.store,
                    &json!({"kind":"observe","resource_id":resource["resource_id"]}),
                )
                .await,
        );
    }
    let launches = std::fs::read_to_string(&marker);
    let cleaned = fixture.finish().await;
    println!(
        "BROWSER_PROFILE_PENDING retire={retire:?} root={} starting={starting:?} before={before:?} listed={listed:?} pending={both_pending} origin={origin_result:?} peer={peer_result:?} closeEarly={closed_early:?} duringClose={during_close:?} closeLate={closed_late:?} views={views:?} launches={launches:?} cleanup={cleaned:?}",
        fixture.root.display()
    );
    assert!(cleaned.is_ok(), "{cleaned:?}");
    assert!(starting.is_ok(), "{starting:?}");
    assert_eq!(
        before.unwrap().unwrap()["result"]["resources"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        listed.unwrap().unwrap()["result"]["resources"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(both_pending);
    assert_eq!(launches.unwrap().lines().count(), 1);
    let origin_result = origin_result.unwrap().unwrap();
    let peer_result = peer_result.unwrap().unwrap();
    assert_eq!(
        origin_result.is_ok(),
        retire != Some(0),
        "{origin_result:?}"
    );
    assert_eq!(peer_result.is_ok(), retire.is_none(), "{peer_result:?}");
    if retire == Some(0) {
        // A persistent owner's successful Close must join normal native exit.
        // Admission is fenced now; releasing the launcher permits graceful exit.
        assert!(matches!(closed_early, Some(Err(_))), "{closed_early:?}");
        let during_close = during_close.unwrap();
        let resources = during_close["result"]["resources"].as_array().unwrap();
        let retiring = resources
            .iter()
            .find(|resource| Some(&resource["resource"]) == selected.as_ref())
            .expect("the closing native owner remains listed until normal exit");
        assert_eq!(retiring["phase"], "retiring");
        assert_eq!(
            closed_late.unwrap().unwrap().unwrap().unwrap()["result"]["closed"],
            true
        );
    } else if retire.is_some() {
        assert_eq!(
            closed_early.unwrap().unwrap().unwrap().unwrap()["result"]["closed"],
            true
        );
        assert!(closed_late.is_none());
    } else {
        assert_eq!(views.len(), 2);
        for view in views {
            let view = view.unwrap();
            assert_eq!(view["result"]["pages"].as_array().unwrap().len(), 1);
            assert_eq!(view["result"]["pages"][0]["profile_id"], "default");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn concurrent_default_creates_share_pending_owner_and_close_waiters_before_startup() {
    for retire in [None, Some(1), Some(0)] {
        scenario(retire).await;
    }
}
