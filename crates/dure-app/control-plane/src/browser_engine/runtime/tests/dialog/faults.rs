use super::*;
use crate::browser_engine::runtime::{download, events::BrowserEventMonitor, upload};
use futures_util::{SinkExt, StreamExt};
use hmux_host::browser_resource::BrowserResourceHost;
use std::sync::Arc;
use tokio::{
    net::TcpStream,
    sync::{Mutex, oneshot},
};
use tokio_tungstenite::{
    accept_async, client_async,
    tungstenite::{Message, http::Uri},
};

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_dialog_reply_fences_after_the_real_response_and_input_effect() {
    fault(Fault::LostReply).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn known_dialog_rejection_keeps_the_exact_pending_dialog_answerable() {
    fault(Fault::Reject).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn delayed_dialog_reply_drains_a_finished_keydown_before_handoff() {
    fault(Fault::DelayedReply).await;
}

#[derive(Clone, Copy, Debug)]
enum Fault {
    Reject,
    LostReply,
    DelayedReply,
}

async fn fault(fault: Fault) {
    let reject = matches!(fault, Fault::Reject);
    let delayed = matches!(fault, Fault::DelayedReply);
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-dialog-fault-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    println!(
        "BROWSER_DIALOG_FAULT_START mode={fault:?} root={}",
        root.display()
    );
    let identity = identity("dialog:fault");
    let (mut chromium, mut engine) = crate::browser_engine::tests::exclusive_engine(&config, &root)
        .await
        .unwrap();
    let upstream = engine.chromium.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/dialog-fault",
        listener.local_addr().unwrap()
    );
    let (stop, mut stopped) = oneshot::channel();
    let (effect, observed_effect) = oneshot::channel();
    let (release_reply, mut released_reply) = oneshot::channel();
    let proxy = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut client = accept_async(stream).await.unwrap();
        let uri: Uri = upstream.parse().unwrap();
        let stream = TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap()))
            .await
            .unwrap();
        let (mut chrome, _) = client_async(upstream, stream).await.unwrap();
        let mut effect = Some(effect);
        let mut intercepted = None;
        let mut held_reply = None;
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                _ = &mut released_reply, if held_reply.is_some() => {
                    if client.send(held_reply.take().unwrap()).await.is_err() { break; }
                },
                incoming = client.next() => {
                    let Some(Ok(message)) = incoming else { break; };
                    if let Ok(text) = message.to_text() {
                        let request: Value = serde_json::from_str(text).unwrap();
                        if request["method"] == "Page.handleJavaScriptDialog" && effect.is_some() && intercepted.is_none() {
                            intercepted = Some(request["id"].clone());
                            if reject {
                                client.send(Message::Text(json!({"id":request["id"],"error":{"code":-32000,"message":"fixture rejection before dispatch"}}).to_string().into())).await.unwrap();
                                effect.take().unwrap().send(json!({"rejectedBeforeDispatch":true})).unwrap();
                                continue;
                            }
                        }
                    }
                    if chrome.send(message).await.is_err() { break; }
                }
                incoming = chrome.next() => {
                    let Some(Ok(message)) = incoming else { break; };
                    if !reject && effect.is_some() {
                        if let Ok(text) = message.to_text() {
                            let response: Value = serde_json::from_str(text).unwrap();
                            if intercepted.as_ref().is_some_and(|id| response["id"] == *id) {
                                effect.take().unwrap().send(response).unwrap();
                                if delayed { held_reply = Some(message); }
                                // Keep the ordered close event and all later
                                // traffic. Delay or lose only this actual reply.
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
    });
    // Construct the ordinary owned runtime with only its event connection
    // routed through the fixture. No source is replaced after page work starts.
    let host = Arc::new(Mutex::new(BrowserResourceHost::new(identity.clone())));
    let prepared: Result<_, BrowserRuntimeError> = async {
        let cdp = BrowserCdp::connect(engine.chromium.endpoint()).await?;
        let downloads = download::prepare(&chromium).await?;
        let tabs = engine.require(json!({"action":"tab_list"})).await?;
        for tab in tabs["tabs"].as_array().unwrap() {
            host.lock().await.reserve_page_target(
                &identity,
                engine.chromium.instance().clone(),
                BrowserTargetId::new(tab["targetId"].as_str().unwrap()).unwrap(),
            )?;
        }
        let events = BrowserEventMonitor::start(
            Arc::clone(&host),
            &address,
            engine.chromium.instance().clone(),
            Arc::new(tokio::sync::Notify::new()),
        )
        .await?;
        Ok((cdp, downloads, events))
    }
    .await;
    if prepared.is_err() {
        let _ = engine.close().await;
        let _ = chromium.close().await;
        let _ = stop.send(());
        let _ = proxy.await;
        panic!("fixture setup failed: {:?}", prepared.err());
    }
    let (cdp, downloads, events) = prepared.unwrap();
    let directory = engine.runtime_root().to_owned();
    let uploads = Arc::new(Mutex::new(upload::BrowserUploads::new(
        engine.runtime_root(),
    )));
    let retirement = crate::browser_engine::runtime::lifecycle::ResourceRetirement::new(
        &identity, &host, &events, &cdp, &uploads,
    );
    let instance = Arc::new(
        crate::browser_engine::runtime::instance::BrowserInstanceLease::owned(
            chromium,
            engine,
            downloads,
            retirement.clone(),
        ),
    );
    let runtime = BrowserRuntime::from_binding(
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
        None,
    );
    let result: Result<_,BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.innerHTML='<button id=ask>Ask</button>';document.querySelector('#ask').onclick=()=>window.answer=prompt('fault');window.writes=0;true"})).await?;
        if delayed {
            apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"window.contacts=[];document.onkeydown=e=>{contacts.push(e.type);window.answer=prompt('held key')};document.onkeyup=e=>contacts.push(e.type);true"})).await?;
        }
        let command = authority(&runtime,&lease,&page).await;
        let action = if delayed { json!({"kind":"key_down","key":"a"}) } else { json!({"kind":"click","target":{"kind":"css","selector":"#ask"}}) };
        let (clicked,answer,release) = tokio::join!(runtime.action(&lease.controller_id,&command,serde_json::from_value(action).unwrap()),async {
            let observed = super::authority::pending(&runtime,&page).await?;
            let identity = observed.dialog.unwrap().identity;
            if delayed {
                runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await?;
            }
            let reply = runtime.respond_dialog(&lease.controller_id,&authority(&runtime,&lease,&page).await,&identity,serde_json::from_value(json!({"kind":"accept","text":"applied"})).unwrap()).await;
            let second = if reject {
                Some(runtime.respond_dialog(&lease.controller_id,&authority(&runtime,&lease,&page).await,&identity,serde_json::from_value(json!({"kind":"accept","text":"applied"})).unwrap()).await)
            } else { None };
            Ok::<_,BrowserRuntimeError>((reply,second))
        },async {
            let before = if delayed {
                Some(timeout(Duration::from_secs(3),async {
                    loop {
                        let control = runtime.control().await;
                        if control.in_flight.is_none() && control.dialog_response.is_some() { return control; }
                        sleep(Duration::from_millis(10)).await;
                    }
                }).await)
            } else { None };
            let _ = release_reply.send(());
            before
        });
        let phase = runtime.control().await.phase;
        let actual = runtime.test_binding().engine.lock().await.require(json!({"action":"evaluate","script":"({answer:window.answer,writes:window.writes})"})).await?;
        let later = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"++window.writes"})).await;
        let final_control = runtime.control().await;
        let contacts = if delayed { Some(runtime.test_binding().engine.lock().await.require(json!({"action":"evaluate","script":"window.contacts"})).await?) } else { None };
        Ok((clicked,answer,phase,actual,later,release,final_control,contacts))
    }.await;
    let retired = runtime.close(&identity).await;
    let _ = stop.send(());
    let proxy_result = proxy.await;
    let effect = observed_effect.await;
    println!(
        "BROWSER_DIALOG_FAULT mode={fault:?} reject={reject} root={} evidence={result:?} effect={effect:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    proxy_result.unwrap();
    let effect = effect.unwrap();
    let (clicked, answer, phase, actual, later, release, final_control, contacts) = result.unwrap();
    let (answer, second) = answer.unwrap();
    assert!(clicked.is_ok(), "{clicked:?}");
    assert_eq!(actual["result"], json!({"answer":"applied","writes":0}));
    if delayed {
        let before = release
            .unwrap()
            .expect("trigger did not finish while its dialog reply was held");
        assert_eq!(before.controller.unwrap().controller_id.as_str(), "agent");
        assert!(before.keyboard.is_some());
        assert!(answer.is_ok(), "{answer:?}");
        assert_eq!(phase, BrowserResourcePhase::Ready);
        assert_eq!(
            final_control.controller.unwrap().controller_id.as_str(),
            "human"
        );
        assert!(final_control.keyboard.is_none());
        assert!(final_control.requested_controller.is_none());
        assert_eq!(contacts.unwrap()["result"], json!(["keydown", "keyup"]));
    } else if reject {
        assert_eq!(effect["rejectedBeforeDispatch"], true);
        assert!(matches!(
            answer,
            Err(BrowserRuntimeError::Engine(BrowserEngineError {
                outcome_unknown: false,
                ..
            }))
        ));
        assert!(second.unwrap().is_ok());
        assert_eq!(phase, BrowserResourcePhase::Ready);
        assert!(later.is_ok());
    } else {
        assert!(effect["result"].is_object(), "{effect}");
        assert!(matches!(
            answer,
            Err(BrowserRuntimeError::Engine(BrowserEngineError {
                outcome_unknown: true,
                ..
            }))
        ));
        assert_eq!(phase, BrowserResourcePhase::OutcomeUnknown);
        assert!(matches!(
            later,
            Err(BrowserRuntimeError::Admission(
                BrowserAdmissionError::OutcomeUnknown
            ))
        ));
    }
}
