use super::{backend, cli, envelope, fixture_with_installation, serve_fixture};
use serde_json::{Value, json};
use tokio::{
    io::AsyncWriteExt,
    net::UnixStream,
    time::{Duration, timeout},
};

#[path = "profiles/deletion.rs"]
mod deletion;
#[path = "profiles/selection.rs"]
mod selection;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("profile catalog: {evidence:?}"))
    }
}

const CREATE: &[&str] = &[
    "tab",
    "profile",
    "create",
    "--label",
    "한글 작업",
    "--scope",
    "imported",
    "--no-ua-spoof",
    "--idempotency-key",
    "profile-cli-once",
];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn profile_catalog_cli_survives_response_loss_and_backend_replacement_without_engine() {
    let (root, endpoint, server) = fixture_with_installation(None).await;
    let evidence: Result<Value, String> = async {
        let initial = cli(&root, &["tab", "profile", "list"]).await?;
        require(initial["result"]["profiles"] == json!([{
            "profile":{"profileId":"default","label":"Default","scope":"default","userAgentMode":"clean"},
            "state":"active"
        }]), &initial)?;
        let created = cli(&root, CREATE).await?;
        let profile = &created["result"]["profile"];
        require(profile["profile"]["label"] == "한글 작업" && profile["profile"]["scope"] == "imported"
            && profile["profile"]["userAgentMode"] == "native" && profile["state"] == "active", &created)?;
        let repeated = cli(&root, CREATE).await?;
        require(repeated["replayed"] == true && repeated["result"] == created["result"], &repeated)?;
        let mut conflict = CREATE.to_vec();
        conflict[4] = "different";
        require(matches!(cli(&root, &conflict).await, Err(error) if error.contains("browser_operation_conflict")), "different metadata reused the operation")?;

        for (index, extra) in [
            json!({"scope":"default"}), json!({"label":""}),
            json!({"label":"x".repeat(513)}), json!({"label":"line\nbreak"}),
        ].into_iter().enumerate() {
            let mut body = json!({"kind":"profile_create","operation_id":format!("profile-invalid-{index}"),"label":"valid","scope":"isolated"});
            body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            let invalid = backend(&endpoint, "browser.resource", body).await;
            require(invalid["error"]["code"] == "browser_profile_invalid", &invalid)?;
        }
        let mut lost = UnixStream::connect(&endpoint.socket_path).await.map_err(|e|e.to_string())?;
        let body = json!({"kind":"profile_create","operation_id":"profile-lost-client","label":"lost client"});
        lost.write_all(format!("{}\n", envelope(&endpoint, "browser.resource", body.clone())).as_bytes()).await.map_err(|e|e.to_string())?;
        drop(lost);
        let recovered = timeout(Duration::from_secs(10), async {
            loop {
                let receipt = cli(&root, &["receipt", "profile-lost-client"]).await?;
                match receipt["receipt"]["state"].as_str() {
                    Some("succeeded") => return Ok::<_, String>(receipt),
                    Some("failed") => return Err(format!("lost request: {receipt}")),
                    _ => tokio::time::sleep(Duration::from_millis(25)).await,
                }
            }
        }).await.map_err(|_|"profile receipt deadline")??;
        require(recovered["result"]["profile"]["profile"]["scope"] == "isolated"
            && recovered["result"]["profile"]["profile"]["userAgentMode"] == "clean", &recovered)?;
        let repeated_loss = backend(&endpoint, "browser.resource", body.clone()).await;
        require(repeated_loss["result"]["replayed"] == true
            && repeated_loss["result"]["result"] == recovered["result"], &repeated_loss)?;
        let listed = cli(&root, &["tab", "profile", "list"]).await?;
        require(listed["result"]["profiles"].as_array().map(Vec::len) == Some(3), &listed)?;
        Ok(json!({"created":created,"lost":recovered,"listed":listed,"lostRequest":body}))
    }.await;
    backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    timeout(Duration::from_secs(40), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let evidence = evidence.unwrap();

    let (replacement, server) = serve_fixture(&root, Some(endpoint.generation.clone())).await;
    let reopened: Result<(), String> = async {
        // An explicit stop/restart reopens the persisted descriptor generation.
        // The old service has exited; both the service and store below are new.
        let listed = cli(&root, &["tab", "profile", "list"]).await?;
        require(listed["result"] == evidence["listed"]["result"], &listed)?;
        let repeated = cli(&root, CREATE).await?;
        require(
            repeated["replayed"] == true && repeated["result"] == evidence["created"]["result"],
            &repeated,
        )?;
        let recovered = cli(&root, &["receipt", "profile-lost-client"]).await?;
        require(
            recovered["result"] == evidence["lost"]["result"],
            &recovered,
        )?;
        let resources = cli(&root, &["list", "--workspace", "workspace-browser"]).await?;
        require(resources["result"]["resources"] == json!([]), &resources)?;
        require(
            !root.join("browser/installation.json").exists(),
            "fixture unexpectedly installed an engine",
        )?;
        Ok(())
    }
    .await;
    backend(
        &replacement,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    timeout(Duration::from_secs(40), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    reopened.unwrap();
    println!(
        "BROWSER_PROFILE_CATALOG_CLI {}",
        json!({"root":root,"evidence":evidence,"serviceReopened":true,"sourceGeneration":endpoint.generation,"reopenedGeneration":replacement.generation,"engineInstalled":false})
    );
}
