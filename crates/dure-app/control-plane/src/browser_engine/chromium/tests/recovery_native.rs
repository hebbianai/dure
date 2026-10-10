//! Real Chromium acceptance: persisted data survives an abnormal owner exit.
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn page(browser: &OwnedChromium, url: &str) -> (BrowserCdp, String) {
    let mut cdp = BrowserCdp::connect(browser.endpoint()).await.unwrap();
    let target = cdp
        .request("Target.createTarget", json!({"url":url}), None)
        .await
        .unwrap();
    let attached = cdp
        .request(
            "Target.attachToTarget",
            json!({"targetId":target["targetId"],"flatten":true}),
            None,
        )
        .await
        .unwrap();
    let session = attached["sessionId"].as_str().unwrap().to_owned();
    for _ in 0..200 {
        let value = cdp
            .request(
                "Runtime.evaluate",
                json!({"expression":"location.href","returnByValue":true}),
                Some(&session),
            )
            .await
            .unwrap();
        if value["result"]["value"] == url {
            return (cdp, session);
        }
        sleep(Duration::from_millis(25)).await;
    }
    panic!("fixture page did not load");
}

#[tokio::test]
#[ignore = "requires DURE_BROWSER_TEST_CHROMIUM and isolated native QA runner"]
async fn native_profile_crash_reopens_retained_cookie_and_local_storage() {
    let executable = PathBuf::from(std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap());
    let root = tempfile::tempdir().unwrap();
    let id = BrowserProfileIdV1::new("native-crash-recovery").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut request = [0; 4096];
                if socket.read(&mut request).await.unwrap_or(0) > 0 {
                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n<!doctype html>").await;
                }
            });
        }
    });
    let mut seed = OwnedChromium::launch_profile(&executable, root.path(), &id)
        .await
        .unwrap();
    let (mut cdp, session) = page(&seed, &url).await;
    cdp.request("Runtime.evaluate", json!({"expression":"localStorage.setItem('retained','profile-data');document.cookie='retained=profile-data; Max-Age=3600; Path=/';","returnByValue":true}), Some(&session)).await.unwrap();
    cdp.retire().await;
    seed.close().await.unwrap();
    drop(seed);
    let mut crashed = OwnedChromium::launch_profile(&executable, root.path(), &id)
        .await
        .unwrap();
    let profile = crashed.profile.as_ref().unwrap().profile.clone();
    let (mut cdp, session) = page(&crashed, &url).await;
    let before = cdp.request("Runtime.evaluate", json!({"expression":"({cookie:document.cookie,local:localStorage.getItem('retained')})","returnByValue":true}), Some(&session)).await.unwrap();
    assert_eq!(before["result"]["value"]["local"], "profile-data");
    assert_eq!(before["result"]["value"]["cookie"], "retained=profile-data");
    cdp.retire().await;
    crashed.child.as_mut().unwrap().kill().unwrap();
    crashed.wait_for_exit().await.unwrap();
    let retired = crashed.close().await;
    drop(crashed);
    // Chromium descendants may still be retiring at the first census. Recovery
    // waits for proof without signaling or removing any Chromium lock files.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match profile::recover_storage(root.path(), &id) {
            Ok(()) => break,
            Err(error) if Instant::now() < deadline => {
                eprintln!("retirement still pending: {} ({retired:?})", error.code);
                sleep(Duration::from_millis(50)).await;
            }
            Err(error) => panic!("native recovery failed: {error:?}; close={retired:?}"),
        }
    }
    assert!(!profile.parent().unwrap().join("native-claim.json").exists());
    let mut reopened = OwnedChromium::launch_profile(&executable, root.path(), &id)
        .await
        .unwrap();
    let (mut cdp, session) = page(&reopened, &url).await;
    let after = cdp.request("Runtime.evaluate", json!({"expression":"({cookie:document.cookie,local:localStorage.getItem('retained')})","returnByValue":true}), Some(&session)).await.unwrap();
    assert_eq!(after["result"]["value"], before["result"]["value"]);
    cdp.retire().await;
    reopened.close().await.unwrap();
    drop(reopened);
    let owner = Command::new(std::env::current_exe().unwrap())
        .args(["browser_engine::chromium::tests::recovery_native::native_profile_recovery_backend_exit_fixture", "--exact", "--ignored", "--nocapture"])
        .env("DURE_BROWSER_RECOVERY_CHILD_ROOT", root.path())
        .status().unwrap();
    assert!(owner.success());
    assert!(
        profile
            .parent()
            .unwrap()
            .join("native-claim.json")
            .is_file()
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while profile::recover_storage(root.path(), &id).is_err() {
        assert!(
            Instant::now() < deadline,
            "lost owner recovery remained blocked"
        );
        sleep(Duration::from_millis(50)).await;
    }
    let mut recovered = OwnedChromium::launch_profile(&executable, root.path(), &id)
        .await
        .unwrap();
    let (mut cdp, session) = page(&recovered, &url).await;
    let after = cdp.request("Runtime.evaluate", json!({"expression":"({cookie:document.cookie,local:localStorage.getItem('retained')})","returnByValue":true}), Some(&session)).await.unwrap();
    assert_eq!(after["result"]["value"], before["result"]["value"]);
    cdp.retire().await;
    recovered.close().await.unwrap();
    eprintln!(
        "NATIVE_PROFILE_CRASH_RECOVERED: same profile cookie/localStorage retained after exact child SIGKILL and native recovery"
    );
    server.abort();
}

#[tokio::test]
#[ignore = "subprocess fixture for native profile recovery"]
async fn native_profile_recovery_backend_exit_fixture() {
    let Ok(root) = std::env::var("DURE_BROWSER_RECOVERY_CHILD_ROOT") else {
        return;
    };
    let executable = PathBuf::from(std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap());
    let id = BrowserProfileIdV1::new("native-crash-recovery").unwrap();
    let mut browser = OwnedChromium::launch_profile(&executable, Path::new(&root), &id)
        .await
        .unwrap();
    browser.child.as_mut().unwrap().kill().unwrap();
    browser.wait_for_exit().await.unwrap();
    // Simulate loss of the backend after a real Chromium crash: no destructor
    // or orderly native-claim release runs in this owner process.
    std::mem::forget(browser);
    std::process::exit(0);
}
