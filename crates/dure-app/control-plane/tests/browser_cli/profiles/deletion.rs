use super::*;
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_delete_resumes_after_backend_replacement_without_installing_engine() {
    let (root, endpoint, server) = fixture_with_installation(None).await;
    let original: Result<_, String> = async {
        let created = cli(&root, &["tab", "profile", "create", "--label", "삭제 복구"]).await?;
        let id = created["result"]["profile"]["profile"]["profileId"]
            .as_str()
            .ok_or("profile missing")?
            .to_owned();
        let parent = root.join("backend/browser-profiles");
        fs::create_dir(&parent).map_err(|e| e.to_string())?;
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let profile = parent.join(format!("{:x}", Sha256::digest(id.as_bytes())));
        fs::create_dir(&profile).map_err(|e| e.to_string())?;
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let data = profile.join("stored-data");
        fs::write(&data, "중단 후 보존").map_err(|e| e.to_string())?;
        let claim = profile.join("native-claim.json");
        let bytes = serde_json::to_vec(
            &json!({"schemaVersion":1,"profileId":id,"instanceId":"fixture-no-child"}),
        )
        .unwrap();
        fs::write(&claim, &bytes).map_err(|e| e.to_string())?;
        fs::set_permissions(&claim, fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        let failed = cli(
            &root,
            &[
                "tab",
                "profile",
                "delete",
                "--profile",
                &id,
                "--idempotency-key",
                "delete-unconfirmed",
            ],
        )
        .await;
        require(
            matches!(&failed,Err(error) if error.contains("browser_profile_exit_unconfirmed")),
            &failed,
        )?;
        let listed = cli(&root, &["tab", "profile", "list"]).await?;
        require(
            listed["result"]["profiles"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["profile"]["profileId"] == id && p["state"] == "retiring"),
            &listed,
        )?;
        require(fs::read_to_string(&data).unwrap() == "중단 후 보존", &data)?;
        require(fs::read(&claim).unwrap() == bytes, &claim)?;
        Ok((id, profile, bytes))
    }
    .await;
    let shutdown = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let stopped = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_PROFILE_DELETE_NO_ENGINE_ORIGINAL root={} evidence={original:?} shutdown={shutdown:?} stopped={stopped:?}",
        root.display()
    );
    assert!(matches!(stopped, Ok(Ok(Ok(())))), "{stopped:?}");
    let (id, profile, bytes) = original.unwrap();

    let (replacement, server) = serve_fixture(&root, Some(endpoint.generation.clone())).await;
    let resumed: Result<_, String> = async {
        let listed = cli(&root, &["tab","profile","list"]).await?;
        require(listed["result"]["profiles"].as_array().unwrap().iter().any(|p|p["profile"]["profileId"]==id && p["state"]=="retiring"),&listed)?;
        let replay = cli(&root, &["tab","profile","delete","--profile",&id,"--idempotency-key","delete-unconfirmed"]).await.err().ok_or("failed replay unexpectedly succeeded")?;
        let replay: Value = serde_json::from_str(replay.strip_prefix("CLI tab rejected: ").ok_or("failed replay payload missing")?).map_err(|e|e.to_string())?;
        require(replay["replayed"]==true && replay["receipt"]["state"]=="failed",&replay)?;
        require(replay["error"]["code"]=="browser_profile_exit_unconfirmed",&replay)?;
        require(fs::read(profile.join("native-claim.json")).unwrap()==bytes,&profile)?;
        // Only the fixture's exact fake claim is removed; no process was launched.
        fs::remove_file(profile.join("native-claim.json")).map_err(|e|e.to_string())?;
        let deleted = cli(&root, &["tab","profile","delete","--profile",&id,"--idempotency-key","delete-resumed"]).await?;
        require(deleted["result"]["deleted"]==true,&deleted)?;
        require(!profile.join("stored-data").exists(),&profile)?;
        let repeated = cli(&root, &["tab","profile","delete","--profile",&id,"--idempotency-key","delete-resumed"]).await?;
        require(repeated["replayed"]==true && repeated["result"]==deleted["result"],&repeated)?;
        let again = cli(&root, &["tab","profile","delete","--profile",&id]).await?;
        require(again["result"]["deleted"]==false,&again)?;
        let unused = cli(&root, &["tab","profile","create","--label","사용 전 삭제"]).await?;
        let unused = unused["result"]["profile"]["profile"]["profileId"].as_str().ok_or("unused profile missing")?;
        let unused = cli(&root, &["tab","profile","delete","--profile",unused]).await?;
        require(unused["result"]["deleted"]==true,&unused)?;
        for protected in ["default","missing"] {
            let kept = cli(&root, &["tab","profile","delete","--profile",protected]).await?;
            require(kept["result"]["deleted"]==false,&kept)?;
        }
        let catalog = cli(&root, &["tab","profile","list"]).await?;
        require(catalog["result"]["profiles"].as_array().unwrap().len()==1 && catalog["result"]["profiles"][0]["profile"]["profileId"]=="default",&catalog)?;
        require(!root.join("browser/installation.json").exists(),"engine unexpectedly installed")?;
        let marker:Value=serde_json::from_slice(&fs::read(profile.join("native-claim.json")).unwrap()).unwrap();
        require(marker==json!({"schemaVersion":1,"kind":"storage_retirement","profileId":id}),&marker)?;
        Ok(json!({"listed":listed,"failedReplay":replay,"deleted":deleted,"replayed":repeated,"again":again,"unused":unused,"catalog":catalog,"marker":marker}))
    }.await;
    let shutdown = backend(
        &replacement,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let stopped = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_PROFILE_DELETE_NO_ENGINE_RESUMED root={} evidence={resumed:?} shutdown={shutdown:?} stopped={stopped:?}",
        root.display()
    );
    assert!(matches!(stopped, Ok(Ok(Ok(())))), "{stopped:?}");
    resumed.unwrap();
}
