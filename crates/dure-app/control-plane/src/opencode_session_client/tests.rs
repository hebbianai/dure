use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn fixture(
    responses: Vec<(u16, String, Value)>,
) -> (OpenCodeSessionClient, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = OpenCodeSessionClient::new(
        listener.local_addr().unwrap().port(),
        "fixture-only".into(),
        Path::new("/fixture"),
    )
    .unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, headers, body) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buffer = [0; 1024];
                let size = socket.read(&mut buffer).await.unwrap();
                assert_ne!(size, 0);
                bytes.extend_from_slice(&buffer[..size]);
                if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
                assert!(bytes.len() < 16_384);
            }
            requests.push(String::from_utf8(bytes).unwrap());
            let body = body.to_string();
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    (client, server)
}

fn message(id: &str, session: &str) -> Value {
    json!({"info": {"id": id, "sessionID": session, "role": "user"}, "parts": [{"type": "text", "text": "fixture", "messageID": id, "sessionID": session}]})
}

#[test]
fn settings_preserve_the_exact_model_variant_and_user_message() {
    assert_eq!(
        prompt_body(
            "msg_exact",
            "한글 'quoted'\nnext",
            Some(&AgentSpawnModelSelectionV1::parse("provider/team/model:v2").unwrap()),
            Some(&AgentSpawnEffortSelectionV1::parse("high").unwrap())
        )
        .unwrap(),
        json!({
            "messageID": "msg_exact", "model": {"providerID": "provider", "modelID": "team/model:v2"}, "variant": "high", "parts": [{"type": "text", "text": "한글 'quoted'\nnext"}]
        })
    );
    assert_eq!(
        prompt_body(
            "msg_exact",
            "hello",
            Some(&AgentSpawnModelSelectionV1::parse("ambiguous-model").unwrap()),
            None
        ),
        Err(Error::Protocol)
    );
}

#[tokio::test]
async fn exact_lookup_never_accepts_a_different_conversation_or_workspace() {
    for response in [
        json!({"id":"ses_other", "directory":"/fixture"}),
        json!({"id":"ses_exact", "directory":"/other"}),
    ] {
        let (client, server) = fixture(vec![(200, String::new(), response)]).await;
        assert_eq!(
            client
                .session(&SessionId::parse("ses_exact").unwrap())
                .await,
            Err(Error::Identity)
        );
        let requests = server.await.unwrap();
        assert!(requests[0].starts_with("GET /session/ses_exact "));
    }
}

#[tokio::test]
async fn paginated_history_keeps_opaque_cursors_and_chronological_order() {
    let (client, server) = fixture(vec![
        (
            200,
            "X-Next-Cursor: opaque+/=\r\nLink: <https://unrelated.invalid/messages>; rel=next\r\n"
                .into(),
            json!([message("msg_new", "ses_exact")]),
        ),
        (200, String::new(), json!([message("msg_old", "ses_exact")])),
    ])
    .await;
    let history = client
        .messages(&SessionId::parse("ses_exact").unwrap())
        .await
        .unwrap();
    assert_eq!(
        history
            .iter()
            .map(|message| message["info"]["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["msg_old", "msg_new"]
    );
    let requests = server.await.unwrap();
    assert!(
        requests[1].starts_with("GET /session/ses_exact/message?limit=100&before=opaque%2B%2F%3D ")
    );
}

#[tokio::test]
async fn history_rejects_cross_session_parts_and_repeating_cursors() {
    let mut wrong_part = message("msg_exact", "ses_exact");
    wrong_part["parts"][0]["sessionID"] = json!("ses_other");
    let (client, server) = fixture(vec![(200, String::new(), json!([wrong_part]))]).await;
    assert_eq!(
        client
            .messages(&SessionId::parse("ses_exact").unwrap())
            .await,
        Err(Error::Identity)
    );
    server.await.unwrap();
    let (client, server) = fixture(vec![
        (
            200,
            "X-Next-Cursor: repeating\r\n".into(),
            json!([message("msg_new", "ses_exact")]),
        ),
        (
            200,
            "X-Next-Cursor: repeating\r\n".into(),
            json!([message("msg_old", "ses_exact")]),
        ),
    ])
    .await;
    assert_eq!(
        client
            .messages(&SessionId::parse("ses_exact").unwrap())
            .await,
        Err(Error::Protocol)
    );
    server.await.unwrap();
}

#[tokio::test]
async fn redirects_cannot_move_a_session_request_and_its_authorization() {
    let (client, server) = fixture(vec![(
        307,
        "Location: http://127.0.0.1:1/elsewhere\r\n".into(),
        Value::Null,
    )])
    .await;
    assert_eq!(
        client
            .session(&SessionId::parse("ses_exact").unwrap())
            .await,
        Err(Error::Rejected(307))
    );
    assert_eq!(server.await.unwrap().len(), 1);
}

#[tokio::test]
#[ignore = "requires the isolated OpenCode HTTP conformance fixture"]
async fn live_opencode_exact_session_settings_and_reconnect() {
    let port = std::env::var("DURE_QA_OPENCODE_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let workspace = std::env::var("DURE_QA_OPENCODE_WORKSPACE").unwrap();
    let client =
        OpenCodeSessionClient::new(port, "isolated-fixture-token".into(), Path::new(&workspace))
            .unwrap();
    assert_eq!(client.health().await.unwrap(), "1.18.29");
    let session = SessionId::parse("ses_dure_rust_conformance").unwrap();
    let created = client.create(&session).await.unwrap();
    assert_eq!(client.create(&session).await.unwrap(), created);
    client.session(&session).await.unwrap();
    for (message, model, effort) in [
        ("msg_dure_first", "fixture-model", "low"),
        ("msg_dure_second", "fixture-alternate", "high"),
    ] {
        assert!(client.message(&session, message).await.unwrap().is_none());
        client
            .prompt(
                &session,
                message,
                "한글 입력을 유지하고 같은 대화에서 답해 줘.",
                Some(&AgentSpawnModelSelectionV1::parse(&format!("fixture/{model}")).unwrap()),
                Some(&AgentSpawnEffortSelectionV1::parse(effort).unwrap()),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let history = client.messages(&session).await.unwrap();
                if let Some(answer) = history.iter().find(|item| {
                    item.pointer("/info/parentID").and_then(Value::as_str) == Some(message)
                        && item.pointer("/info/time/completed").is_some()
                }) {
                    assert_eq!(answer["info"]["modelID"], model);
                    assert_eq!(answer["info"]["variant"], effort);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        assert!(client.message(&session, message).await.unwrap().is_some());
    }
    let reconnected =
        OpenCodeSessionClient::new(port, "isolated-fixture-token".into(), Path::new(&workspace))
            .unwrap();
    assert_eq!(reconnected.messages(&session).await.unwrap().len(), 4);
    assert!(!reconnected.is_busy(&session).await.unwrap());
    reconnected.abort(&session).await.unwrap();
}

#[tokio::test]
async fn malformed_runtime_status_cannot_authorize_idle_replacement() {
    let session = SessionId::parse("ses_exact").unwrap();
    for status in [json!({}), json!({"type": "unknown"}), Value::Null] {
        let (client, server) =
            fixture(vec![(200, String::new(), json!({"ses_exact": status}))]).await;
        assert_eq!(client.is_busy(&session).await, Err(Error::Protocol));
        server.await.unwrap();
    }
}
