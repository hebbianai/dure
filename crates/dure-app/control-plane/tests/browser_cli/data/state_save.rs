use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    origins: (&str, &str),
    isolated: (&str, &str, &str),
    requests: &AtomicUsize,
) -> Result<(), String> {
    let (origin, other_origin) = origins;
    let (isolated_resource, isolated_page, isolated_epoch) = isolated;
    let created = write(home, resource, page, epoch, "tab-new", &[origin]).await?;
    let created_page = created["result"]["response"]["data"]["page"]["page_id"]
        .as_str()
        .ok_or_else(|| format!("save tab missing: {created}"))?;
    let result = async {
        write(home, resource, created_page, epoch, "storage", &["local", "set", "save-visited", "이전 사이트"]).await?;
        eval(home, resource, created_page, epoch, "localStorage.setItem('save-large','x'.repeat(2200000));true").await?;
        let history = eval(home, resource, created_page, epoch, "history.length").await?;
        eval(home, resource, created_page, epoch, &format!("location.replace({});true", json!(other_origin))).await?;
        read(home, resource, created_page, "wait", &["url", &format!("{other_origin}/")]).await?;
        require(eval(home, resource, created_page, epoch, "history.length").await? == history, "replace added a history entry")?;
        write(home, resource, created_page, epoch, "storage", &["session", "set", "save-session", "현재 탭"]).await?;
        write(home, resource, created_page, epoch, "cookie", &["set", "save-http", "secret", "--http-only"]).await?;
        eval(home, resource, created_page, epoch, "window.saveMarker='unchanged';window.saveReads=0;for(const name of ['localStorage','sessionStorage'])Object.defineProperty(window,name,{get(){window.saveReads++;throw Error('page storage hook')}});document.getElementById('focus').focus();true").await?;
        // Observe complete load/idle before counting the save's network effects.
        read(home, resource, created_page, "wait", &["load", "networkidle"]).await?;
        let before = cli(home, &["show", resource]).await?;
        let count = requests.load(Ordering::SeqCst);
        let output = home.join("state export.json");
        let saved = write(home, resource, created_page, epoch, "state", &["save", output.to_str().unwrap(), "--idempotency-key", "state-save-proof"]).await?;
        require(saved["result"]["response"]["data"]["saved"] == true, &saved)?;
        require(requests.load(Ordering::SeqCst) == count, "state export made an HTTP request")?;
        let after = cli(home, &["show", resource]).await?;
        require(before["result"]["pages"] == after["result"]["pages"], (&before, &after))?;
        require(before["result"]["control"]["current_page"] == after["result"]["control"]["current_page"], "state export changed selected page")?;
        require(eval(home, resource, created_page, epoch, "({marker:saveMarker,reads:saveReads,focus:document.activeElement.id})").await? == json!({"marker":"unchanged","reads":0,"focus":"focus"}), "export navigated the source or invoked page hooks")?;
        let bytes = tokio::fs::read(&output).await.map_err(|e|e.to_string())?;
        require(bytes.len() > 2 * 1024 * 1024, bytes.len())?;
        let state: Value = serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
        let entries = state["origins"].as_array().ok_or("export origins missing")?;
        let visited = entries.iter().find(|entry| entry["origin"] == origin).ok_or("replaced origin missing")?;
        require(visited["localStorage"].as_array().is_some_and(|entries| entries.iter().any(|entry| entry["name"] == "save-visited" && entry["value"] == "이전 사이트")), &visited["origin"])?;
        require(visited["sessionStorage"] == json!([]), "other-origin session scope changed")?;
        let current = entries.iter().find(|entry| entry["origin"] == other_origin).ok_or("current origin missing")?;
        require(current["sessionStorage"].as_array().is_some_and(|entries| entries.iter().any(|entry| entry["name"] == "save-session" && entry["value"] == "현재 탭")), "current session data missing")?;
        require(state["cookies"].as_array().is_some_and(|cookies|cookies.iter().any(|cookie| cookie["name"] == "save-http" && cookie["httpOnly"] == true)), "HTTP-only cookie missing")?;
        let recovered = home.join("state recovered.json");
        cli(home, &["artifact", "state-save-proof", "--output", recovered.to_str().unwrap()]).await?;
        require(tokio::fs::read(recovered).await.map_err(|e|e.to_string())? == bytes, "artifact recovery changed saved bytes")?;
        require(requests.load(Ordering::SeqCst) == count, "artifact recovery repeated save")?;
        // Restore the exported file through the real CLI into another profile.
        write(home, isolated_resource, isolated_page, isolated_epoch, "state", &["load", output.to_str().unwrap()]).await?;
        write(home, isolated_resource, isolated_page, isolated_epoch, "goto", &[origin]).await?;
        require(eval(home, isolated_resource, isolated_page, isolated_epoch, "localStorage.getItem('save-large').length").await? == 2200000, "large value did not roundtrip")?;
        require(read(home, isolated_resource, isolated_page, "storage", &["local", "get", "save-visited"]).await?["value"] == "이전 사이트", "visited origin did not roundtrip")?;
        write(home, isolated_resource, isolated_page, isolated_epoch, "goto", &[other_origin]).await?;
        require(read(home, isolated_resource, isolated_page, "storage", &["session", "get", "save-session"]).await?["value"] == "현재 탭", "session value did not roundtrip")?;
        println!("BROWSER_STATE_SAVE_EVIDENCE {}", json!({"bytes":bytes.len(),"replacedNavigation":true,"sourceDocumentAndSelectionPreserved":true,"noHttpRequests":true,"temporaryPageRetired":true,"pageHooksNotInvoked":true,"httpOnlyCookie":true,"artifactRecoveryExact":true,"otherProfileRoundtrip":true}));
        Ok(())
    }.await;
    let closed = write(home, resource, created_page, epoch, "tab-close", &[])
        .await
        .map(|_| ());
    let cleared = write(home, resource, page, epoch, "cookie", &["clear"])
        .await
        .map(|_| ());
    result.and(closed).and(cleared)
}
