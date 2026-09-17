use super::*;
use std::io::Write;

// The Node desktop client owns behavioral assertions. This ignored harness
// reuses the real domain-store fixture and development backend while Tauri runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "fixture harness for scripts/qa/browser-panel-smoke.mjs"]
async fn serve_pro_panel_fixture() {
    let qa_root = std::env::var("DURE_QA_STATE_ROOT").expect("isolated QA runner required");
    assert!(
        Path::new(&qa_root)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("dure-browser-panel.")
    );
    assert_eq!(std::env::var("DURE_QA_LAYER").unwrap(), "background");
    let (root, endpoint, server) = fixture().await;
    println!(
        "BROWSER_PANEL_FIXTURE {}",
        json!({
            "home": root, "backendId": endpoint.backend_id,
            "generation": endpoint.generation, "socket": endpoint.socket_path,
            "pid": std::process::id(),
        })
    );
    std::io::stdout().flush().unwrap();
    let mut input = String::new();
    let requested = timeout(
        Duration::from_secs(240),
        BufReader::new(tokio::io::stdin()).read_line(&mut input),
    )
    .await;
    let stopped = backend(
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
    assert_eq!(stopped["kind"], "dure.backend.response");
    requested
        .expect("desktop client did not close its fixture input")
        .unwrap();
    println!(
        "BROWSER_PANEL_FIXTURE_STOPPED {}",
        json!({"home":root,"pid":std::process::id()})
    );
}
