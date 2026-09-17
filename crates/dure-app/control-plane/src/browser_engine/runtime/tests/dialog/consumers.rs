use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn focused_element_dialog_allows_human_response_time() {
    exercise("focus", 6).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn selection_change_dialog_allows_human_response_time() {
    exercise("select", 6).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn inserted_text_dialog_allows_human_response_time() {
    exercise("insert", 32).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn filled_element_dialog_allows_human_response_time() {
    exercise("fill", 32).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn empty_replacement_dialog_allows_human_response_time() {
    exercise("clear", 32).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn file_input_change_dialog_allows_human_response_time() {
    exercise("upload", 6).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn printing_dialog_allows_human_response_time() {
    exercise("pdf", 32).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn navigation_beforeunload_allows_human_response_time() {
    exercise("navigate", 32).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn additional_empty_replacement_preserves_held_modifiers_until_handoff() {
    exercise("clear_held", 6).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn additional_cancelled_navigation_remains_known_after_human_wait() {
    exercise("navigate_dismiss", 32).await;
}

async fn exercise(kind: &str, seconds: u64) {
    let (runtime, identity, root) = super::authority::launch("dialog:consumer").await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/destination", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let body = "<title>Dialog destination</title>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    println!(
        "BROWSER_DIALOG_CONSUMER_START kind={kind} root={}",
        root.display()
    );
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        let target = json!({"kind":"css","selector":"#field"});
        let (html, handler, action) = match kind {
            "focus" => ("<button id=other>Other</button><input id=field>", "document.querySelector('#other').focus();field.onfocus=ask", json!({"kind":"focus","target":target})),
            "select" => ("<select id=field><option value=one>One</option><option value=two>Two</option></select>", "field.onchange=ask", json!({"kind":"select","target":target,"values":["two"]})),
            "insert" => ("<input id=field>", "field.focus();field.oninput=ask", json!({"kind":"insert_text","text":"입력"})),
            "fill" => ("<input id=field value=before>", "field.oninput=ask", json!({"kind":"fill","target":target,"text":"교체"})),
            "clear" | "clear_held" => ("<input id=field value=before>", "field.oninput=ask", json!({"kind":"fill","target":target,"text":""})),
            "upload" => ("<input type=file id=field>", "field.onchange=ask", json!({"kind":"upload","target":target,"files":[]})),
            "pdf" => ("<p>Printable fixture</p>", "onbeforeprint=ask", json!({"kind":"print_pdf"})),
            _ => ("<button id=field>Activate</button>", "onbeforeunload=e=>{window.calls++;e.preventDefault();e.returnValue=''}", json!({"kind":"navigate","url":url})),
        };
        let script = format!("document.body.innerHTML={};window.calls=0;window.answers=[];window.ask=()=>{{calls++;answers.push(prompt('Consumer wait','default'))}};{{let field=document.querySelector('#field');{handler};}};true", json!(html));
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":script})).await?;
        if matches!(kind, "navigate" | "navigate_dismiss") {
            apply(&runtime, &lease, &page, json!({"kind":"click","target":target})).await?;
        }
        if kind == "clear_held" {
            apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"window.keyEvents=[];onkeydown=onkeyup=e=>keyEvents.push([e.type,e.code,e.shiftKey]);true"})).await?;
            apply(&runtime, &lease, &page, json!({"kind":"key_down","key":"Shift"})).await?;
        }
        let mut action = action;
        if kind == "upload" {
            let bytes = "첨부 내용".as_bytes();
            let staged = runtime.stage_upload(serde_json::from_value(json!({"file":{"name":"첨부.txt","size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))},"offset":0,"base64":STANDARD.encode(bytes)})).unwrap()).await?;
            action["files"] = json!([staged["id"]]);
        }
        let action = serde_json::from_value(action).map_err(|_| "fixture_action_invalid")?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable", json!({}), Some(&session)).await?;
        if kind == "focus" {
            // Exercise a focused page without taking desktop/OS focus from the user.
            observer.request("Emulation.setFocusEmulationEnabled", json!({"enabled":true}), Some(&session)).await?;
        }
        let command = authority(&runtime, &lease, &page).await;
        let started = Instant::now();
        let (triggered, answered) = tokio::join!(
            runtime.action(&lease.controller_id, &command, action),
            async {
                let response: Result<_, BrowserRuntimeError> = async {
                    let first = super::authority::pending(&runtime, &page).await?;
                    sleep(Duration::from_secs(seconds)).await;
                    let waiting = runtime.dialog(&page.page_id).await?;
                    let response = if kind == "navigate_dismiss" { json!({"kind":"dismiss"}) } else if kind == "navigate" { json!({"kind":"accept"}) } else { json!({"kind":"accept","text":"한글 응답"}) };
                    let answered = runtime.respond_dialog(&lease.controller_id, &authority(&runtime, &lease, &page).await,
                        &first.dialog.as_ref().unwrap().identity, serde_json::from_value(response).unwrap()).await;
                    Ok((first, waiting, answered))
                }.await;
                let cleanup = if !matches!(&response, Ok((_, _, Ok(_)))) {
                    Some(observer.request("Page.handleJavaScriptDialog", json!({"accept":false}), Some(&session)).await)
                } else { None };
                (response, cleanup)
            }
        );
        let handoff = if kind == "clear_held" {
            let held = runtime.control().await.keyboard;
            let control = runtime.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease)).await?;
            Some((held, control))
        } else { None };
        let actual = observer.request("Runtime.evaluate", json!({"expression":"({keyEvents:window.keyEvents,href:location.href,focused:document.hasFocus(),active:document.activeElement?.id,handler:typeof document.querySelector('#field')?.onfocus,calls:window.calls,answers:window.answers,value:document.querySelector('#field')?.value,file:document.querySelector('#field')?.files?.[0]?.name})","returnByValue":true}), Some(&session)).await;
        observer.retire().await;
        Ok((started.elapsed(), triggered, answered, actual, handoff))
    }.await;
    let retired = runtime.close(&identity).await;
    server.abort();
    let _ = server.await;
    println!(
        "BROWSER_DIALOG_CONSUMER kind={kind} root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (elapsed, triggered, (answered, cleanup), actual, handoff) = evidence.unwrap();
    let (first, waiting, response) = answered.unwrap();
    assert!(elapsed >= Duration::from_secs(seconds));
    assert_eq!(waiting.dialog, first.dialog);
    assert_eq!(waiting.control.phase, BrowserResourcePhase::Ready);
    assert!(response.is_ok(), "{response:?}");
    assert!(cleanup.is_none(), "{cleanup:?}");
    let triggered = triggered.unwrap();
    assert_eq!(
        triggered.response.success,
        kind != "navigate_dismiss",
        "{triggered:?}"
    );
    assert_eq!(triggered.control.phase, BrowserResourcePhase::Ready);
    if let Some((held, control)) = handoff {
        let held = held.unwrap();
        assert_eq!(
            held.keys.iter().map(|key| key.code()).collect::<Vec<_>>(),
            vec!["ShiftLeft"]
        );
        assert_eq!(control.controller.unwrap().controller_id.as_str(), "human");
        assert!(control.keyboard.is_none());
    }
    let actual = actual.unwrap();
    if kind == "navigate" {
        assert_eq!(actual["result"]["value"]["href"], url);
    } else if kind == "navigate_dismiss" {
        assert_eq!(actual["result"]["value"]["href"], "about:blank");
        assert_eq!(actual["result"]["value"]["calls"], 1);
        assert!(
            triggered
                .response
                .error
                .as_deref()
                .unwrap()
                .contains("Navigation failed")
        );
    } else {
        assert_eq!(actual["result"]["value"]["answers"], json!(["한글 응답"]));
        assert_eq!(actual["result"]["value"]["calls"], 1);
        match kind {
            "insert" => assert_eq!(actual["result"]["value"]["value"], "입력"),
            "fill" => assert_eq!(actual["result"]["value"]["value"], "교체"),
            "clear" | "clear_held" => {
                assert_eq!(actual["result"]["value"]["value"], "");
                if kind == "clear_held" {
                    assert_eq!(
                        actual["result"]["value"]["keyEvents"],
                        json!([
                            ["keydown", "ShiftLeft", true],
                            ["keydown", "Backspace", true],
                            ["keyup", "Backspace", true],
                            ["keyup", "ShiftLeft", false]
                        ])
                    );
                }
            }
            "select" => assert_eq!(actual["result"]["value"]["value"], "two"),
            "upload" => assert_eq!(actual["result"]["value"]["file"], "첨부.txt"),
            "pdf" => assert!(
                triggered.response.data["artifact_payload"]["base64"]
                    .as_str()
                    .is_some()
            ),
            _ => {}
        }
    }
}
