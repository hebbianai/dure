use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    endpoint: &ControlPlaneEndpoint,
    origins: (&str, &str),
    isolated: (&str, &str),
) -> Result<(), String> {
    let (origin, other_origin) = origins;
    let (isolated_resource, isolated_page) = isolated;
    let file = home.join("portable-state.json");
    let cookie = json!({"name":"state-hooks","value":"on","domain":"127.0.0.1","path":"/","expires":-1,"size":13,"httpOnly":true,"secure":false,"session":true});
    let state = json!({"cookies":[cookie.clone()],"origins":[
        {"origin":origin,"localStorage":[{"name":"state-local","value":"첫 번째"}],"sessionStorage":[{"name":"state-session","value":"탭 데이터"}]},
        {"origin":other_origin,"localStorage":[{"name":"state-local","value":"두 번째"}],"sessionStorage":[{"name":"state-session","value":"다른 사이트"}]}
    ]});
    let mut invalid = state.clone();
    invalid["origins"][1]["origin"] = "file:///private".into();
    tokio::fs::write(&file, serde_json::to_vec(&invalid).unwrap())
        .await
        .map_err(|error| error.to_string())?;
    let rejected = write(
        home,
        resource,
        page,
        epoch,
        "state",
        &["load", file.to_str().unwrap()],
    )
    .await;
    require(
        rejected
            .as_ref()
            .is_err_and(|error| error.contains("browser_state_origin_invalid")),
        &rejected,
    )?;
    require(
        read(home, resource, page, "cookie", &["get"]).await?["cookies"] == json!([]),
        "invalid file set its earlier cookie",
    )?;
    require(
        read(
            home,
            resource,
            page,
            "storage",
            &["local", "get", "state-local"],
        )
        .await?["value"]
            .is_null(),
        "invalid file partially wrote storage",
    )?;

    let bytes = serde_json::to_vec(&state).unwrap();
    tokio::fs::write(&file, &bytes)
        .await
        .map_err(|error| error.to_string())?;
    let loaded = write(
        home,
        resource,
        page,
        epoch,
        "exec",
        &["--command", &format!("state load '{}'", file.display())],
    )
    .await?;
    require(
        loaded["result"]["response"]["data"]["origins_loaded"] == 2,
        &loaded,
    )?;
    require(
        read(
            home,
            resource,
            page,
            "storage",
            &["local", "get", "state-local"],
        )
        .await?["value"]
            == "두 번째",
        "second origin local storage missing",
    )?;
    require(
        read(
            home,
            resource,
            page,
            "storage",
            &["session", "get", "state-session"],
        )
        .await?["value"]
            == "다른 사이트",
        "second origin session storage missing",
    )?;
    write(home, resource, page, epoch, "goto", &[origin]).await?;
    require(
        read(
            home,
            resource,
            page,
            "storage",
            &["local", "get", "state-local"],
        )
        .await?["value"]
            == "첫 번째",
        "first origin local storage missing",
    )?;
    require(
        read(
            home,
            resource,
            page,
            "storage",
            &["session", "get", "state-session"],
        )
        .await?["value"]
            == "탭 데이터",
        "first origin session storage missing",
    )?;
    require(
        read(
            home,
            resource,
            page,
            "storage",
            &["local", "get", "origin-proof"],
        )
        .await?["value"]
            == "local origin value",
        "restore cleared unrelated keys",
    )?;
    require(
        eval(home, resource, page, epoch, "stateReads").await? == 0,
        "state load invoked page storage hooks",
    )?;
    require(
        read(
            home,
            isolated_resource,
            isolated_page,
            "storage",
            &["local", "get", "state-local"],
        )
        .await?["value"]
            .is_null(),
        "state load escaped its profile",
    )?;

    // Stage the same bytes through the actual backend, drop only its action
    // reply, then recover the journal without repeating navigation or writes.
    let shown = cli(home, &["show", resource]).await?;
    let control = &shown["result"]["control"];
    let uploaded = backend(endpoint,"browser.resource",json!({"kind":"upload_chunk","resource":control["resource"],"chunk":{"file":{"name":"receipt-state.json","size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))},"offset":0,"base64":STANDARD.encode(&bytes)}})).await;
    let id = uploaded["result"]["result"]["id"]
        .as_str()
        .ok_or_else(|| format!("state upload missing: {uploaded}"))?;
    let body = json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":control["current_page"],"operation_id":"state-load-lost-response","command_sequence":control["next_command_sequence"]},"action":{"kind":"state_load","file":id}});
    let request = envelope(endpoint, "browser.resource", body.clone());
    let mut socket = UnixStream::connect(&endpoint.socket_path)
        .await
        .map_err(|error| error.to_string())?;
    socket
        .write_all(format!("{request}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    drop(socket);
    timeout(Duration::from_secs(20), async {
        loop {
            let receipt = cli(home, &["receipt", "state-load-lost-response"]).await?;
            match receipt["receipt"]["state"].as_str() {
                Some("succeeded") => return Ok::<_, String>(()),
                Some("failed") => return Err(format!("state restore failed: {receipt}")),
                _ => sleep(Duration::from_millis(20)).await,
            }
        }
    })
    .await
    .map_err(|_| "state receipt timeout")??;
    write(
        home,
        resource,
        page,
        epoch,
        "storage",
        &["local", "set", "state-local", "newer"],
    )
    .await?;
    let recovered = backend(endpoint, "browser.resource", body).await;
    require(recovered["result"]["replayed"] == true, &recovered)?;
    require(
        read(
            home,
            resource,
            page,
            "storage",
            &["local", "get", "state-local"],
        )
        .await?["value"]
            == "newer",
        "state receipt recovery repeated writes",
    )?;

    let redirected = json!({"cookies":[{"name":"state-redirect","value":"on","domain":"localhost","path":"/"}],"origins":[{"origin":other_origin,"localStorage":[{"name":"redirect-secret","value":"must stay private"}]}]});
    tokio::fs::write(&file, serde_json::to_vec(&redirected).unwrap())
        .await
        .map_err(|error| error.to_string())?;
    let rejected = write(
        home,
        resource,
        page,
        epoch,
        "state",
        &["load", file.to_str().unwrap()],
    )
    .await;
    require(
        rejected
            .as_ref()
            .is_err_and(|error| error.contains("browser_state_origin_changed")),
        &rejected,
    )?;
    require(
        read(
            home,
            resource,
            page,
            "storage",
            &["local", "get", "redirect-secret"],
        )
        .await?["value"]
            .is_null(),
        "redirect received another origin's secret",
    )?;
    println!(
        "BROWSER_STATE_LOAD_EVIDENCE {}",
        json!({"multiOrigin":true,"sessionStorage":true,"literalKorean":true,"invalidFileNoMutation":true,"pageHooksNotInvoked":true,"otherProfilePreserved":true,"unrelatedKeysPreserved":true,"lostReplyRecoveredWithoutReplay":true,"redirectStorageRejected":true})
    );
    Ok(())
}
