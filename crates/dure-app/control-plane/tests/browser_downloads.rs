#![cfg(unix)]

use dure_control_plane::browser_engine::{NativeBrowserEngineConfig, runtime::BrowserRuntime};
use hmux_session_protocol::browser_resource::*;
use serde_json::{Value, json};
use std::path::Path;

async fn apply(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    value: Value,
) -> Result<Value, String> {
    let sequence = runtime.control().await.next_command_sequence;
    let authority = BrowserActionAuthority {
        lease: lease.clone(),
        page: page.clone(),
        command_sequence: sequence,
        operation_id: BrowserOperationId::new(format!("operation:{sequence}")).unwrap(),
    };
    let result = runtime
        .action(
            &lease.controller_id,
            &authority,
            serde_json::from_value(value).unwrap(),
        )
        .await
        .map_err(|error| format!("{error:?}"))?;
    if !result.response.success {
        return Err(format!("{:?}", result.response));
    }
    Ok(result.response.data)
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn a_foreign_pages_download_cannot_complete_the_requested_pages_click() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-download-owned-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("browser:download").unwrap(),
        generation: BrowserResourceGeneration::new("generation:download").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:download").unwrap(),
    };
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let result:Result<_,String>=async {
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await.map_err(|error|format!("{error:?}"))?.controller.unwrap();
        let page=runtime.observe().await.map_err(|error|format!("{error:?}"))?.pages[0].page.clone();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":r#"document.body.innerHTML='<button id=open>Open other</button><button id=download>Download this page</button>';document.querySelector('#open').onclick=()=>window.other=window.open('about:blank');window.save=(w,text)=>{const a=w.document.createElement('a');a.href=w.URL.createObjectURL(new w.Blob([text]));a.download='result.txt';w.document.body.append(a);a.click();};document.querySelector('#download').onclick=()=>{save(other,'OTHER PAGE');setTimeout(()=>save(window,'REQUESTED PAGE'),350)};true"#})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"click","target":{"kind":"css","selector":"#open"}})).await?;
        let observed=runtime.observe().await.map_err(|error|format!("{error:?}"))?;
        if observed.pages.len()!=2 { return Err(format!("popup missing: {observed:?}")); }
        let downloaded=apply(&runtime,&lease,&page,json!({"kind":"download","target":{"kind":"css","selector":"#download"},"timeout_ms":5000})).await?;
        Ok(downloaded)
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_DOWNLOAD_NATIVE_RESULT root={} result={result:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let evidence = result.unwrap();
    println!(
        "BROWSER_DOWNLOAD_NATIVE_EVIDENCE {}",
        json!({"root":root,"download":evidence})
    );
    assert_eq!(
        evidence["artifact_payload"]["base64"],
        "UkVRVUVTVEVEIFBBR0U="
    );
}
