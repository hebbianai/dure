use super::*;
use crate::browser_engine::NativeBrowserEngineConfig;
use hmux_session_protocol::browser_resource::*;
use serde_json::json;
use std::path::Path;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_observer_cannot_complete_network_wait_or_recreate_the_engine() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-browser-network-loss-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("browser:loss").unwrap(),
        generation: BrowserResourceGeneration::new("generation:1").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:loss").unwrap(),
    };
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let observed = runtime.observe().await?;
        let page = &observed.pages[0].page;
        let control = runtime.control().await;
        let endpoint = runtime
            .test_binding()
            .engine
            .lock()
            .await
            .chromium
            .endpoint()
            .to_string();
        // Stop the exact owned socket task while Chromium remains alive.
        runtime.test_binding().events.close().await;
        let network = runtime.network(page).await;
        let wait = runtime
            .wait(
                page,
                &serde_json::from_value(
                    json!({"condition":{"kind":"load","state":"networkidle"},"timeout_ms":1000}),
                )
                .unwrap(),
            )
            .await;
        Ok((
            network,
            wait,
            control,
            runtime.control().await,
            endpoint,
            runtime
                .test_binding()
                .engine
                .lock()
                .await
                .chromium
                .endpoint()
                .to_string(),
        ))
    }
    .await;
    let retired = runtime.close(&identity).await;
    assert!(retired.is_ok(), "exact engine retirement: {retired:?}");
    let (network, wait, before, after, endpoint, final_endpoint) = evidence.unwrap();
    assert!(
        matches!(
            network,
            Err(BrowserRuntimeError::Observation(
                "browser_network_observation_lost"
            ))
        ),
        "{network:?}"
    );
    assert!(
        matches!(
            wait,
            Err(BrowserRuntimeError::Observation(
                "browser_network_observation_lost"
            ))
        ),
        "{wait:?}"
    );
    assert_eq!(before, after);
    assert_eq!(endpoint, final_endpoint);
}
