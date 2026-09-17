use super::*;
use hmux_session_protocol::browser_pointer::TouchAction;

mod faults;

fn config() -> NativeBrowserEngineConfig {
    NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap()
}

const PAGE: &str = "document.body.innerHTML='<style>html,body{margin:0;width:900px;height:900px;touch-action:none}button{position:fixed;left:100px;top:100px;width:100px;height:100px}</style><button>Increment</button><input value=한글>';window.trace=[];window.clicks=0;document.querySelector('button').onclick=()=>window.clicks++;for(const type of ['touchstart','touchmove','touchend','touchcancel','pointerdown','pointerup'])document.addEventListener(type,e=>{window.trace.push({type,trusted:e.isTrusted,pointer:e.pointerType??null,points:e.changedTouches?Array.from(e.changedTouches,t=>[t.clientX,t.clientY]):[]});},{passive:false});true";

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn tap_and_directional_swipes_deliver_trusted_touch_only_to_the_owned_page() {
    let root = tempfile::Builder::new()
        .prefix("dure-touch-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("touch:owner");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let mut peer = None;
    let evidence:Result<_,BrowserRuntimeError>=async {
        peer=Some(runtime.share_instance(identity("touch:peer")).await?);
        let peer=peer.as_ref().unwrap();
        let page=first_page(&runtime).await?;
        let peer_page=first_page(peer).await?;
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let peer_lease=peer.request_control(BrowserControllerId::new("peer").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":PAGE})).await?;
        apply(peer,&peer_lease,&peer_page,json!({"kind":"evaluate","script":"window.touches=0;window.value='동료';document.addEventListener('touchstart',()=>window.touches++);true"})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"tap","target":{"kind":"css","selector":"button"}})).await?;
        let snapshot=runtime.snapshot(&page,&Default::default()).await?;
        let reference=click_reference(&snapshot)?;
        apply(&runtime,&lease,&page,json!({"kind":"tap","target":{"kind":"reference","reference":reference}})).await?;
        let taps=apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"({trace:window.trace,clicks:window.clicks,value:document.querySelector('input').value})"})).await?;
        let mut swipes=Vec::new();
        for direction in ["up","down","left","right"] {
            apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"window.trace=[];true"})).await?;
            let response=apply(&runtime,&lease,&page,json!({"kind":"swipe","direction":direction,"distance":60})).await?;
            let trace=apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"window.trace"})).await?;
            swipes.push(json!({"direction":direction,"response":response,"trace":trace["result"],"touch":runtime.control().await.touch}));
        }
        let peer_value=apply(peer,&peer_lease,&peer_page,json!({"kind":"evaluate","script":"({touches:window.touches,value:window.value})"})).await?;
        runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await?;
        let stale=runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(json!({"kind":"tap","target":{"kind":"css","selector":"button"}})).unwrap()).await;
        Ok(json!({"taps":taps["result"],"swipes":swipes,"peer":peer_value["result"],"stale":matches!(stale,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::ControllerChanged)))}))
    }.await;
    let peer_closed = if let Some(peer) = peer {
        Some(peer.close(&identity("touch:peer")).await)
    } else {
        None
    };
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_TOUCH root={} evidence={evidence:?} peer_closed={peer_closed:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(peer_closed.is_some_and(|r| r.is_ok()));
    let result = evidence.unwrap();
    assert_eq!(result["taps"]["clicks"], 2);
    assert_eq!(result["taps"]["value"], "한글");
    let taps = result["taps"]["trace"].as_array().unwrap();
    assert_eq!(taps.iter().filter(|e| e["type"] == "touchstart").count(), 2);
    assert_eq!(taps.iter().filter(|e| e["type"] == "touchend").count(), 2);
    assert!(taps.iter().all(|e| e["trusted"] == true));
    assert!(
        taps.iter()
            .filter(|e| e["type"] == "pointerdown")
            .all(|e| e["pointer"] == "touch")
    );
    for swipe in result["swipes"].as_array().unwrap() {
        assert_eq!(swipe["response"]["swiped"], swipe["direction"]);
        assert!(swipe["touch"].is_null());
        let trace = swipe["trace"].as_array().unwrap();
        let starts = trace
            .iter()
            .filter(|e| e["type"] == "touchstart")
            .collect::<Vec<_>>();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["points"], json!([[200, 400]]));
        let end = trace
            .iter()
            .rev()
            .find(|e| e["type"] == "touchmove")
            .unwrap();
        let expected = match swipe["direction"].as_str().unwrap() {
            "up" => json!([[200, 340]]),
            "down" => json!([[200, 460]]),
            "left" => json!([[140, 400]]),
            "right" => json!([[260, 400]]),
            _ => unreachable!(),
        };
        assert_eq!(end["points"], expected);
        assert_eq!(trace.iter().filter(|e| e["type"] == "touchend").count(), 1);
        assert!(trace.iter().all(|e| e["trusted"] == true));
    }
    assert_eq!(result["peer"], json!({"touches":0,"value":"동료"}));
    assert_eq!(result["stale"], true);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn a_retained_touch_is_canceled_before_human_control_is_granted() {
    let root = tempfile::Builder::new()
        .prefix("dure-touch-transfer-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("touch:transfer");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .unwrap();
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":PAGE}),
        )
        .await?;
        let admission = authority(&runtime, &lease, &page).await;
        let permit =
            runtime
                .host
                .lock()
                .await
                .begin_action(&lease.controller_id, &admission, [])?;
        let execution = runtime.execution(&page).await?;
        execution
            .touch_event(&permit, TouchAction::Start { x: 150.0, y: 150.0 })
            .await?;
        runtime
            .host
            .lock()
            .await
            .finish_action(permit, BrowserActionOutcome::Completed)?;
        let before = runtime.control().await;
        let control = runtime
            .request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .await?;
        let human = control.controller.as_ref().unwrap();
        let observed = apply(
            &runtime,
            human,
            &page,
            json!({"kind":"evaluate","script":"({trace:window.trace,clicks:window.clicks})"}),
        )
        .await?;
        Ok(json!({"before":before,"control":control,"observed":observed["result"]}))
    }
    .await;
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_TOUCH_TRANSFER root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let result = evidence.unwrap();
    assert!(result["before"]["touch"].is_object());
    assert!(result["control"]["touch"].is_null());
    assert_eq!(result["control"]["controller"]["controller_id"], "human");
    assert_eq!(result["observed"]["clicks"], 0);
    assert_eq!(
        result["observed"]["trace"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "touchcancel" && e["trusted"] == true)
            .count(),
        1
    );
}
