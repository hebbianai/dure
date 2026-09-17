#![cfg(unix)]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tokio_tungstenite::{accept_async, tungstenite::Message};

const VERSION: &str = "codex-cli 0.150.1";

#[derive(Default)]
struct FixtureState {
    active_turn: Mutex<Option<Value>>,
    initialized_children: Mutex<Vec<Child>>,
}

fn socket_path(arguments: &[String]) -> Option<PathBuf> {
    if arguments.first().map(String::as_str) != Some("app-server") {
        return None;
    }
    let listen = arguments
        .windows(2)
        .find(|pair| pair[0] == "--listen")?
        .get(1)?
        .strip_prefix("unix://")?;
    Some(PathBuf::from(listen))
}

fn response(method: &str, params: &Value, thread_id: &str, active_turn: Option<&Value>) -> Value {
    match method {
        "initialize" => json!({
            "codexHome": std::env::var("CODEX_HOME").unwrap_or_default(),
            "userAgent": "dure-codex-app-server-fixture",
        }),
        "account/read" => json!({
            "account": { "type": "fixture" },
            "requiresOpenaiAuth": false,
        }),
        "config/read" => json!({ "config": { "developer_instructions": "Preserve fixture instructions." } }),
        "thread/start" | "thread/resume" => {
            let requested_thread = params
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or(thread_id);
            json!({
                "cwd": params.get("cwd"),
                "thread": {
                    "id": requested_thread,
                    "turns": active_turn.into_iter().cloned().collect::<Vec<_>>(),
                },
            })
        }
        "thread/read" => {
            let requested_thread = params
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or(thread_id);
            json!({
                "thread": {
                    "id": requested_thread,
                    "turns": active_turn.into_iter().cloned().collect::<Vec<_>>(),
                },
            })
        }
        "turn/start" => json!({ "turn": active_turn }),
        _ => json!({}),
    }
}

async fn serve_connection(stream: UnixStream, thread_id: Arc<String>, state: Arc<FixtureState>) {
    let Ok(mut socket) = accept_async(stream).await else {
        return;
    };
    while let Some(Ok(message)) = socket.next().await {
        let source = match message {
            Message::Text(source) => source.to_string(),
            Message::Binary(source) => match String::from_utf8(source.to_vec()) {
                Ok(source) => source,
                Err(_) => break,
            },
            Message::Ping(payload) => {
                if socket.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
                continue;
            }
            Message::Pong(_) => continue,
            Message::Close(_) | Message::Frame(_) => break,
        };
        let Ok(request) = serde_json::from_str::<Value>(&source) else {
            break;
        };
        let (Some(id), Some(method)) = (
            request.get("id").cloned(),
            request.get("method").and_then(Value::as_str),
        ) else {
            continue;
        };
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if matches!(method, "initialize" | "thread/start" | "thread/resume") {
            let child = Command::new(std::env::current_exe().expect("fixture executable"))
                .arg("--initialized-child")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn initialized fixture child");
            state.initialized_children.lock().await.push(child);
        }
        if method == "turn/start" {
            let client_id = params
                .get("clientUserMessageId")
                .and_then(Value::as_str)
                .unwrap_or("fixture-client-message");
            *state.active_turn.lock().await = Some(json!({
                "id": "fixture-provider-turn",
                "status": "inProgress",
                "items": [{
                    "type": "userMessage",
                    "id": "fixture-user-message",
                    "clientId": client_id,
                    "content": [],
                }],
            }));
        }
        let active_turn = state.active_turn.lock().await.clone();
        let reply = if method == "thread/resume" {
            json!({
                "id": id,
                "error": {
                    "code": -32600,
                    "message": "no rollout found for empty fixture thread",
                },
            })
        } else {
            json!({
                "id": id,
                "result": response(method, &params, &thread_id, active_turn.as_ref()),
            })
        };
        if socket
            .send(Message::Text(reply.to_string().into()))
            .await
            .is_err()
        {
            break;
        }
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 1)]
async fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.as_slice() == ["--version"] {
        println!("{VERSION}");
        return;
    }
    if arguments.as_slice() == ["--initialized-child"] {
        std::future::pending::<()>().await;
        return;
    }
    let Some(path) = socket_path(&arguments) else {
        std::process::exit(2);
    };
    let listener = UnixListener::bind(path).expect("bind fixture app-server socket");
    let thread_id = Arc::new(format!("fixture-thread-{}", std::process::id()));
    let state = Arc::new(FixtureState::default());
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            break;
        };
        drop(tokio::spawn(serve_connection(
            stream,
            Arc::clone(&thread_id),
            Arc::clone(&state),
        )));
    }
}
