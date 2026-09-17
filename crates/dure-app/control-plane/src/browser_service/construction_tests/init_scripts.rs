use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub(super) async fn action(
    fixture: &Fixture,
    resource: &Value,
    action: Value,
) -> Result<Value, BackendDispatchError> {
    let view = fixture
        .service
        .dispatch(
            &fixture.store,
            &json!({"kind":"observe","resource_id":resource["resource_id"]}),
        )
        .await?;
    let control = &view["result"]["control"];
    fixture.service.dispatch(&fixture.store,&json!({
        "kind":"action","caller":control["controller"]["controller_id"],
        "authority":{"lease":control["controller"],"page":control["current_page"],"command_sequence":control["next_command_sequence"],
        "operation_id":format!("startup:{}:{}",resource["resource_id"].as_str().unwrap(),control["next_command_sequence"].as_str().unwrap())},
        "action":action,
    })).await
}

async fn read(fixture: &Fixture, resource: &Value) -> Result<Value, BackendDispatchError> {
    let result = action(fixture,resource,json!({"kind":"evaluate","script":"({order:window.order??null,value:window.preloaded??null})"})).await?;
    Ok(result["result"]["response"]["data"]["result"].clone())
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn launch_init_scripts_execute_before_first_navigation_in_owned_and_shared_initialization() {
    let scripts = tempfile::Builder::new()
        .prefix("dure-launch-init-native-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let marker = scripts.join("launches");
    let executable = scripts.join("chromium");
    let chromium = PathBuf::from(std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap());
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nprintf 'launch\\n' >> {}\nexec {} \"$@\"\n",
            quote(&marker),
            quote(&chromium)
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let body = "<!doctype html><meta charset=utf-8><link rel=icon href=data:,><script>window.order=window.order||[];window.order.push('page');</script>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let fixture = Fixture::new(&executable).await;
    let evidence:Result<_,BackendDispatchError>=async {
        let mut resources=Vec::new();
        let mut before=Vec::new();let mut after=Vec::new();
        for (index,sources) in [vec!["window.order=['first'];window.preloaded='한글';","window.order.push('second');"],vec!["window.order=['peer'];window.preloaded='동료';"]].into_iter().enumerate() {
            let request=json!({"kind":"create","workspace_id":"workspace:construction","operation_id":format!("startup:create:{index}"),"init_scripts":sources});
            let created=fixture.service.dispatch(&fixture.store,&request).await?;
            let resource=created["result"]["control"]["resource"].clone();
            fixture.service.dispatch(&fixture.store,&json!({"kind":"control","resource":resource,"controller_id":"agent","expected":null,"operation_id":format!("startup:control:{index}")})).await?;
            before.push(read(&fixture,&resource).await?);
            action(&fixture,&resource,json!({"kind":"navigate","url":origin})).await?;
            after.push(read(&fixture,&resource).await?);
            resources.push(resource);
        }
        let owner=read(&fixture,&resources[0]).await?;
        action(&fixture,&resources[0],json!({"kind":"reload"})).await?;
        let reloaded=read(&fixture,&resources[0]).await?;
        action(&fixture,&resources[0],json!({"kind":"new_page","url":origin})).await?;
        let new_tab=read(&fixture,&resources[0]).await?;
        let peer=read(&fixture,&resources[1]).await?;
        Ok(json!({"before":before,"after":after,"owner":owner,"reloaded":reloaded,"new_tab":new_tab,"peer":peer}))
    }.await;
    let cleaned = fixture.finish().await;
    server.abort();
    let server_closed = server.await;
    let launches = std::fs::read_to_string(&marker);
    println!(
        "BROWSER_LAUNCH_INIT root={} scripts={} evidence={evidence:?} launches={launches:?} cleanup={cleaned:?} server={server_closed:?}",
        fixture.root.display(),
        scripts.display()
    );
    assert!(cleaned.is_ok(), "{cleaned:?}");
    assert!(server_closed.is_ok() || server_closed.is_err_and(|error| error.is_cancelled()));
    assert_eq!(launches.unwrap(), "launch\n");
    let result = evidence.unwrap();
    assert_eq!(
        result["before"],
        json!([{"order":null,"value":null},{"order":null,"value":null}])
    );
    assert_eq!(
        result["after"],
        json!([{"order":["first","second","page"],"value":"한글"},{"order":["peer","page"],"value":"동료"}])
    );
    assert_eq!(result["owner"], result["after"][0]);
    assert_eq!(result["reloaded"], result["after"][0]);
    assert_eq!(result["new_tab"], json!({"order":["page"],"value":null}));
    assert_eq!(result["peer"], result["after"][1]);
}
