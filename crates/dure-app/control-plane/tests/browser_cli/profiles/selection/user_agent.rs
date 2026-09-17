use super::*;
use tokio::io::{AsyncBufReadExt, BufReader};

#[path = "user_agent/lifecycle.rs"]
mod lifecycle;

async fn identity_site() -> (String, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (stop, mut stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut requests = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let (socket, _) = accepted.unwrap();
                    requests.spawn(async move {
                        let _ = timeout(Duration::from_secs(5), async {
                            let mut socket = BufReader::new(socket);
                            let mut line = String::new();
                            socket.read_line(&mut line).await?;
                            let echo = line.starts_with("GET /headers ");
                            let mut headers = std::collections::BTreeMap::new();
                            let mut bytes = line.len();
                            loop {
                                line.clear();
                                let read = socket.read_line(&mut line).await?;
                                bytes += read;
                                if bytes > 16 * 1024 || read == 0 {
                                    return Err(std::io::Error::other("invalid fixture request"));
                                }
                                if line == "\r\n" { break; }
                                if let Some((name, value)) = line.split_once(':') {
                                    headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
                                }
                            }
                            let (content_type, body) = if echo {
                                ("application/json", json!(headers).to_string())
                            } else {
                                ("text/html; charset=utf-8", "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Profile identity</title>한글 프로필".to_owned())
                            };
                            let mut socket = socket.into_inner();
                            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await?;
                            socket.shutdown().await
                        }).await;
                    });
                }
                Some(_) = requests.join_next() => {}
            }
        }
        requests.shutdown().await;
    });
    (url, stop, server)
}

async fn observe(client: &Client, root: &Path) -> Result<Value, String> {
    client.evaluate(root, "(async()=>({ua:navigator.userAgent,hints:navigator.userAgentData?.toJSON()??null,width:screen.width,height:screen.height,scale:devicePixelRatio,innerWidth,marker:window.profileMarker??null,headers:await fetch('/headers').then(r=>r.json())}))()")
        .await
}

fn assert_native(observation: &Value, baseline: &Value) {
    assert_eq!(observation["ua"], baseline["ua"], "{observation}");
    assert_eq!(observation["headers"]["user-agent"], baseline["ua"]);
    assert_eq!(observation["hints"], baseline["hints"]);
    for name in ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"] {
        assert_eq!(observation["headers"][name], baseline["headers"][name]);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn native_profile_device_keeps_wire_and_renderer_identity_through_shared_and_reopened_owners()
{
    let (root, endpoint, server) = super::super::super::fixture().await;
    let (url, stop_site, site) = identity_site().await;
    let evidence: Result<_, String> = async {
        peer_workspace(&root).await?;
        let catalog = cli(&root, &["tab", "profile", "create", "--label", "기본 식별자 유지", "--no-ua-spoof"]).await?;
        let profile = catalog["result"]["profile"]["profile"]["profileId"].as_str().ok_or("profile missing")?;
        let native = Client::create(&root, "workspace-browser", Some(profile), "ua-native").await?;
        native.action(&root, "goto", &url).await?;
        native.evaluate(&root, "window.profileMarker='원본 유지';true").await?;
        let baseline = observe(&native, &root).await?;
        let native_receipt = native.action(&root, "device", "iPhone 15").await?;
        let phone = observe(&native, &root).await?;
        let clean = Client::create(&root, "workspace-browser", None, "ua-clean").await?;
        clean.action(&root, "goto", &url).await?;
        let clean_baseline = observe(&clean, &root).await?;
        clean.action(&root, "device", "iPhone 15").await?;
        let emulated = observe(&clean, &root).await?;
        let peer = Client::create(&root, "workspace-profile-peer", Some(profile), "ua-peer").await?;
        peer.action(&root, "goto", &url).await?;
        let peer_before = observe(&peer, &root).await?;
        peer.action(&root, "device", "Pixel 9").await?;
        let peer_device = observe(&peer, &root).await?;
        native.action(&root, "device", "reset").await?;
        let reset = observe(&native, &root).await?;
        native.close(&root).await?;
        let surviving = observe(&peer, &root).await?;
        peer.close(&root).await?;
        clean.action(&root, "device", "reset").await?;
        let clean_reset = observe(&clean, &root).await?;
        clean.close(&root).await?;
        let reopened = Client::create(&root, "workspace-browser", Some(profile), "ua-reopened").await?;
        reopened.action(&root, "goto", &url).await?;
        reopened.action(&root, "device", "iPhone 15").await?;
        let restored = observe(&reopened, &root).await?;
        reopened.close(&root).await?;
        Ok(json!({"catalog":catalog,"baseline":baseline,"nativeReceipt":native_receipt,"phone":phone,
            "cleanBaseline":clean_baseline,"emulated":emulated,"peerBefore":peer_before,"peerDevice":peer_device,
            "reset":reset,"surviving":surviving,"cleanReset":clean_reset,"restored":restored}))
    }.await;
    let shutdown = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let stopped = timeout(Duration::from_secs(40), server).await;
    let _ = stop_site.send(());
    let site_stopped = site.await;
    println!(
        "BROWSER_PROFILE_NATIVE_UA root={} evidence={evidence:?} shutdown={shutdown:?} stopped={stopped:?} site={site_stopped:?}",
        root.display()
    );
    assert!(matches!(stopped, Ok(Ok(Ok(())))), "{stopped:?}");
    assert!(site_stopped.is_ok(), "{site_stopped:?}");
    let evidence = evidence.unwrap();
    assert_eq!(
        evidence["catalog"]["result"]["profile"]["profile"]["userAgentMode"],
        "native"
    );
    let baseline = &evidence["baseline"];
    assert_eq!(baseline["headers"]["user-agent"], baseline["ua"]);
    for key in [
        "phone",
        "peerBefore",
        "peerDevice",
        "reset",
        "surviving",
        "restored",
    ] {
        assert_native(&evidence[key], baseline);
    }
    for key in ["phone", "emulated", "restored"] {
        assert_eq!(evidence[key]["width"], 393, "{key}");
        assert_eq!(evidence[key]["height"], 852, "{key}");
        assert_eq!(evidence[key]["innerWidth"], 393, "{key}");
        assert_eq!(evidence[key]["scale"], 3, "{key}");
    }
    for key in ["peerDevice", "surviving"] {
        assert_eq!(evidence[key]["width"], 412);
        assert_eq!(evidence[key]["height"], 923);
    }
    for field in ["width", "height", "scale", "innerWidth", "marker"] {
        assert_eq!(evidence["reset"][field], baseline[field]);
    }
    assert_eq!(evidence["phone"]["marker"], "원본 유지");
    assert_eq!(evidence["peerBefore"]["marker"], Value::Null);
    assert_eq!(evidence["restored"]["marker"], Value::Null);
    assert_ne!(evidence["emulated"]["ua"], evidence["cleanBaseline"]["ua"]);
    assert!(
        evidence["emulated"]["ua"]
            .as_str()
            .unwrap()
            .contains("iPhone")
    );
    assert_eq!(
        evidence["emulated"]["headers"]["user-agent"],
        evidence["emulated"]["ua"]
    );
    assert_native(&evidence["cleanReset"], &evidence["cleanBaseline"]);
    assert_eq!(
        evidence["nativeReceipt"]["result"]["response"]["success"],
        true
    );
}
