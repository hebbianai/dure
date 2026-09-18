use super::*;
use std::path::PathBuf;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("browser installation: {evidence:?}"))
    }
}

async fn install(home: &Path, materials: &Path) -> Result<Value, String> {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/install-browser-runtime.mjs");
    let output = timeout(
        Duration::from_secs(60),
        Command::new("node")
            .arg(script)
            .arg("--home")
            .arg(home)
            .arg("--engine")
            .arg(std::env::var("DURE_BROWSER_TEST_BINARY").unwrap())
            .arg("--chromium")
            .arg(std::env::var("DURE_BROWSER_TEST_CHROMIUM_ROOT").unwrap())
            .arg("--chromium-executable")
            .arg(std::env::var("DURE_BROWSER_TEST_CHROMIUM_RELATIVE").unwrap())
            .arg("--materials")
            .arg(materials)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "installer deadline")?
    .map_err(|error| error.to_string())?;
    require(
        output.status.success(),
        String::from_utf8_lossy(&output.stderr),
    )?;
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

async fn evaluate(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    script: &str,
) -> Result<Value, String> {
    let result = cli(
        home,
        &[
            "eval",
            resource,
            "--page",
            page,
            "--controller",
            "agent-installation",
            "--epoch",
            epoch,
            "--",
            script,
        ],
    )
    .await?;
    require(result["result"]["response"]["success"] == true, &result)?;
    Ok(result["result"]["response"]["data"]["result"].clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned engine, explicit Chromium package, notice/source material and Node"]
async fn installed_generations_serve_real_cli_and_preserve_running_pages_during_update() {
    let materials = PathBuf::from(std::env::var("DURE_BROWSER_TEST_MATERIALS").unwrap());
    let (root, endpoint, server) = fixture_with_installation(None).await;
    let mut owned = Vec::new();
    let evidence: Result<Value,String> = async {
        let before = cli(&root, &["create"]).await;
        require(matches!(&before,Err(error) if error.contains("browser_engine_not_installed")), &before)?;
        let first_install = install(&root, &materials).await?;
        let created = cli(&root, &["create"]).await?;
        let first = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned();
        owned.push(first.clone());
        let shown = cli(&root, &["show",&first]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let control = cli(&root, &["control",&first,"--controller","agent-installation"]).await?;
        let epoch = control["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        evaluate(&root,&first,page,epoch,"document.body.innerHTML='<input id=name>';window.installationInstance=Date.now()+':'+Math.random()" ).await?;
        let fill = cli(&root, &["fill",&first,"--page",page,"--controller","agent-installation","--epoch",epoch,"--","#name","설치 후 한글"]).await?;
        require(fill["result"]["response"]["success"] == true, &fill)?;
        let original = evaluate(&root,&first,page,epoch,"({instance:window.installationInstance,value:document.querySelector('#name').value})").await?;
        require(original["value"] == "설치 후 한글", &original)?;

        // Change package material to exercise publication of a new generation.
        // The actual browser/engine bytes remain the externally supplied pins.
        let update_materials = root.join("update-materials");
        let copied = Command::new("node").arg("-e")
            .arg("require('node:fs').cpSync(process.argv[1],process.argv[2],{recursive:true,verbatimSymlinks:true})")
            .arg(&materials).arg(&update_materials).kill_on_drop(true).status().await.map_err(|error|error.to_string())?;
        require(copied.success(), copied)?;
        fs::write(update_materials.join("update-fixture.txt"), "Generation update fixture; not an upstream notice.\n").map_err(|error|error.to_string())?;
        let second_install = install(&root,&update_materials).await?;
        require(first_install["generation"] != second_install["generation"], &second_install)?;
        let retained = evaluate(&root,&first,page,epoch,"({instance:window.installationInstance,value:document.querySelector('#name').value})").await?;
        require(retained == original, &retained)?;

        let profile = cli(&root,&["tab","profile","create","--label","Installed update","--scope","isolated","--no-ua-spoof"]).await?;
        let profile_id = profile["result"]["profile"]["profile"]["profileId"].as_str().ok_or_else(||format!("profile missing: {profile}"))?;
        let created = cli(&root,&["create","--profile",profile_id]).await?;
        let second = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("updated resource missing")?.to_owned();
        owned.push(second.clone());
        let shown = cli(&root,&["show",&second]).await?;
        require(shown["result"]["pages"].as_array().is_some_and(|pages|pages.len()==1), &shown)?;
        let processes = Command::new("ps").args(["-axo","pid,command"]).output().await.map_err(|error|error.to_string())?;
        require(processes.status.success(), &processes)?;
        let process_text = String::from_utf8_lossy(&processes.stdout);
        let mut matching = Vec::new();
        for installation in [&first_install,&second_install] {
            for field in ["engineExecutable","chromiumExecutable"] {
                let path = installation["installation"][field].as_str().ok_or("installed path missing")?;
                let found:Vec<_> = process_text.lines().filter(|line|line.contains(path)).map(str::to_owned).collect();
                require(!found.is_empty(), path)?;
                matching.extend(found);
            }
        }
        Ok(json!({"before":before.err(),"firstInstall":first_install,"secondInstall":second_install,"firstResource":first,"secondResource":second,"original":original,"retained":retained,"processes":matching}))
    }.await;
    let mut closed = Vec::new();
    for resource in &owned {
        closed.push(cli(&root, &["close", resource]).await);
    }
    let shutdown = backend(
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
    println!(
        "BROWSER_INSTALLED_GENERATIONS_RETIRED root={} evidence={evidence:?} closed={closed:?} shutdown={shutdown}",
        root.display()
    );
    require(closed.iter().all(Result::is_ok), &closed).unwrap();
    evidence.unwrap();
}
