use super::cli;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::{Duration, Instant, sleep, timeout};

fn require(condition: bool, observation: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("browser wait observation: {observation:?}"))
    }
}

async fn evaluate(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    script: &str,
) -> Result<Value, String> {
    cli(
        home,
        &[
            "eval",
            resource,
            script,
            "--page",
            page,
            "--controller",
            "agent-proof",
            "--epoch",
            epoch,
        ],
    )
    .await
}

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
) -> Result<(), String> {
    let delay = cli(home, &["wait", resource, "duration", "50", "--page", page]).await?;
    require(
        delay["result"]["elapsed_ms"]
            .as_u64()
            .is_some_and(|ms| ms >= 50),
        &delay,
    )?;
    let started = Instant::now();
    let (waited, created) = tokio::join!(
        async {
            cli(
                home,
                &[
                    "wait",
                    resource,
                    "selector",
                    "#awaited",
                    "--state",
                    "attached",
                    "--timeout",
                    "4000",
                    "--page",
                    page,
                ],
            )
            .await
        },
        async {
            sleep(Duration::from_millis(100)).await;
            evaluate(
                home,
                resource,
                page,
                epoch,
                "document.body.insertAdjacentHTML('beforeend','<div id=awaited>한글 준비</div>')",
            )
            .await
        }
    );
    created?;
    let waited = waited?;
    require(started.elapsed() < Duration::from_secs(4), &waited)?;
    cli(
        home,
        &[
            "wait",
            resource,
            "text",
            "한글 준비",
            "--timeout",
            "1000",
            "--page",
            page,
        ],
    )
    .await?;
    evaluate(
        home,
        resource,
        page,
        epoch,
        "document.querySelector('#awaited').hidden=true",
    )
    .await?;
    cli(
        home,
        &[
            "wait",
            resource,
            "selector",
            "#awaited",
            "--state",
            "hidden",
            "--timeout",
            "1000",
            "--page",
            page,
        ],
    )
    .await?;
    evaluate(
        home,
        resource,
        page,
        epoch,
        "document.querySelector('#awaited').remove()",
    )
    .await?;
    cli(
        home,
        &[
            "wait",
            resource,
            "selector",
            "#awaited",
            "--state",
            "detached",
            "--timeout",
            "1000",
            "--page",
            page,
        ],
    )
    .await?;
    let missing = cli(
        home,
        &[
            "wait",
            resource,
            "selector",
            "#never",
            "--timeout",
            "150",
            "--page",
            page,
        ],
    )
    .await;
    require(
        missing
            .as_ref()
            .is_err_and(|error| error.contains("browser_wait_timeout")),
        &missing,
    )?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let url = format!(
        "http://{}/ready",
        listener.local_addr().map_err(|error| error.to_string())?
    );
    let slow_started = Arc::new(AtomicBool::new(false));
    let slow_finished = Arc::new(AtomicBool::new(false));
    let server_started = Arc::clone(&slow_started);
    let server_finished = Arc::clone(&slow_finished);
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let slow = request.starts_with(b"GET /slow ");
            if slow {
                server_started.store(true, Ordering::SeqCst);
                sleep(Duration::from_millis(2500)).await;
            }
            let body = "<!doctype html><title>Wait navigation</title><p id=loaded>Ready</p><script>window.fnWrites=0;window.fnPolls=0;window.asyncFnWrites=0</script>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            if slow {
                server_finished.store(true, Ordering::SeqCst);
            }
        }
    });
    let navigation: Result<_,String> = async {
        let before = cli(home, &["show", resource]).await?;
        let (url_wait, navigated) = tokio::join!(
            async { cli(home, &["wait", resource, "url", "**/ready", "--timeout", "5000", "--page", page]).await },
            async {
                sleep(Duration::from_millis(100)).await;
                cli(home, &["goto", resource, &url, "--page", page, "--controller", "agent-proof", "--epoch", epoch]).await
            }
        );
        navigated?;
        let url_wait = url_wait?;
        let original = before["result"]["pages"].as_array().unwrap().iter().find(|entry| entry["page"]["page_id"] == page).unwrap();
        require(url_wait["result"]["page"]["document_revision"] != original["page"]["document_revision"], &url_wait)?;
        for state in ["domcontentloaded", "load", "networkidle"] {
            cli(home, &["wait", resource, "load", state, "--timeout", "3000", "--page", page]).await?;
        }
        cli(home, &["wait", resource, "selector", "#loaded", "--state", "visible", "--page", page]).await?;
        let denied = cli(home, &["wait", resource, "function", "++window.fnWrites===1", "--page", page]).await;
        require(denied.as_ref().is_err_and(|error| error.contains("browser_controller_changed")), &denied)?;
        let async_started = Instant::now();
        let async_wait = cli(home, &["wait", resource, "function", "new Promise(resolve=>setTimeout(()=>resolve(++window.asyncFnWrites===1),400))", "--page", page, "--controller", "agent-proof", "--epoch", epoch]).await?;
        require(async_started.elapsed() >= Duration::from_millis(400), &async_wait)?;
        let async_writes = evaluate(home, resource, page, epoch, "window.asyncFnWrites").await?;
        require(async_writes["result"]["response"]["data"]["result"] == 1, &async_writes)?;
        let function = ["wait", resource, "function", "++window.fnWrites===1", "--page", page, "--controller", "agent-proof", "--epoch", epoch, "--idempotency-key", "wait-function-once"];
        cli(home, &function).await?;
        let repeated = cli(home, &function).await;
        require(repeated.as_ref().is_err_and(|error| error.contains("browser_operation_conflict")), &repeated)?;
        let writes = evaluate(home, resource, page, epoch, "window.fnWrites").await?;
        require(writes["result"]["response"]["data"]["result"] == 1, &writes)?;
        evaluate(home, resource, page, epoch, "window.slowDone=false;fetch('/slow').then(()=>window.slowDone=true);true").await?;
        timeout(Duration::from_secs(2), async {
            while !slow_started.load(Ordering::SeqCst) { sleep(Duration::from_millis(5)).await; }
        }).await.map_err(|_| "slow HTTP request did not start".to_string())?;
        let pending = cli(home, &["network", resource, "--page", page]).await?;
        require(pending["result"]["complete"] == true && pending["result"]["idle"] == false, &pending)?;
        require(pending["result"]["requests"].as_array().is_some_and(|requests| requests.iter().any(|request| request["url"].as_str().is_some_and(|url| url.ends_with("/slow")) && request["state"] == "pending")), &pending)?;
        let network_started = Instant::now();
        let idle = cli(home, &["wait", resource, "load", "networkidle", "--timeout", "5000", "--page", page]).await?;
        let finished = evaluate(home, resource, page, epoch, "window.slowDone").await?;
        let network_evidence = json!({"wait":idle,"elapsed_ms":network_started.elapsed().as_millis(),"serverFinished":slow_finished.load(Ordering::SeqCst),"pageFinished":finished["result"]["response"]["data"]["result"]});
        println!("BROWSER_NETWORK_IDLE_DIAGNOSIS {network_evidence}");
        require(network_evidence["serverFinished"] == true && network_evidence["pageFinished"] == true, &network_evidence)?;
        super::network::exercise(home, resource, page, epoch).await?;
        evaluate(home, resource, page, epoch, "window.waitPointerUps=0;window.waitKeyUps=0;document.addEventListener('pointerup',()=>window.waitPointerUps++);document.addEventListener('keyup',()=>window.waitKeyUps++);true").await?;
        cli(home, &["keydown", resource, "Shift", "--page", page, "--controller", "agent-proof", "--epoch", epoch]).await?;
        cli(home, &["mouse", resource, "down", "--page", page, "--controller", "agent-proof", "--epoch", epoch]).await?;
        let (waiting, transferred) = tokio::join!(
            async { cli(home, &["wait", resource, "function", "(++window.fnPolls,false)", "--timeout", "6000", "--page", page, "--controller", "agent-proof", "--epoch", epoch]).await },
            async {
                timeout(Duration::from_secs(4), async {
                    loop {
                        let shown = cli(home, &["show", resource]).await?;
                        if !shown["result"]["control"]["in_flight"].is_null() { break; }
                        sleep(Duration::from_millis(10)).await;
                    }
                    cli(home, &["control", resource, "--controller", "human-wait-proof"]).await
                }).await.map_err(|_| "function wait admission not observed".to_string())?
            }
        );
        transferred?;
        require(waiting.as_ref().is_err_and(|error| error.contains("browser_wait_cancelled_for_handoff")), &waiting)?;
        let human = cli(home, &["show", resource]).await?;
        require(human["result"]["control"]["controller"]["controller_id"] == "human-wait-proof", &human)?;
        require(human["result"]["control"]["pointer"].is_null() && human["result"]["control"]["keyboard"].is_null(), &human)?;
        let human_epoch=human["result"]["control"]["controller"]["epoch"].as_str().unwrap();
        let released=cli(home, &["eval", resource, "({pointer:window.waitPointerUps,key:window.waitKeyUps})", "--page", page, "--controller", "human-wait-proof", "--epoch", human_epoch]).await?;
        require(released["result"]["response"]["data"]["result"]==json!({"pointer":1,"key":1}), &released)?;
        Ok(json!({"followedDocument":url_wait["result"]["page"],"functionWrites":1,"handoffCancelledWait":true}))
    }.await;
    server.abort();
    println!(
        "BROWSER_WAIT_EVIDENCE {}",
        json!({"duration":delay["result"]["elapsed_ms"],"inputProgress":true,"navigation":navigation?})
    );
    Ok(())
}
