use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn actual_cli_console_reads_and_authorized_clear_share_host_history() {
    let (root, endpoint, server) = fixture().await;
    let evidence: Result<_,String> = async {
        let created = cli(&root,&["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("fixture resource missing")?;
        let shown = cli(&root,&["show",resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("fixture page missing")?;
        let controlled = cli(&root,&["control",resource,"--controller","console-proof"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("fixture epoch missing")?;
        let shared = ["--page",page,"--controller","console-proof","--epoch",epoch];
        let mut setup = vec!["eval",resource,"console.log('한글 콘솔',42,true,null,undefined,123n);console.warn('경고');console.error('오류');setTimeout(()=>{throw new Error('비동기 오류')},10);true"];
        setup.extend(shared);
        cli(&root,&setup).await?;
        let before = backend(&endpoint,"browser.resource",json!({"kind":"control_state","resource_id":resource})).await;
        let logs = timeout(Duration::from_secs(3),async {
            loop {
                let logs = cli(&root,&["console",resource,"--page",page]).await?;
                if logs["result"]["entries"].as_array().is_some_and(|entries| entries.iter().any(|entry|entry["text"].as_str().is_some_and(|text|text.contains("비동기 오류")))) { return Ok::<_,String>(logs); }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.map_err(|_|"fixture console error missing".to_string())??;
        let limited = cli(&root,&["console",resource,"--page",page,"--limit","1"]).await?;
        let after = backend(&endpoint,"browser.resource",json!({"kind":"control_state","resource_id":resource})).await;
        let denied = cli(&root,&["console",resource,"clear","--page",page]).await;
        let mut tail = vec!["eval",resource,"for(let i=0;i<150;i++)console.log('ordinary tail '+i);true"];
        tail.extend(shared);
        cli(&root,&tail).await?;
        let errors = cli(&root,&["errors",resource,"--page",page]).await?;
        let native_errors = cli(&root,&["exec",resource,"--command","errors","--page",page]).await?;
        let mixed = cli(&root,&["console",resource,"--page",page,"--limit","1000"]).await?;
        let mut clear_errors = vec!["exec",resource,"--command","errors --clear","--idempotency-key","errors-clear-once"];
        clear_errors.extend(shared);
        let errors_cleared = cli(&root,&clear_errors).await?;
        let no_errors = cli(&root,&["errors",resource,"--page",page]).await?;
        let ordinary = cli(&root,&["console",resource,"--page",page,"--limit","1000"]).await?;
        let mut clear = vec!["console",resource,"clear","--idempotency-key","console-clear-once"];
        clear.extend(shared);
        let cleared = cli(&root,&clear).await?;
        let empty = cli(&root,&["console",resource,"--page",page]).await?;
        let mut later = vec!["eval",resource,"console.info('after clear');true"];
        later.extend(shared);
        cli(&root,&later).await?;
        let replay = cli(&root,&clear).await;
        let remaining = cli(&root,&["console",resource,"--page",page]).await?;
        Ok((logs,limited,before,after,denied,cleared,empty,replay,remaining,(errors,native_errors,mixed,errors_cleared,no_errors,ordinary)))
    }.await;
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let retired = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_CONSOLE_CLI root={} evidence={evidence:?} stopped={stopped:?} retired={retired:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    let (logs, limited, before, after, denied, cleared, empty, replay, remaining, errors_evidence) =
        evidence.unwrap();
    let (errors, native_errors, mixed, errors_cleared, no_errors, ordinary) = errors_evidence;
    let mixed_entries = mixed["result"]["entries"].as_array().unwrap();
    assert!(mixed_entries.len() > 150);
    let exceptions: Vec<_> = mixed_entries
        .iter()
        .filter(|entry| entry["kind"] == "exception")
        .collect();
    assert!(!exceptions.is_empty());
    assert_eq!(errors["result"]["entries"], json!(exceptions));
    assert_eq!(native_errors["result"]["entries"], json!(exceptions));
    assert_eq!(
        errors_cleared["result"]["response"]["data"]["cleared"],
        true
    );
    assert_eq!(no_errors["result"]["entries"], json!([]));
    assert_eq!(
        ordinary["result"]["entries"],
        json!(
            mixed_entries
                .iter()
                .filter(|entry| entry["kind"] == "console")
                .collect::<Vec<_>>()
        )
    );
    let entries = logs["result"]["entries"].as_array().unwrap();
    for text in ["한글 콘솔 42 true null undefined 123n", "경고", "오류"] {
        assert!(
            entries.iter().any(|entry| entry["text"] == text),
            "missing {text}: {logs}"
        );
    }
    assert!(entries.iter().any(|entry| {
        entry["kind"] == "exception"
            && entry["text"]
                .as_str()
                .is_some_and(|text| text.contains("비동기 오류"))
    }));
    assert_eq!(limited["result"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(limited["result"]["truncated"], true);
    assert_eq!(before["result"], after["result"]);
    assert!(denied.unwrap_err().contains("browser_controller_required"));
    assert_eq!(cleared["result"]["response"]["data"]["cleared"], true);
    assert_eq!(empty["result"]["entries"], json!([]));
    assert!(replay.unwrap_err().contains("browser_operation_conflict"));
    assert_eq!(remaining["result"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["result"]["entries"][0]["text"], "after clear");
}
