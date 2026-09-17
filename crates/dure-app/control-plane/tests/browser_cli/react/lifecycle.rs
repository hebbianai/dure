use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires pinned Chromium, native engine, Node and installed React fixture dependencies"]
async fn retained_react_start_survives_response_loss_handoff_and_reload_without_affecting_a_peer() {
    let (origin, stop, site) = site("development").await;
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<Value,String> = async {
        let mut owned = Vec::new();
        for _ in 0..2 {
            let created = cli(&root, &["create","--workspace","workspace-browser","--enable","react-devtools"]).await?;
            let id = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned();
            resources.push(id.clone());
            let controlled = cli(&root, &["control",&id,"--controller","react-owner"]).await?;
            let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?.to_owned();
            action(&root,&id,&epoch,&["goto",&origin]).await?;
            action(&root,&id,&epoch,&["wait","function","window.reactFixtureReady === '19.2.7'"]).await?;
            owned.push((id,epoch));
        }
        let (resource,epoch)=&owned[0];
        let shown=cli(&root,&["show",resource]).await?;
        let control=&shown["result"]["control"];
        let body=json!({"kind":"action","caller":"react-owner","authority":{"lease":control["controller"],"page":control["current_page"],"operation_id":"react-start-lost","command_sequence":control["next_command_sequence"]},"action":{"kind":"react","action":{"kind":"renders_start"}}});
        let request=envelope(&endpoint,"browser.resource",body.clone());
        let mut socket=UnixStream::connect(&endpoint.socket_path).await.map_err(|e|e.to_string())?;
        socket.write_all(format!("{request}\n").as_bytes()).await.map_err(|e|e.to_string())?;
        drop(socket);
        let receipt=timeout(Duration::from_secs(15),async {
            loop {
                let receipt=backend(&endpoint,"browser.resource",json!({"kind":"receipt","operation_id":"react-start-lost"})).await;
                if ["succeeded","failed"].iter().any(|s|receipt["result"]["receipt"]["state"]==*s) {return receipt;}
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.map_err(|_|"start receipt timeout")?;
        let replay=backend(&endpoint,"browser.resource",body).await;
        action(&root,resource,epoch,&["reload"]).await?;
        action(&root,resource,epoch,&["wait","function","window.reactFixtureReady === '19.2.7'"]).await?;
        let active=action(&root,resource,epoch,&["eval","!!window.__AB_RENDERS_ACTIVE__"]).await?;
        action(&root,resource,epoch,&["click","#increment"]).await?;
        let peer=action(&root,&owned[1].0,&owned[1].1,&["eval","({active:!!window.__AB_RENDERS_ACTIVE__,loads:Number(sessionStorage.loads),counter:document.querySelector('#increment').textContent})"]).await?;
        let transferred=cli(&root,&["control",resource,"--controller","react-successor"]).await?;
        let successor=transferred["result"]["controller"]["epoch"].as_str().ok_or("successor epoch missing")?;
        let stale=action(&root,resource,epoch,&["react","renders","stop"]).await;
        let stopped=cli(&root,&["react",resource,"renders","stop","--controller","react-successor","--epoch",successor]).await?;
        cli(&root,&["reload",resource,"--controller","react-successor","--epoch",successor]).await?;
        let cleaned=cli(&root,&["eval",resource,"!!window.__AB_RENDERS_ACTIVE__","--controller","react-successor","--epoch",successor]).await?;
        Ok(json!({"receipt":receipt["result"],"replay":replay["result"],"activeAfterReload":data(&active)["result"],"peer":data(&peer)["result"],"oldControllerRejected":stale.is_err(),"stopped":data(&stopped),"activeAfterStopReload":data(&cleaned)["result"]}))
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
        "BROWSER_REACT_LIFECYCLE root={} evidence={evidence:?} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok));
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    assert_eq!(evidence["receipt"]["receipt"]["state"], "succeeded");
    assert_eq!(evidence["replay"]["replayed"], true);
    assert_eq!(evidence["activeAfterReload"], true);
    assert_eq!(
        evidence["peer"],
        json!({"active":false,"loads":1,"counter":"한글 counter: 0"})
    );
    assert_eq!(evidence["oldControllerRejected"], true);
    assert!(
        evidence["stopped"]["components"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "Counter")
    );
    assert_eq!(evidence["activeAfterStopReload"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires pinned Chromium, native engine, Node and installed React fixture dependencies"]
async fn actual_profiling_react_hydration_is_measured_without_manual_timestamp_events() {
    let (origin, stop, site) = site("production").await;
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<Value, String> = async {
        let created = cli(
            &root,
            &[
                "create",
                "--workspace",
                "workspace-browser",
                "--enable",
                "react-devtools",
            ],
        )
        .await?;
        let resource = created["result"]["control"]["resource"]["resource_id"]
            .as_str()
            .ok_or("resource missing")?
            .to_owned();
        resources.push(resource.clone());
        let controlled = cli(
            &root,
            &["control", &resource, "--controller", "react-owner"],
        )
        .await?;
        let epoch = controlled["result"]["controller"]["epoch"]
            .as_str()
            .ok_or("epoch missing")?;
        action(&root, &resource, epoch, &["goto", &origin]).await?;
        let measured = action(&root, &resource, epoch, &["vitals"]).await?;
        let ready = action(
            &root,
            &resource,
            epoch,
            &["eval", "window.reactFixtureReady"],
        )
        .await?;
        Ok(json!({"measurement":data(&measured),"reactVersion":data(&ready)["result"]}))
    }
    .await;
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
        "BROWSER_REACT_HYDRATION root={} evidence={evidence:?} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok));
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    assert_eq!(evidence["reactVersion"], "19.2.7");
    assert!(
        evidence["measurement"]["hydration"]["duration"]
            .as_f64()
            .is_some_and(|duration| duration > 0.0)
    );
    assert!(
        evidence["measurement"]["hydratedComponents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "Counter")
    );
}
