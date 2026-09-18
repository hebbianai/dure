use super::*;
use std::path::Path;
use tokio::{io::AsyncReadExt, net::TcpListener, sync::oneshot, task::JoinSet};

#[path = "selection/clone.rs"]
mod cloning;
#[path = "selection/deletion.rs"]
mod deletion;
#[path = "selection/switching.rs"]
mod switching;
#[path = "selection/user_agent.rs"]
mod user_agent;

struct Client {
    resource: String,
    page: String,
    epoch: String,
    created: Value,
}

impl Client {
    async fn create(root: &Path, profile: Option<&str>, operation: &str) -> Result<Self, String> {
        let mut args = vec!["create", "--idempotency-key", operation];
        if let Some(profile) = profile {
            args.extend(["--profile", profile]);
        }
        let created = cli(root, &args).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"]
            .as_str()
            .ok_or("created resource missing")?
            .to_owned();
        let shown = cli(root, &["show", &resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"]
            .as_str()
            .ok_or("created page missing")?
            .to_owned();
        let control = cli(
            root,
            &["control", &resource, "--controller", "profile-agent"],
        )
        .await?;
        let epoch = control["result"]["controller"]["epoch"]
            .as_str()
            .ok_or("controller epoch missing")?
            .to_owned();
        Ok(Self {
            resource,
            page,
            epoch,
            created,
        })
    }

    async fn action(&self, root: &Path, command: &str, value: &str) -> Result<Value, String> {
        cli(
            root,
            &[
                command,
                &self.resource,
                value,
                "--page",
                &self.page,
                "--controller",
                "profile-agent",
                "--epoch",
                &self.epoch,
            ],
        )
        .await
    }

    async fn evaluate(&self, root: &Path, script: &str) -> Result<Value, String> {
        Ok(
            self.action(root, "eval", script).await?["result"]["response"]["data"]["result"]
                .clone(),
        )
    }

    async fn close(&self, root: &Path) -> Result<Value, String> {
        cli(root, &["close", &self.resource]).await
    }
}

async fn site() -> (String, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (stop, mut stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut requests = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let (mut socket, _) = accepted.unwrap();
                    requests.spawn(async move {
                        let _ = timeout(Duration::from_secs(5), async {
                            let mut request = vec![0; 4096];
                            let _ = socket.read(&mut request).await?;
                            let body = "<!doctype html><meta charset=utf-8><title>Profile selection</title><input aria-label=Value>";
                            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await?;
                            socket.shutdown().await
                        }).await;
                    });
                }
                Some(_) = requests.join_next() => {}
            }
        }
        requests.shutdown().await;
    });
    (url, stop, server)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn default_profile_cli_shares_storage_across_browsers_and_reopens_after_close() {
    let (root, endpoint, server) = super::super::fixture().await;
    let (url, stop_site, site) = site().await;
    let evidence: Result<_, String> = async {
        let origin = Client::create(&root, None, "profile-default-origin").await?;
        origin.action(&root, "goto", &url).await?;
        origin.evaluate(&root, "localStorage.setItem('profile-shared','한글 기본 프로필');document.cookie='profile_shared=default;Path=/;Max-Age=3600';window.tabOnly='원본';true").await?;
        let peer = Client::create(&root, None, "profile-default-peer").await?;
        peer.action(&root, "goto", &url).await?;
        let shared = peer.evaluate(&root, "({local:localStorage.getItem('profile-shared'),cookie:document.cookie,tab:window.tabOnly??null})").await?;
        let origin_dom = origin.evaluate(&root, "window.tabOnly").await?;
        let replay = cli(&root, &["create", "--idempotency-key", "profile-default-peer"]).await?;
        let shown = cli(&root, &["show", &peer.resource]).await?;
        origin.close(&root).await?;
        let after_origin = peer.evaluate(&root, "localStorage.getItem('profile-shared')").await?;
        peer.close(&root).await?;
        let reopened = Client::create(&root, None, "profile-default-reopened").await?;
        reopened.action(&root, "goto", &url).await?;
        let persisted = reopened.evaluate(&root, "localStorage.getItem('profile-shared')").await?;
        reopened.close(&root).await?;
        Ok(json!({"shared":shared,"originDom":origin_dom,"replay":replay,"created":peer.created,"shown":shown,"afterOrigin":after_origin,"persisted":persisted,"resources":[origin.resource,peer.resource,reopened.resource]}))
    }.await;
    let shutdown = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let stopped = timeout(Duration::from_secs(40), server).await;
    let _ = stop_site.send(());
    let site_stopped = site.await;
    println!(
        "BROWSER_DEFAULT_PROFILE_CLI root={} evidence={evidence:?} shutdown={shutdown:?} stopped={stopped:?} site={site_stopped:?}",
        root.display()
    );
    assert!(matches!(stopped, Ok(Ok(Ok(())))), "{stopped:?}");
    assert!(site_stopped.is_ok(), "{site_stopped:?}");
    let evidence = evidence.unwrap();
    assert_eq!(
        evidence["shared"],
        json!({"local":"한글 기본 프로필","cookie":"profile_shared=default","tab":null})
    );
    assert_eq!(evidence["originDom"], "원본");
    assert_eq!(evidence["afterOrigin"], "한글 기본 프로필");
    assert_eq!(evidence["persisted"], "한글 기본 프로필");
    assert_eq!(
        evidence["shown"]["result"]["pages"][0]["profile_id"],
        "default"
    );
    assert_eq!(evidence["replay"]["replayed"], true);
    assert_eq!(evidence["replay"]["result"], evidence["created"]["result"]);
    assert_ne!(evidence["resources"][0], evidence["resources"][1]);
    assert_ne!(evidence["resources"][1], evidence["resources"][2]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn selected_profiles_cli_share_only_their_storage_and_reject_unavailable_catalog_entries() {
    let (root, endpoint, server) = super::super::fixture().await;
    let (url, stop_site, site) = site().await;
    let evidence: Result<_, String> = async {
        let catalog_a = cli(&root, &["tab", "profile", "create", "--label", "분리 A"]).await?;
        let catalog_b = cli(&root, &["tab", "profile", "create", "--label", "분리 B"]).await?;
        let id_a = catalog_a["result"]["profile"]["profile"]["profileId"].as_str().ok_or("profile A missing")?;
        let id_b = catalog_b["result"]["profile"]["profile"]["profileId"].as_str().ok_or("profile B missing")?;
        let a = Client::create(&root, Some(id_a), "selected-a").await?;
        a.action(&root, "goto", &url).await?;
        a.evaluate(&root, "localStorage.setItem('selected','한글 A');document.cookie='selected=A;Path=/;Max-Age=3600';true").await?;
        let b = Client::create(&root, Some(id_b), "selected-b").await?;
        b.action(&root, "goto", &url).await?;
        let read = "({local:localStorage.getItem('selected'),cookie:document.cookie})";
        let isolated = b.evaluate(&root, read).await?;
        b.evaluate(&root, "localStorage.setItem('selected','한글 B');document.cookie='selected=B;Path=/;Max-Age=3600';true").await?;
        let peer = Client::create(&root, Some(id_a), "selected-peer").await?;
        peer.action(&root, "goto", &url).await?;
        let shared = peer.evaluate(&root, read).await?;
        let shown = cli(&root, &["show", &peer.resource]).await?;
        let replay = cli(&root, &["create", "--profile", id_a, "--idempotency-key", "selected-peer"]).await?;
        let conflict = cli(&root, &["create", "--profile", id_b, "--idempotency-key", "selected-peer"]).await;
        a.close(&root).await?;
        let survived = peer.evaluate(&root, read).await?;
        peer.close(&root).await?;
        let b_unchanged = b.evaluate(&root, read).await?;
        b.close(&root).await?;
        let default = Client::create(&root, Some("default"), "selected-default").await?;
        default.action(&root, "goto", &url).await?;
        let default_isolated = default.evaluate(&root, read).await?;
        default.close(&root).await?;
        let before = cli(&root, &["list"]).await?;
        let missing = cli(&root, &["create", "--profile", "missing", "--idempotency-key", "selected-missing"]).await;
        let missing_replay = match cli(&root, &["create", "--profile", "missing", "--idempotency-key", "selected-missing"]).await {
            Err(error) => serde_json::from_str::<Value>(
                error.strip_prefix("CLI create rejected: ").ok_or_else(|| error.clone())?
            ).map_err(|error| error.to_string())?,
            Ok(value) => return Err(format!("failed profile replay unexpectedly succeeded: {value}")),
        };
        // This owned fixture has no remaining native consumers. Exercise the
        // persisted states that future profile deletion will admit through the store.
        use dure_app::{BrowserProfileIdV1, BrowserProfileStore};
        let store = dure_app_sqlite::SqliteDomainStore::open(root.join("backend/application-state.sqlite3")).await.map_err(|error|format!("{error:?}"))?;
        let retired: Result<_, String> = async {
            let profile = BrowserProfileIdV1::new(id_a).unwrap();
            store.begin_browser_profile_retirement(&profile).await.map_err(|error|format!("{error:?}"))?;
            let retiring = cli(&root, &["create", "--profile", id_a]).await;
            store.complete_browser_profile_retirement(&profile).await.map_err(|error|format!("{error:?}"))?;
            let deleted = cli(&root, &["create", "--profile", id_a]).await;
            Ok((retiring, deleted))
        }.await;
        store.close().await;
        let (retiring, deleted) = retired?;
        let after = cli(&root, &["list"]).await?;
        Ok((json!({"isolated":isolated,"shared":shared,"survived":survived,"bUnchanged":b_unchanged,"default":default_isolated,"profile":id_a,"shown":shown,"replay":replay,"created":peer.created,"before":before,"after":after,"missingReplay":missing_replay}), conflict, missing, retiring, deleted))
    }.await;
    let shutdown = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let stopped = timeout(Duration::from_secs(40), server).await;
    let _ = stop_site.send(());
    let site_stopped = site.await;
    println!(
        "BROWSER_SELECTED_PROFILE_CLI root={} evidence={evidence:?} shutdown={shutdown:?} stopped={stopped:?} site={site_stopped:?}",
        root.display()
    );
    assert!(matches!(stopped, Ok(Ok(Ok(())))), "{stopped:?}");
    assert!(site_stopped.is_ok(), "{site_stopped:?}");
    let (evidence, conflict, missing, retiring, deleted) = evidence.unwrap();
    assert_eq!(evidence["isolated"], json!({"local":null,"cookie":""}));
    assert_eq!(evidence["default"], json!({"local":null,"cookie":""}));
    assert_eq!(
        evidence["shared"],
        json!({"local":"한글 A","cookie":"selected=A"})
    );
    assert_eq!(evidence["survived"], evidence["shared"]);
    assert_eq!(
        evidence["bUnchanged"],
        json!({"local":"한글 B","cookie":"selected=B"})
    );
    assert_eq!(
        evidence["shown"]["result"]["pages"][0]["profile_id"],
        evidence["profile"]
    );
    assert_eq!(evidence["replay"]["replayed"], true);
    assert_eq!(evidence["replay"]["result"], evidence["created"]["result"]);
    for (result, code) in [
        (conflict, "browser_operation_conflict"),
        (missing, "browser_profile_missing"),
        (retiring, "browser_profile_retiring"),
        (deleted, "browser_profile_deleted"),
    ] {
        assert!(
            matches!(result, Err(ref error) if error.contains(code)),
            "expected={code} result={result:?}"
        );
    }
    assert_eq!(evidence["before"]["result"]["resources"], json!([]));
    assert_eq!(evidence["after"]["result"]["resources"], json!([]));
    assert_eq!(evidence["missingReplay"]["replayed"], true);
    assert_eq!(evidence["missingReplay"]["receipt"]["state"], "failed");
    assert_eq!(evidence["missingReplay"]["ok"], false);
    assert_eq!(
        evidence["missingReplay"]["error"]["code"],
        "browser_profile_missing"
    );
}
