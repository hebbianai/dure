use super::super::*;
use super::{http_fixture, require};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn interception_scopes_frames_workers_types_navigation_and_control_handoff() {
    let (root, endpoint, server) = fixture().await;
    let (base, received, stop_http, http) = http_fixture().await;
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["create", "--workspace", "workspace-browser"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        let shown = cli(&root, &["show", resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let control = cli(&root, &["control", resource, "--controller", "intercept-proof"]).await?;
        let epoch = control["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let shared = ["--page", page, "--controller", "intercept-proof", "--epoch", epoch];
        let url = format!("{base}/start");
        let mut navigate = vec!["goto", resource, &url]; navigate.extend(shared);
        cli(&root, &navigate).await?;
        let mut enable = vec!["intercept", resource, "enable", "--patterns", "*/blocked-*", "--abort", "--resource-types", "Fetch"]; enable.extend(shared);
        cli(&root, &enable).await?;
        let frame = "<!doctype html><script>function load(){fetch('/blocked-frame').then(r=>r.text()).catch(()=>'blocked').then(text=>parent.postMessage(text,'*'))}addEventListener('message',load);load()</script>";
        let worker = "function load(){fetch('/blocked-worker').then(r=>r.text()).catch(()=>'blocked').then(text=>postMessage(text))}onmessage=load;load()";
        for (pattern, body, content_type) in [("*/frame", frame, "text/html"), ("*/worker.js", worker, "text/javascript")] {
            let mut mock = vec!["intercept", resource, "enable", "--patterns", pattern, "--body", body, "--content-type", content_type]; mock.extend(shared);
            cli(&root, &mock).await?;
        }
        let frame_url = format!("{}/frame", base.replace("127.0.0.1", "localhost"));
        let script = format!("Promise.all([fetch('/blocked-page').then(r=>r.text()).catch(()=>'blocked'),new Promise(resolve=>{{window.worker=new Worker('/worker.js');worker.onmessage=e=>resolve(e.data)}}),new Promise(resolve=>{{addEventListener('message',e=>resolve(e.data),{{once:true}});document.body.appendChild(Object.assign(document.createElement('iframe'),{{src:{}}}))}}),new Promise(resolve=>{{const xhr=new XMLHttpRequest();xhr.open('GET','/blocked-xhr');xhr.onload=()=>resolve(xhr.responseText);xhr.onerror=()=>resolve('blocked');xhr.send()}})])", json!(frame_url));
        let mut evaluate = vec!["eval", resource, &script]; evaluate.extend(shared);
        let effects = cli(&root, &evaluate).await?;
        require(effects["result"]["response"]["data"]["result"] == json!(["blocked", "blocked", "blocked", "server response"]), &effects)?;
        let neighbor_url = format!("{base}/start?neighbor");
        let mut new = vec!["tab-new", resource, &neighbor_url]; new.extend(shared);
        let opened = cli(&root, &new).await?;
        let neighbor = opened["result"]["observation"]["pages"].as_array().and_then(|pages| pages.iter().find(|candidate| candidate["url"] == neighbor_url)).and_then(|candidate| candidate["page"]["page_id"].as_str()).ok_or("neighbor missing")?;
        let neighbor_effect = cli(&root, &["eval", resource, "fetch('/blocked-neighbor').then(r=>r.text())", "--page", neighbor, "--controller", "intercept-proof", "--epoch", epoch]).await?;
        require(neighbor_effect["result"]["response"]["data"]["result"] == "server response", &neighbor_effect)?;
        let before = received.lock().await.clone();
        require(!before.iter().any(|path| ["/blocked-page", "/blocked-worker", "/blocked-frame", "/frame", "/worker.js"].contains(&path.as_str())) && before.contains(&"/blocked-xhr".into()) && before.contains(&"/blocked-neighbor".into()), &before)?;
        let mut disable = vec!["intercept", resource, "disable"]; disable.extend(shared);
        cli(&root, &disable).await?;
        let script = "Promise.all([new Promise(resolve=>{worker.onmessage=e=>resolve(e.data);worker.postMessage('again')}),new Promise(resolve=>{addEventListener('message',e=>resolve(e.data),{once:true});document.querySelector('iframe').contentWindow.postMessage('again','*')})])";
        let mut restore = vec!["eval", resource, script]; restore.extend(shared);
        let restored = cli(&root, &restore).await?;
        require(restored["result"]["response"]["data"]["result"] == json!(["server response", "server response"]), &restored)?;
        cli(&root, &enable).await?;
        cli(&root, &navigate).await?;
        let handoff = cli(&root, &["control", resource, "--controller", "human-proof"]).await?;
        let human_epoch = handoff["result"]["controller"]["epoch"].as_str().ok_or("handoff epoch missing")?;
        require(cli(&root, &disable).await.is_err(), "stale controller changed rules")?;
        let preserved = cli(&root, &["eval", resource, "fetch('/blocked-after-handoff').then(r=>r.text()).catch(()=>'blocked')", "--page", page, "--controller", "human-proof", "--epoch", human_epoch]).await?;
        require(preserved["result"]["response"]["data"]["result"] == "blocked", &preserved)?;
        let after = received.lock().await.clone();
        require(after.contains(&"/blocked-worker".into()) && after.contains(&"/blocked-frame".into()) && !after.contains(&"/blocked-after-handoff".into()), &after)?;
        cli(&root, &["tab-close", resource, "--page", page, "--controller", "human-proof", "--epoch", human_epoch]).await?;
        let neighbor_state = cli(&root, &["intercept", resource, "list", "--page", neighbor]).await?;
        require(neighbor_state["result"]["enabled"] == false, &neighbor_state)?;
        Ok(json!({"effects":effects["result"]["response"]["data"]["result"],"restored":restored["result"]["response"]["data"]["result"],"before":before,"after":after,"handoff":handoff}))
    }.await;
    println!("BROWSER_INTERCEPT_SCOPE_BEFORE_CLOSE root={} evidence={evidence:?}", root.display());
    let stopped = backend(&endpoint, "backend.shutdown", json!({"schemaVersion":2,"mode":"stop"})).await;
    let retired = timeout(Duration::from_secs(40), server).await;
    let _ = stop_http.send(());
    let http_retired = timeout(Duration::from_secs(10), http).await;
    println!("BROWSER_INTERCEPT_SCOPE root={} evidence={evidence:?} retired={retired:?} http={http_retired:?}", root.display());
    retired.unwrap().unwrap().unwrap();
    http_retired.unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    evidence.unwrap();
}
