use super::*;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, JoinSet};

pub(super) async fn fixture() -> (String, oneshot::Sender<()>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (stop, mut stopped) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut requests = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let Ok((socket, _)) = accepted else { break };
                    requests.spawn(async move {
                        let _ = timeout(Duration::from_secs(5), respond(socket)).await;
                    });
                }
                Some(_) = requests.join_next() => {}
            }
        }
        // Chromium may leave speculative connections without request bytes.
        // Every accepted socket still belongs to this awaited fixture lifetime.
        requests.shutdown().await;
    });
    (url, stop, task)
}

async fn respond(mut socket: TcpStream) -> std::io::Result<()> {
    let mut request = [0; 4096];
    let mut received = 0;
    while !request[..received]
        .windows(4)
        .any(|bytes| bytes == b"\r\n\r\n")
    {
        if received == request.len() {
            return Err(std::io::Error::other(
                "fixture request headers exceed limit",
            ));
        }
        let count = socket.read(&mut request[received..]).await?;
        if count == 0 {
            return Ok(());
        }
        received += count;
    }
    let worker = String::from_utf8_lossy(&request[..received]).starts_with("GET /sw.js ");
    let (mime, body) = if worker {
        (
            "text/javascript; charset=utf-8",
            "self.addEventListener('install',e=>e.waitUntil(fetch('/worker-start').then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>e.ports[0].postMessage('한글 worker ready'));",
        )
    } else {
        (
            "text/html; charset=utf-8",
            "<!doctype html><meta charset=utf-8><title>Worker storage</title><input aria-label=Value>",
        )
    };
    socket
        .write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes(),
        )
        .await?;
    socket.shutdown().await
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn service_worker_registration_observes_initial_script_and_install_requests() {
    registration(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn shared_resource_observes_service_worker_after_origin_resource_closes() {
    registration(true).await;
}

async fn registration(shared: bool) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-service-worker-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity = identity("worker:registration");
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let (runtime, identity, origin_retired) = if shared {
        let mut peer_identity = identity.clone();
        peer_identity.resource_id = BrowserResourceId::new("worker:shared").unwrap();
        let peer = runtime.share_instance(peer_identity.clone()).await;
        let retired = runtime.close(&identity).await;
        (peer.unwrap(), peer_identity, Some(retired))
    } else {
        (runtime, identity, None)
    };
    let (url, stop, server) = fixture().await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let _idle = TcpStream::connect(url.strip_prefix("http://").unwrap())
            .await
            .map_err(|_| "fixture_idle_connection_failed")?;
        let lease = runtime
            .request_control(BrowserControllerId::new("worker-agent").unwrap(), None)
            .await?
            .controller
            .ok_or("fixture_control_missing")?;
        let page = first_page(&runtime).await?;
        apply(&runtime, &lease, &page, json!({"kind":"navigate","url":url})).await?;
        let page = first_page(&runtime).await?;
        let reply = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"(async()=>{await navigator.serviceWorker.register('/sw.js');const registration=await navigator.serviceWorker.ready;return await new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=e=>{channel.port1.close();resolve(e.data)};registration.active.postMessage('probe',[channel.port2]);});})()"}),
        )
        .await?;
        let network = runtime.network(&page).await?;
        let next = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"document.title='Worker completed';document.title"}),
        )
        .await?;
        Ok((reply, network, next, runtime.control().await))
    }
    .await;
    let retired = runtime.close(&identity).await;
    let _ = stop.send(());
    let server_retired = server.await;
    println!(
        "BROWSER_SERVICE_WORKER root={} shared={shared} origin_retired={origin_retired:?} evidence={evidence:?} retired={retired:?} server={server_retired:?}",
        root.display()
    );
    assert!(origin_retired.is_none_or(|retired| retired.is_ok()));
    assert!(retired.is_ok(), "{retired:?}");
    assert!(server_retired.is_ok(), "{server_retired:?}");
    let (reply, network, next, control) = evidence.unwrap();
    assert_eq!(reply["result"], "한글 worker ready");
    assert!(network.complete, "{network:?}");
    for path in ["/sw.js", "/worker-start"] {
        assert!(
            network.requests.iter().any(|request| {
                request.url == format!("{url}{path}") && request.status == Some(200)
            }),
            "Initial worker request was not observed: {path} {network:?}"
        );
    }
    assert_eq!(next["result"], "Worker completed");
    assert_eq!(control.phase, BrowserResourcePhase::Ready);
    assert!(control.in_flight.is_none());
}
