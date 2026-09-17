use super::*;

fn catalogue() -> Value {
    json!({
        "schemaVersion":1,"kind":"dure.mcp.stateless-worker-catalogue",
        "initialize":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},
            "serverInfo":{"name":"dure-orchestration","version":"1"}},
        "tools":{"tools":[{"name":"fixture","inputSchema":{"type":"object"}}]}
    })
}

#[test]
fn stateful_capabilities_cannot_inherit_the_stateless_restart_contract() {
    assert!(Catalogue::parse(catalogue()).is_ok());
    for capabilities in [
        json!({"tools":{},"resources":{}}),
        json!({"tools":{"listChanged":true}}),
        json!({"tools":{},"tasks":{}}),
    ] {
        let mut value = catalogue();
        value["initialize"]["capabilities"] = capabilities;
        assert!(Catalogue::parse(value).is_err());
    }
}

#[test]
fn relay_options_require_exact_paths_and_a_positive_bounded_idle_interval() {
    let root = std::env::temp_dir();
    let valid = [
        "--node".into(),
        root.join("node").to_string_lossy().into_owned(),
        "--worker".into(),
        root.join("worker.mjs").to_string_lossy().into_owned(),
        "--catalogue".into(),
        root.join("catalogue.json").to_string_lossy().into_owned(),
        "--receipt-json".into(),
        "{}".into(),
    ];
    let parse = |extra: &[&str]| {
        Options::parse(
            valid
                .iter()
                .cloned()
                .chain(extra.iter().map(|value| (*value).into())),
        )
    };
    assert_eq!(
        parse(&[]).unwrap().idle,
        Duration::from_millis(DEFAULT_IDLE_MS)
    );
    assert!(parse(&["--idle-ms", "1"]).is_ok());
    for extra in [
        vec!["--idle-ms", "0"],
        vec!["--idle-ms", "86400001"],
        vec!["--node", "/different"],
        vec!["--idle-ms", "5", "--idle-ms", "6"],
        vec!["--receipt-json", "{}"],
    ] {
        assert!(parse(&extra).is_err());
    }
    let mut relative = valid.clone();
    relative[1] = "node".into();
    assert!(Options::parse(relative.into_iter()).is_err());
    for receipt in [
        "not-json".to_owned(),
        "[]".to_owned(),
        " ".repeat(16 * 1024 + 1),
    ] {
        let mut invalid_receipt = valid.clone();
        invalid_receipt[7] = receipt;
        assert!(Options::parse(invalid_receipt.into_iter()).is_err());
    }
}

#[test]
fn initialize_uses_the_handlers_nullish_protocol_default() {
    let catalogue = Catalogue::parse(catalogue()).unwrap();
    for params in [json!({}), json!({"protocolVersion":null})] {
        assert_eq!(
            catalogue.initialize_result(&params)["protocolVersion"],
            "2025-03-26"
        );
    }
    assert_eq!(
        catalogue.initialize_result(&json!({"protocolVersion":"2025-06-18"}))["protocolVersion"],
        "2025-06-18"
    );
}

#[tokio::test]
async fn frame_bytes_survive_a_cancelled_partial_read() {
    let (mut client, server) = tokio::io::duplex(128);
    let mut frames = Frames::new(server);
    client.write_all(b"{\"jsonrpc\":").await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(10), frames.next())
            .await
            .is_err()
    );
    client.write_all(b"\"2.0\",\"id\":7}\n").await.unwrap();
    assert_eq!(
        frames.next().await.unwrap(),
        Some(json!({"jsonrpc":"2.0","id":7}))
    );
    drop(client);
    assert!(frames.next().await.unwrap().is_none());
}

#[tokio::test]
async fn truncated_and_oversized_frames_are_not_completion_evidence() {
    assert!(Frames::new(b"{\"id\":1}".as_slice()).next().await.is_err());
    let bytes = vec![b'a'; MAX_FRAME_BYTES + 1];
    let mut frames = Frames::new(bytes.as_slice());
    assert!(frames.next().await.is_err());
    assert!(frames.pending.len() <= MAX_FRAME_BYTES);
}

#[tokio::test]
async fn metadata_is_available_without_starting_any_worker() {
    let mut relay = Relay {
        options: Options {
            node: "/nonexistent-node".into(),
            worker: "/nonexistent-worker".into(),
            catalogue: "/nonexistent-catalogue".into(),
            receipt: "{}".into(),
            idle: Duration::from_millis(1),
        },
        catalogue: Catalogue::parse(catalogue()).unwrap(),
        worker: None,
        initialization: None,
        initialized: false,
        idle_at: Instant::now(),
    };
    let input = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":3,"method":"ping"}),
    ].map(|value| format!("{value}\n")).concat();
    let mut output = Vec::new();
    relay.run(input.as_bytes(), &mut output).await.unwrap();
    let lines: Vec<Value> = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(lines[1]["result"], catalogue()["tools"]);
    assert_eq!(lines[2]["result"], json!({}));
    assert!(relay.worker.is_none());
}
