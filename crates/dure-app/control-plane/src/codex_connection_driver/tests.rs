use super::*;

#[test]
fn large_provider_messages_keep_read_work_bounded_under_partial_reads() {
    use std::io::{self, Cursor, Read, Write};
    use tokio_tungstenite::tungstenite::{WebSocket, protocol::Role};

    struct PartialReads {
        source: Cursor<Vec<u8>>,
        largest_read_buffer: usize,
        offered_bytes: usize,
    }
    impl Read for PartialReads {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.largest_read_buffer = self.largest_read_buffer.max(buffer.len());
            self.offered_bytes += buffer.len();
            let chunk = buffer.len().min(4096);
            self.source.read(&mut buffer[..chunk])
        }
    }
    impl Write for PartialReads {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    // A large unmasked provider frame arrives in socket-sized chunks. Count
    // the memory prepared for Read instead of asserting a flaky time limit.
    let payload = vec![b'x'; 8 * 1024 * 1024];
    let mut wire = vec![0x82, 127];
    wire.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    wire.extend_from_slice(&payload);
    // The following small message must also survive the large transfer.
    wire.extend_from_slice(&[0x81, 2, b'o', b'k']);
    let configuration = websocket_configuration();
    let mut socket = WebSocket::from_raw_socket(
        PartialReads {
            source: Cursor::new(wire),
            largest_read_buffer: 0,
            offered_bytes: 0,
        },
        Role::Client,
        Some(configuration),
    );
    let started = std::time::Instant::now();
    assert_eq!(
        socket.read().unwrap(),
        Message::Binary(payload.clone().into())
    );
    assert_eq!(socket.read().unwrap(), Message::Text("ok".into()));
    let observed = socket.get_ref();
    eprintln!(
        "large provider read: payload={} offered={} largest={} elapsed_ms={}",
        payload.len(),
        observed.offered_bytes,
        observed.largest_read_buffer,
        started.elapsed().as_millis(),
    );
    assert!(
        observed.largest_read_buffer <= configuration.read_buffer_size,
        "partial reads must not repeatedly initialize the entire large message allocation: {}",
        observed.largest_read_buffer,
    );
}

async fn request(socket: &mut Socket, id: u64, method: &str) -> Value {
    socket
        .send(Message::Text(
            json!({"id": id, "method": method, "params": {}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let reply = message_json(reply).unwrap();
    assert_eq!(reply["id"], id);
    assert!(reply.get("error").is_none(), "{reply}");
    reply["result"].clone()
}

async fn initialized_client(endpoint: &Path) -> Socket {
    let mut socket = tokio::time::timeout(Duration::from_secs(5), open_upstream(endpoint))
        .await
        .expect("the existing driver must accept the next client")
        .expect("an abandoned auxiliary client must not terminate the driver");
    request(&mut socket, 1, "initialize").await;
    socket
        .send(Message::Text(
            json!({"method": "initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    socket
}

#[tokio::test]
async fn abandoned_queued_handshake_preserves_provider_and_next_ui_connection() {
    let directory = tempfile::tempdir().unwrap();
    let upstream_path = directory.path().join("upstream.sock");
    let endpoint = directory.path().join("app.sock");
    let listener = bind_endpoint(&upstream_path).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async_with_config(stream, Some(websocket_configuration()))
            .await
            .unwrap();
        let mut calls = 0;
        while let Some(Ok(message)) = socket.next().await {
            if message.is_close() {
                break;
            }
            let message = message_json(message).unwrap();
            let Some(id) = message.get("id") else {
                continue;
            };
            let result = if message["method"] == "initialize" {
                json!({"userAgent": "structured-driver-fixture"})
            } else {
                calls += 1;
                json!({"calls": calls})
            };
            socket
                .send(Message::Text(
                    json!({"id": id, "result": result}).to_string().into(),
                ))
                .await
                .unwrap();
        }
    });
    let mut child = Command::new("/bin/cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    let options = DriverOptions {
        endpoint: endpoint.clone(),
        upstream: upstream_path,
        executable: PathBuf::from("/bin/cat"),
        arguments: Vec::new(),
    };
    let driver = tokio::spawn(async move { run_driver(&options, &mut child).await });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !endpoint.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let mut first = initialized_client(&endpoint).await;
    assert_eq!(request(&mut first, 2, "fixture/probe").await["calls"], 1);

    // This peer is queued behind the still-connected UI and never initializes.
    drop(UnixStream::connect(&endpoint).await.unwrap());
    assert_eq!(request(&mut first, 3, "fixture/probe").await["calls"], 2);
    first.close(None).await.unwrap();
    drop(first);

    let mut next = initialized_client(&endpoint).await;
    assert_eq!(request(&mut next, 2, "fixture/probe").await["calls"], 3);
    assert!(!driver.is_finished());
    next.close(None).await.unwrap();
    drop(next);
    drop(input);
    let exit = tokio::time::timeout(Duration::from_secs(5), driver)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(exit.reason, "upstream_exited");
    server.abort();
    if let Err(error) = server.await {
        assert!(error.is_cancelled());
    }
}
