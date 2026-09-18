use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires pinned Chromium, native engine, Node and installed React fixture dependencies"]
async fn failed_react_activation_rolls_back_and_main_page_profiling_leaves_child_frames_untouched()
{
    let (origin, stop, site) = site("development").await;
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<Value,String>=async {
        let created=cli(&root,&["create","--enable","react-devtools"]).await?;
        let resource=created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned();resources.push(resource.clone());
        let controlled=cli(&root,&["control",&resource,"--controller","react-owner"]).await?;
        let epoch=controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        action(&root,&resource,epoch,&["goto",&origin]).await?;
        action(&root,&resource,epoch,&["wait","function","window.reactFixtureReady === '19.2.7'"]).await?;
        action(&root,&resource,epoch,&["eval",r#"(() => {
            const hook=window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            const original=hook.onCommitFiberRoot;
            Object.defineProperty(hook,'onCommitFiberRoot',{configurable:true,get:()=>original,set(){throw new Error('fixture commit assignment rejected')}});
        })()"#]).await?;
        let rejected=action(&root,&resource,epoch,&["react","renders","start"]).await;
        let after_failure=action(&root,&resource,epoch,&["eval","({active:!!window.__AB_RENDERS_ACTIVE__,data:!!window.__AB_RENDERS__,fps:!!window.__AB_RENDERS_FPS__,original:window.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot===window.fixtureOriginalCommit})"]).await?;
        // A fresh document has a writable hook. Any leaked future-document
        // registration from the rejected start would now activate visibly.
        action(&root,&resource,epoch,&["reload"]).await?;
        action(&root,&resource,epoch,&["wait","function","window.reactFixtureReady === '19.2.7'"]).await?;
        let after_reload=action(&root,&resource,epoch,&["eval","!!window.__AB_RENDERS_ACTIVE__"]).await?;
        let tree=action(&root,&resource,epoch,&["react","tree"]).await?;
        let counter=data(&tree)["nodes"].as_array().ok_or("tree missing")?.iter().find(|node|node["name"]=="Counter").ok_or("counter missing")?["id"].to_string();
        action(&root,&resource,epoch,&["react","renders","start"]).await?;
        action(&root,&resource,epoch,&["click","#increment"]).await?;
        action(&root,&resource,epoch,&["eval","new Promise(resolve=>{const frame=document.createElement('iframe');frame.id='react-child';frame.onload=()=>resolve(true);frame.src='/child';document.body.append(frame)})"]).await?;
        action(&root,&resource,epoch,&["wait","function","document.querySelector('#react-child').contentWindow.reactFixtureReady === '19.2.7'"]).await?;
        let child=action(&root,&resource,epoch,&["eval","({mainActive:!!window.__AB_RENDERS_ACTIVE__,childActive:!!document.querySelector('#react-child').contentWindow.__AB_RENDERS_ACTIVE__,childCounter:document.querySelector('#react-child').contentDocument.querySelector('#increment').textContent})"]).await?;
        action(&root,&resource,epoch,&["frame","#react-child"]).await?;
        let selected_child=action(&root,&resource,epoch,&["eval","document.querySelector('#increment').textContent"]).await?;
        // Upstream React commands inspect the active Page's main document.
        // Selecting a child for DOM commands does not retarget React's IDs.
        let inspected=action(&root,&resource,epoch,&["react","inspect",&counter]).await?;
        action(&root,&resource,epoch,&["frame","main"]).await?;
        let stopped=action(&root,&resource,epoch,&["react","renders","stop"]).await?;
        let cleanup=action(&root,&resource,epoch,&["eval","({main:!!window.__AB_RENDERS_ACTIVE__,child:!!document.querySelector('#react-child').contentWindow.__AB_RENDERS_ACTIVE__})"]).await?;
        Ok(json!({"rejected":rejected.is_err(),"afterFailure":data(&after_failure)["result"],"activeAfterReload":data(&after_reload)["result"],"child":data(&child)["result"],"selectedChild":data(&selected_child)["result"],"inspected":data(&inspected),"stopped":data(&stopped),"cleanup":data(&cleanup)["result"]}))
    }.await;
    let mut closed = Vec::new();
    for resource in resources {
        closed.push(cli(&root, &["close", &resource]).await);
    }
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let server_closed = timeout(Duration::from_secs(40), server).await;
    let _ = stop.send(());
    site.await.unwrap();
    println!(
        "BROWSER_REACT_FAILURE root={} evidence={evidence:?} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok));
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    println!("BROWSER_REACT_FAILURE_JSON {evidence}");
    assert_eq!(evidence["rejected"], true);
    assert_eq!(
        evidence["afterFailure"],
        json!({"active":false,"data":false,"fps":false,"original":true})
    );
    assert_eq!(evidence["activeAfterReload"], false);
    assert_eq!(
        evidence["child"],
        json!({"mainActive":true,"childActive":false,"childCounter":"한글 counter: 0"})
    );
    assert_eq!(evidence["selectedChild"], "한글 counter: 0");
    assert!(
        evidence["inspected"]["text"]
            .as_str()
            .unwrap()
            .contains("State: 1")
    );
    assert_eq!(evidence["cleanup"], json!({"main":false,"child":false}));
}
