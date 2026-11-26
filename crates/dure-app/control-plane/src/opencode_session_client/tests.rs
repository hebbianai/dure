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

/// What OpenCode's `read` tool keeps of the images or PDFs it read: each
/// whole file, encoded, in the tool part's attachments, one per size in
/// `files`.
fn attached(mut value: Value, files: &[usize]) -> Value {
    let part = &mut value["parts"][0];
    part["type"] = json!("tool");
    part["tool"] = json!("read");
    part["callID"] = json!("call_read");
    let attachments = files
        .iter()
        .map(|bytes| json!({"type": "file", "mime": "application/pdf", "url": format!("data:application/pdf;base64,{}", "A".repeat(*bytes))}))
        .collect::<Vec<_>>();
    part["state"] = json!({"status": "completed", "output": "PDF read successfully", "attachments": attachments});
    value
}

/// Files whose attachments the client keeps whole, which together are
/// larger than it keeps of an answer of several messages.
fn files_over_an_answer() -> Vec<usize> {
    vec![MAX_STRING_BYTES - 64; MAX_RESPONSE_BYTES / MAX_STRING_BYTES + 1]
}

/// `value` with the URL of its first attachment cut as the client cuts a
/// string: to the URL's first [`MAX_STRING_BYTES`].
fn cut_attachment(mut value: Value, attachment: &str) -> Value {
    let url = value.pointer_mut(attachment).unwrap();
    *url = Value::String(url.as_str().unwrap()[..MAX_STRING_BYTES].to_owned());
    value
}

#[tokio::test]
async fn a_message_larger_than_an_answer_of_several_is_read_whole_as_one_record() {
    let session = SessionId::parse("ses_exact").unwrap();
    let large = attached(message("msg_large", "ses_exact"), &files_over_an_answer());
    assert!(large.to_string().len() > MAX_RESPONSE_BYTES);
    let (client, server) = fixture(vec![(200, String::new(), large.clone())]).await;

    let read = client.message(&session, "msg_large").await;
    // The values are too large to print.
    assert_eq!(read.as_ref().err(), None);
    assert!(read.unwrap() == Some(large));

    server.await.unwrap();
}

#[tokio::test]
async fn a_message_that_attached_a_file_over_the_record_bound_is_read_with_the_file_cut() {
    let session = SessionId::parse("ses_exact").unwrap();
    let large = attached(message("msg_large", "ses_exact"), &[MAX_RECORD_BYTES]);
    let (client, server) = fixture(vec![(200, String::new(), large.clone())]).await;

    // Before, the message was over the bound of one record, so it could not
    // be read: Chat disconnected, and a reattach while it was the newest
    // failed.
    let read = client.message(&session, "msg_large").await;

    assert_eq!(read.as_ref().err(), None);
    let read = read.unwrap().unwrap();
    assert_eq!(
        read.pointer("/parts/0/state/output"),
        Some(&json!("PDF read successfully"))
    );
    assert!(read == cut_attachment(large, "/parts/0/state/attachments/0/url"));

    server.await.unwrap();
}

/// An event stream that writes `body` in small pieces, as a large event
/// arrives in many chunks.
async fn event_stream(body: String) -> OpenCodeEvents {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = OpenCodeSessionClient::new(
        listener.local_addr().unwrap().port(),
        "fixture-only".into(),
        Path::new("/fixture"),
    )
    .unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.windows(4).any(|window| window == b"\r\n\r\n") {
            let mut buffer = [0; 1024];
            let size = socket.read(&mut buffer).await.unwrap();
            assert_ne!(size, 0);
            head.extend_from_slice(&buffer[..size]);
        }
        socket.write_all(format!("HTTP/1.1 200 Fixture\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
        for piece in body.as_bytes().chunks(4093) {
            socket.write_all(piece).await.unwrap();
            socket.flush().await.unwrap();
        }
    });
    client.events().await.unwrap()
}

/// The update of the tool part that read the files `files`, which carries
/// them.
fn read_update(files: &[usize]) -> Value {
    json!({"type": "message.part.updated", "properties": {"part": attached(message("msg_large", "ses_exact"), files)["parts"][0].clone()}})
}

#[tokio::test]
async fn an_event_larger_than_an_answer_of_several_is_read_whole_as_one_record() {
    let large = read_update(&files_over_an_answer());
    let next = json!({"type": "session.idle", "properties": {"sessionID": "ses_exact"}});
    let mut events = event_stream(format!("data: {large}\n\ndata: {next}\r\n\r\n")).await;

    let event = events.next().await;
    // The event is too large to print.
    assert_eq!(event.as_ref().err(), None);
    assert!(event.unwrap() == large);
    assert_eq!(events.next().await, Ok(next));
}

#[tokio::test]
async fn an_event_that_carries_a_file_over_the_record_bound_is_read_with_the_file_cut() {
    let large = read_update(&[MAX_RECORD_BYTES]);
    let next = json!({"type": "session.idle", "properties": {"sessionID": "ses_exact"}});
    let mut events = event_stream(format!("data: {large}\n\ndata: {next}\n\n")).await;

    // Before, the event was over the bound of one record, which ended the
    // event stream, so Chat disconnected in the middle of the turn.
    let event = events.next().await;

    assert_eq!(event.as_ref().err(), None);
    assert!(event.unwrap() == cut_attachment(large, "/properties/part/state/attachments/0/url"));
    assert_eq!(events.next().await, Ok(next));
}

#[test]
fn a_frame_ends_at_its_first_blank_line_wherever_its_search_resumes() {
    for (frames, end) in [
        (&b"data: 1\n\ndata: 2\n\n"[..], 9),
        (&b"data: 1\r\n\r\ndata: 2\r\n\r\n"[..], 11),
    ] {
        // The bytes before `searched` hold no whole blank line.
        for searched in 0..end {
            assert_eq!(frame_end(frames, searched), Some(end), "{searched}");
        }
        assert_eq!(frame_end(&frames[..end - 1], end - 1), None);
    }
}

/// What the client keeps of `json` when it arrives in chunks, split at each
/// offset in `splits`.
fn kept(json: &[u8], splits: impl IntoIterator<Item = usize>) -> Vec<u8> {
    let mut json_kept = KeptJson::default();
    let mut kept = Vec::new();
    let mut start = 0;
    for end in splits.into_iter().chain([json.len()]) {
        json_kept.keep(&json[start..end], &mut kept);
        start = end;
    }
    kept
}

#[test]
fn a_long_string_is_cut_after_a_whole_character_wherever_its_chunks_end() {
    // Characters of each length, raw and escaped, and an escaped surrogate
    // pair, which the string is never cut inside of.
    let tail = r#"é😀\"\\\n\u00e9\ud83d\ude00x"#.repeat(4);
    for before in MAX_STRING_BYTES - 32..=MAX_STRING_BYTES {
        let string = format!("{}{tail}", "x".repeat(before));
        let json = format!(r#"{{"long":"{string}","short":"kept"}}"#);
        let source: Value = serde_json::from_str(&json).unwrap();
        // In one chunk, and split at each byte around the cut.
        let near = MAX_STRING_BYTES - 32;
        for splits in [Vec::new(), (near..near + 96).collect()] {
            let kept = kept(json.as_bytes(), splits);

            let value: Value = serde_json::from_slice(&kept).unwrap();
            assert_eq!(value["short"], "kept");
            let long = value["long"].as_str().unwrap();
            assert!(source["long"].as_str().unwrap().starts_with(long));
            // The string's JSON is kept up to the bound, and then to the end
            // of the character that crosses it.
            let kept_json = kept.len() - (json.len() - string.len());
            assert!(
                (MAX_STRING_BYTES..=MAX_STRING_BYTES + 11).contains(&kept_json),
                "{before}: {kept_json}"
            );
        }
    }
}

#[test]
fn strings_within_the_bound_and_everything_between_strings_are_kept_whole() {
    let string = format!("{}é", "x".repeat(MAX_STRING_BYTES - 2));
    assert_eq!(string.len(), MAX_STRING_BYTES);
    // A line end ends a string, so a line that is not JSON, such as an event
    // stream's comment, cannot hold the strings after it.
    let events = format!(
        "data: {{\"text\":\"{string}\",\"n\":[1,2.5,true,null]}}\n\n: a \"comment\n\ndata: {{\"quote\":\"\\\"\"}}\n\n"
    );

    assert_eq!(kept(events.as_bytes(), []), events.as_bytes());
    assert_eq!(kept(events.as_bytes(), 1..events.len()), events.as_bytes());
}
