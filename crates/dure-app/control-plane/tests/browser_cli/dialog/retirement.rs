use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn backend_shutdown_retires_a_disconnected_operation_waiting_for_a_dialog() {
    let (root, endpoint, mut server) = fixture().await;
    let setup: Result<_, String> = async {
        let created = cli(&root, &["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"]
            .as_str().ok_or("resource missing")?;
        cli(&root, &["control", resource, "--controller", "agent-proof"]).await?;
        let shown = cli(&root, &["show", resource]).await?;
        let view = &shown["result"];
        let mut observer = Observer::connect(&root).await?;
        let mut disconnected = UnixStream::connect(&endpoint.socket_path).await.map_err(|e|e.to_string())?;
        let request = envelope(&endpoint, "browser.resource", json!({
            "kind":"action", "caller":"agent-proof",
            "authority":{"lease":view["control"]["controller"],"page":view["pages"][0]["page"],
                "operation_id":"retire-pending-dialog","command_sequence":view["control"]["next_command_sequence"]},
            "action":{"kind":"evaluate","script":"window.answer=prompt('Retire pending operation');answer"}
        }));
        disconnected.write_all(format!("{request}\n").as_bytes()).await.map_err(|e|e.to_string())?;
        drop(disconnected);
        let opened = timeout(Duration::from_secs(3), async {
            loop {
                if observer.next().await?["method"] == "Page.javascriptDialogOpening" {
                    return Ok::<_, String>(());
                }
            }
        }).await;
        Ok((observer, opened))
    }.await;
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let first = timeout(Duration::from_secs(15), &mut server).await;
    // On RED only, the independent fixture releases its exact prompt so the
    // blocked receipt and server can retire before any assertion panics.
    let cleanup = match &setup {
        Ok(_) if first.is_ok() => None,
        _ => Some(()),
    };
    let (opened, cleanup_reply) = match setup {
        Ok((mut observer, opened)) => {
            let reply = if cleanup.is_some() {
                Some(
                    observer
                        .request("Page.handleJavaScriptDialog", json!({"accept":false}))
                        .await,
                )
            } else {
                None
            };
            let _ = observer.socket.close(None).await;
            (
                opened
                    .map_err(|_| "fixture dialog open timeout".to_string())
                    .and_then(|r| r),
                reply,
            )
        }
        Err(error) => (Err(error), None),
    };
    let (completed_in_time, retired) = match first {
        Ok(result) => (true, Ok(result)),
        Err(_) => (false, timeout(Duration::from_secs(40), &mut server).await),
    };
    let store = SqliteDomainStore::open(&root.join("backend/application-state.sqlite3"))
        .await
        .unwrap();
    let receipt = store
        .operation_receipt(&OperationIdV1::new("retire-pending-dialog").unwrap())
        .await;
    store.close().await;
    println!(
        "BROWSER_DIALOG_RETIREMENT root={} opened={opened:?} completed_in_time={completed_in_time} cleanup={cleanup_reply:?} retired={retired:?} receipt={receipt:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    opened.unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    assert!(
        completed_in_time,
        "shutdown waited for an unanswered dialog"
    );
    assert!(
        cleanup_reply.is_none(),
        "fixture had to answer the product's dialog"
    );
    let receipt = serde_json::to_value(receipt.unwrap().unwrap()).unwrap();
    assert_eq!(receipt["state"], "failed");
}
