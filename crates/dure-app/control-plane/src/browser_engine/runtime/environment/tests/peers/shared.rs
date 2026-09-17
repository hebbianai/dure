use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn shared_download_policy_preserves_peer_emulation_and_interception_after_retirement() {
    let (runtime, identity, root) = launch("shared:downloads").await;
    let mut peers = Vec::new();
    let evidence: Result<_, BrowserRuntimeError> = async {
        peers.push(runtime.share_instance(BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("shared:download-peer").unwrap(),
            generation: identity.generation.clone(),
            workspace_id: BrowserWorkspaceId::new("workspace:download-peer").unwrap(),
        }).await?);
        let mut pages = Vec::new();
        let mut leases = Vec::new();
        for (owner, name) in [(&runtime, "원본"), (&peers[0], "별도")] {
            let page = owner.observe().await?.pages[0].page.clone();
            let lease = owner.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
            let script = format!("document.body.innerHTML='<button id=save>Save</button>';window.downloads=0;document.querySelector('#save').onclick=()=>{{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([{}]));a.download='owned.txt';a.click();downloads++}};true", serde_json::to_string(name).unwrap());
            apply(owner, &lease, &page, json!({"kind":"evaluate","script":script})).await?;
            apply(owner, &lease, &page, json!({"kind":"interception","action":{"kind":"enable","rule":{"patterns":["https://profile.invalid/*"],"effect":{"kind":"respond","status":200,"body":name,"headers":{"access-control-allow-origin":"*","content-type":"text/plain; charset=utf-8"}}}}})).await?;
            pages.push(page);
            leases.push(lease);
        }
        let download = json!({"kind":"download","target":{"kind":"css","selector":"#save"},"timeout_ms":2000});
        let first = apply(&runtime, &leases[0], &pages[0], download.clone()).await?;
        apply(&runtime, &leases[0], &pages[0], json!({"kind":"environment","action":{"kind":"media","media":"print","color_scheme":"dark"}})).await?;
        let other = apply(&peers[0], &leases[1], &pages[1], download.clone()).await?;
        let inspect = json!({"kind":"evaluate","script":"({print:matchMedia('print').matches,dark:matchMedia('(prefers-color-scheme:dark)').matches,downloads})"});
        let retained = apply(&runtime, &leases[0], &pages[0], inspect.clone()).await?.response.data["result"].clone();
        let fetch = json!({"kind":"evaluate","script":"fetch('https://profile.invalid/response').then(r=>r.text()).catch(e=>'failed:'+e.name)"});
        let peer_response = apply(&peers[0], &leases[1], &pages[1], fetch.clone()).await?.response.data["result"].clone();
        peers[0].close(&peers[0].control().await.resource).await?;
        let repeated = apply(&runtime, &leases[0], &pages[0], download).await?;
        let after = apply(&runtime, &leases[0], &pages[0], inspect).await?.response.data["result"].clone();
        let response = apply(&runtime, &leases[0], &pages[0], fetch).await?.response.data["result"].clone();
        let interception = runtime.interception_state(&identity, &pages[0].page_id).await?;
        Ok((first.response, other.response, repeated.response, retained, after, peer_response, response, interception))
    }.await;
    let mut peer_retirements = Vec::new();
    for peer in &peers {
        peer_retirements.push(peer.close(&peer.control().await.resource).await);
    }
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_SHARED_DOWNLOADS root={} evidence={evidence:?} peers={peer_retirements:?} retired={retired:?}",
        root.display()
    );
    assert!(
        peer_retirements.iter().all(Result::is_ok),
        "{peer_retirements:?}"
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (first, other, repeated, retained, after, peer_response, response, interception) =
        evidence.unwrap();
    for (result, expected) in [(first, "원본"), (other, "별도"), (repeated, "원본")] {
        assert!(result.success, "{result:?}");
        let encoded = result.data["artifact_payload"]["base64"].as_str().unwrap();
        assert_eq!(STANDARD.decode(encoded).unwrap(), expected.as_bytes());
    }
    assert_eq!(retained, json!({"print":true,"dark":true,"downloads":1}));
    assert_eq!(after, json!({"print":true,"dark":true,"downloads":2}));
    assert_eq!(peer_response, "별도");
    assert_eq!(response, "원본");
    assert!(interception.enabled && interception.available);
}
