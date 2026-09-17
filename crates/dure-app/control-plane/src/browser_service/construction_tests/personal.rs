use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn personal_browser_opens_a_url_without_selecting_an_agent_workspace() {
    let chromium = PathBuf::from(std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap());
    let fixture = Fixture::new(&chromium).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let body = "<!doctype html><title>Personal browsing</title><link rel=icon href=data:,><p>URL opened</p>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let evidence: Result<_, BackendDispatchError> = async {
        let request = json!({"kind":"create","operation_id":"personal:create"});
        let created = fixture.service.dispatch(&fixture.store, &request).await?;
        let resource = created["result"]["control"]["resource"].clone();
        let replay = fixture.service.dispatch(&fixture.store, &request).await?;
        fixture.service.dispatch(&fixture.store, &json!({
            "kind":"control","resource":resource,"controller_id":"view:personal",
            "expected":null,"operation_id":"personal:control"
        })).await?;
        let navigated = init_scripts::action(&fixture, &resource, json!({"kind":"navigate","url":url})).await?;
        let document = init_scripts::action(&fixture, &resource, json!({"kind":"evaluate","script":"({title:document.title,text:document.body.textContent,url:location.href})"})).await?;
        let view = fixture.service.dispatch(&fixture.store, &json!({"kind":"observe","resource_id":resource["resource_id"]})).await?;
        let agent = fixture.list().await?;
        let closed = fixture.service.dispatch(&fixture.store, &json!({"kind":"close","resource":resource,"operation_id":"personal:close"})).await?;
        Ok(json!({"resource":resource,"replay":replay,"navigation":navigated,"document":document,"view":view,"agent":agent,"closed":closed}))
    }.await;
    let cleaned = fixture.finish().await;
    server.abort();
    let server_closed = server.await;
    println!(
        "BROWSER_PERSONAL_URL root={} url={url} evidence={evidence:?} cleanup={cleaned:?} server={server_closed:?}",
        fixture.root.display()
    );
    assert!(cleaned.is_ok(), "{cleaned:?}");
    assert!(server_closed.is_ok() || server_closed.is_err_and(|error| error.is_cancelled()));
    let result = evidence.unwrap();
    assert_eq!(result["resource"]["workspace_id"], "workspace:dure-browser");
    assert_eq!(result["replay"]["replayed"], true);
    assert_eq!(
        result["replay"]["result"]["control"]["resource"],
        result["resource"]
    );
    assert_eq!(result["navigation"]["result"]["response"]["success"], true);
    assert_eq!(result["view"]["result"]["pages"][0]["url"], url);
    assert_eq!(
        result["document"]["result"]["response"]["data"]["result"],
        json!({"title":"Personal browsing","text":"URL opened","url":url})
    );
    assert!(
        result["agent"]["result"]["resources"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(result["closed"]["result"]["closed"], true);
}
