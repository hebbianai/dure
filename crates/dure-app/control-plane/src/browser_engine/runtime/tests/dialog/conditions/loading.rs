use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn load_waits_follow_real_document_readiness_after_a_human_dialog() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/fixture", listener.local_addr().unwrap());
    let (release, released) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut released = Some(released);
        for expected_path in ["/fixture", "/image.svg"] {
            let (stream, _) = listener.accept().await?;
            let mut stream = BufReader::new(stream);
            let mut request = String::new();
            stream.read_line(&mut request).await?;
            if !request.starts_with(&format!("GET {expected_path} ")) {
                return Err(std::io::Error::other(format!(
                    "unexpected request: {request}"
                )));
            }
            loop {
                let mut line = String::new();
                stream.read_line(&mut line).await?;
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let (content_type, body) = if expected_path == "/fixture" {
                (
                    "text/html; charset=utf-8",
                    r#"<!doctype html><link rel=icon href=data:,><script>window.answer=prompt('Loading wait')</script><p>한글 준비</p><img src=/image.svg>"#,
                )
            } else {
                released
                    .take()
                    .unwrap()
                    .await
                    .map_err(std::io::Error::other)?;
                (
                    "image/svg+xml",
                    r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>"#,
                )
            };
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await?;
            stream.shutdown().await?;
        }
        Ok::<_, std::io::Error>(Instant::now())
    });
    let (runtime, identity, root) = super::super::authority::launch("wait:loading").await;
    let evidence: Result<_,BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable",json!({}),Some(&session)).await?;
        let mut navigator = observer.clone();
        let (navigation, waits) = tokio::join!(
            navigator.request_with_deadline("Page.navigate",json!({"url":url}),Some(&session),Duration::from_secs(20)),
            async {
                let opened = super::super::authority::pending(&runtime,&page).await?;
                let dialog = opened.dialog.unwrap();
                let current = &dialog.identity.page;
                let dom = serde_json::from_value(json!({"condition":{"kind":"load","state":"domcontentloaded"},"timeout_ms":2000})).unwrap();
                let load = serde_json::from_value(json!({"condition":{"kind":"load","state":"load"},"timeout_ms":2000})).unwrap();
                let started = Instant::now();
                let (dom,load,answer) = tokio::join!(
                    async { (runtime.wait(current,&dom).await,Instant::now()) },
                    async { (runtime.wait(current,&load).await,Instant::now()) },
                    async {
                        sleep(Duration::from_secs(8)).await;
                        let answered = runtime.respond_dialog(&lease.controller_id,&authority(&runtime,&lease,current).await,&dialog.identity,serde_json::from_value(json!({"kind":"accept","text":"한글 로딩"})).unwrap()).await;
                        sleep(Duration::from_millis(750)).await;
                        let released = release.send(());
                        (answered,released)
                    },
                );
                Ok::<_,BrowserRuntimeError>((started,current.clone(),dom,load,answer))
            },
        );
        let cleanup = if !waits.as_ref().is_ok_and(|(_,_,_,_,answer)| answer.0.is_ok()) {
            Some(observer.request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&session)).await)
        } else { None };
        let actual = observer.request("Runtime.evaluate",json!({"expression":"({answer,state:document.readyState})","returnByValue":true}),Some(&session)).await;
        observer.retire().await;
        Ok((navigation,waits,cleanup,actual))
    }.await;
    let retired = runtime.close(&identity).await;
    if !server.is_finished() {
        server.abort();
    }
    let served = server.await;
    println!(
        "BROWSER_WAIT_LOADING root={} evidence={evidence:?} retired={retired:?} served={served:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let image_sent = served.unwrap().unwrap();
    let (navigation, waits, cleanup, actual) = evidence.unwrap();
    navigation.unwrap();
    let (started, current, (dom, dom_at), (load, load_at), (answer, released)) = waits.unwrap();
    answer.unwrap();
    released.unwrap();
    assert!(cleanup.is_none(), "{cleanup:?}");
    for result in [dom, load] {
        let result = result.unwrap();
        assert_eq!(result["waited"], true);
        assert_eq!(result["page"], serde_json::to_value(&current).unwrap());
    }
    assert!(dom_at.duration_since(started) >= Duration::from_secs(8));
    assert!(
        dom_at < image_sent && image_sent <= load_at,
        "dom={dom_at:?}, image={image_sent:?}, load={load_at:?}"
    );
    assert!(load_at.duration_since(started) < Duration::from_secs(10));
    assert_eq!(
        actual.unwrap()["result"]["value"],
        json!({"answer":"한글 로딩","state":"complete"})
    );
}
