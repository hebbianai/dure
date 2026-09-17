use super::*;
use cdp::BrowserCdp;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn worker_disconnect_requires_terminal_exit_before_replacement() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-worker-close-ack-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let (mut chromium, mut engine) = exclusive_engine(&config, &root).await.unwrap();
    let original = engine.socket.clone();
    let proxy = root.join("ack.sock");
    let listener = tokio::net::UnixListener::bind(&proxy).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["action"], "close");
        reader
            .get_mut()
            .write_all(
                format!(
                    "{}\n",
                    json!({"id":request["id"],"success":true,"data":{"closed":true}})
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    engine.socket = proxy;
    let pid = engine.process_id();
    let refused = engine.disconnect().await;
    let replacement = engine.start_reconnect();
    let retained = engine.process_id() == pid && engine.child.try_wait().unwrap().is_none();
    engine.socket = original;
    let closed = engine.close().await;
    let browser_closed = chromium.close().await;
    server.abort();
    let server_closed = server.await;
    println!(
        "BROWSER_WORKER_ACK root={} refused={refused:?} replacement={replacement:?} retained={retained} closed={closed:?} browser_closed={browser_closed:?} server={server_closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(browser_closed.is_ok(), "{browser_closed:?}");
    assert!(server_closed.is_ok() || server_closed.is_err_and(|error| error.is_cancelled()));
    assert!(refused.is_err_and(
        |error| error.code == "browser_engine_retirement_unconfirmed" && error.outcome_unknown
    ));
    assert!(replacement.is_err_and(
        |error| error.code == "browser_engine_not_disconnected" && !error.outcome_unknown
    ));
    assert!(retained);
}

pub(super) async fn exclusive_engine(
    config: &NativeBrowserEngineConfig,
    root: &Path,
) -> Result<(chromium::OwnedChromium, NativeBrowserEngine), BrowserEngineError> {
    let mut chromium = chromium::OwnedChromium::launch(&config.chromium, root).await?;
    let attached = async {
        let target = chromium.launch_page().await?;
        NativeBrowserEngine::attach(config, root, chromium.connection(), &target).await
    }
    .await;
    match attached {
        Ok(engine) => Ok((chromium, engine)),
        Err(error) => {
            let _ = chromium.close().await;
            Err(error)
        }
    }
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn native_worker_retirement_preserves_the_owned_browser_page() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-worker-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let (mut chromium, mut engine) = exclusive_engine(&config, &root).await.unwrap();
    let mut cdp = BrowserCdp::connect(engine.chromium.endpoint())
        .await
        .unwrap();
    let tabs = engine.require(json!({"action":"tab_list"})).await.unwrap();
    let target = tabs["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tab| tab["active"] == true)
        .unwrap()["targetId"]
        .as_str()
        .unwrap();
    let session = cdp.attach(target).await.unwrap();
    let before = cdp
        .request(
            "Runtime.evaluate",
            json!({"expression":"window.workerLifetime='한글 작업 상태'","returnByValue":true}),
            Some(&session),
        )
        .await;
    let closed = engine.close().await;
    let retained = cdp
        .request(
            "Runtime.evaluate",
            json!({"expression":"window.workerLifetime","returnByValue":true}),
            Some(&session),
        )
        .await;
    let retired = chromium.close().await;
    cdp.retire().await;
    println!(
        "BROWSER_WORKER_LIFETIME root={} before={before:?} closed={closed:?} retained={retained:?} retired={retired:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(retired.is_ok(), "{retired:?}");
    assert_eq!(before.unwrap()["result"]["value"], "한글 작업 상태");
    assert_eq!(
        retained.unwrap()["result"]["value"],
        "한글 작업 상태",
        "Closing a native worker must preserve its browser and page state"
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn native_workers_attach_and_replace_without_navigating_owned_or_foreign_pages() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-workers-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let mut browser = chromium::OwnedChromium::launch(&config.chromium, &root)
        .await
        .unwrap();
    let mut cdp = BrowserCdp::connect(browser.endpoint()).await.unwrap();
    let mut workers = Vec::new();
    let result: Result<_, BrowserEngineError> = async {
        let mut pages = Vec::new();
        for name in ["작업 A", "작업 B"] {
            let target = browser.launch_page().await?;
            let session = cdp.attach(target.as_str()).await.map_err(BrowserEngineError::before)?;
            let document = cdp.document(&session).await.map_err(BrowserEngineError::before)?;
            cdp.request("Runtime.evaluate",json!({"expression":format!("window.instance={};true",serde_json::to_string(name).unwrap()),"returnByValue":true}),Some(&session)).await.map_err(BrowserEngineError::before)?;
            pages.push((target,session,document));
        }
        let before = cdp.request("Target.getTargets",json!({}),None).await.map_err(BrowserEngineError::before)?;
        for (target,_,_) in &pages {
            workers.push(NativeBrowserEngine::attach(&config, &root, browser.connection(), target).await?);
        }
        let first = workers[0].require(json!({"action":"evaluate","script":"window.instance"})).await?;
        let second = workers[1].require(json!({"action":"evaluate","script":"window.instance"})).await?;
        let worker_roots = [workers[0].runtime_root().to_owned(),workers[1].runtime_root().to_owned()];
        workers[0].close().await?;
        let peer = workers[1].require(json!({"action":"evaluate","script":"window.instance"})).await?;
        workers.push(NativeBrowserEngine::attach(&config, &root, browser.connection(), &pages[0].0).await?);
        let replacement = workers[2].require(json!({"action":"evaluate","script":"window.instance"})).await?;
        let invalid = NativeBrowserEngine::attach(&config,&root,browser.connection(),&BrowserTargetId::new("missing-target").unwrap()).await;
        let invalid_code = match invalid {
            Ok(worker) => { workers.push(worker); None },
            Err(error) => Some(error.code),
        };
        let after = cdp.request("Target.getTargets",json!({}),None).await.map_err(BrowserEngineError::before)?;
        let mut retained = Vec::new();
        for (_,session,document) in pages {
            let current = cdp.document(&session).await.map_err(BrowserEngineError::before)?;
            let value = cdp.request("Runtime.evaluate",json!({"expression":"window.instance","returnByValue":true}),Some(&session)).await.map_err(BrowserEngineError::before)?;
            retained.push((document,current,value));
        }
        Ok((first,second,peer,replacement,invalid_code,worker_roots,before,after,retained))
    }.await;
    let mut closed = Vec::new();
    for worker in &mut workers {
        closed.push(worker.close().await);
    }
    cdp.retire().await;
    let retired = browser.close().await;
    println!(
        "BROWSER_SHARED_WORKERS root={} result={result:?} closed={closed:?} retired={retired:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok), "{closed:?}");
    assert!(retired.is_ok(), "{retired:?}");
    let (first, second, peer, replacement, invalid, worker_roots, before, after, retained) =
        result.unwrap();
    assert_eq!(first["result"], "작업 A");
    assert_eq!(second["result"], "작업 B");
    assert_eq!(peer["result"], "작업 B");
    assert_eq!(replacement["result"], "작업 A");
    assert_eq!(invalid, Some("browser_engine_target_missing"));
    assert_ne!(worker_roots[0], worker_roots[1]);
    assert!(
        worker_roots
            .iter()
            .all(|root| !root.starts_with(browser.download_directory().parent().unwrap()))
    );
    let targets = |state: Value| {
        state["targetInfos"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|target| target["type"] == "page")
            .map(|target| target["targetId"].as_str().unwrap().to_owned())
            .collect::<std::collections::BTreeSet<_>>()
    };
    assert_eq!(
        targets(before),
        targets(after),
        "Worker attachment must not create replacement tabs"
    );
    for ((before, after, value), expected) in retained.into_iter().zip(["작업 A", "작업 B"]) {
        assert_eq!(
            before, after,
            "Worker attachment must not replace a document"
        );
        assert_eq!(value["result"]["value"], expected);
    }
}
