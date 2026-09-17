use super::super::*;
use super::{http_fixture, require};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn interception_request_cancellation_preserves_observation_and_later_traffic() {
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
        let mut enable = vec!["intercept", resource, "enable"]; enable.extend(shared);
        cli(&root, &enable).await?;
        let script = "Promise.all(Array.from({length:64},(_,i)=>{const controller=new AbortController();const result=fetch('/cancel-'+i,{signal:controller.signal}).then(r=>r.text()).catch(e=>e.name);setTimeout(()=>controller.abort(),0);return result}))";
        let mut cancel = vec!["eval", resource, script]; cancel.extend(shared);
        let cancelled = cli(&root, &cancel).await?;
        require(cancelled["result"]["response"]["data"]["result"].as_array().is_some_and(|results| results.len() == 64 && results.iter().any(|result| result == "AbortError")), &cancelled)?;
        let state = cli(&root, &["intercept", resource, "list", "--page", page]).await?;
        require(state["result"]["available"] == true, &state)?;
        let mut later = vec!["eval", resource, "fetch('/later').then(r=>r.text())"]; later.extend(shared);
        let passed = cli(&root, &later).await?;
        require(passed["result"]["response"]["data"]["result"] == "server response", &passed)?;
        let history = cli(&root, &["intercept", resource, "list", "--page", page]).await?;
        require(history["result"]["requests"].as_array().is_some_and(|requests| requests.iter().any(|request| request["url"].as_str().is_some_and(|url| url.ends_with("/later")) && request["state"] == "finished")), &history)?;
        require(received.lock().await.contains(&"/later".into()), "later request did not reach server")?;
        Ok(json!({"cancelled":cancelled["result"]["response"]["data"]["result"],"history":history}))
    }.await;
    println!("BROWSER_INTERCEPTION_CANCEL_BEFORE_CLOSE root={} evidence={evidence:?}", root.display());
    let stopped = backend(&endpoint, "backend.shutdown", json!({"schemaVersion":2,"mode":"stop"})).await;
    let retired = timeout(Duration::from_secs(40), server).await;
    let _ = stop_http.send(());
    let http_retired = timeout(Duration::from_secs(10), http).await;
    println!("BROWSER_INTERCEPTION_CANCEL root={} evidence={evidence:?} retired={retired:?} http={http_retired:?}", root.display());
    retired.unwrap().unwrap().unwrap();
    http_retired.unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    evidence.unwrap();
}
