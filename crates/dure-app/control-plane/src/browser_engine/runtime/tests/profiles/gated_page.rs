use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};

pub(super) struct GatedPage {
    pub(super) url: String,
    pub(super) armed: Arc<AtomicBool>,
    pub(super) release: watch::Sender<bool>,
    pub(super) requested: mpsc::Receiver<()>,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl GatedPage {
    pub(super) async fn start() -> Self {
        Self::with_html(
            "<!doctype html><meta charset=utf-8><title>프로필 전환</title><p>한글 페이지</p>",
        )
        .await
    }

    pub(super) async fn with_html(body: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/document", listener.local_addr().unwrap());
        let armed = Arc::new(AtomicBool::new(false));
        let (release, released) = watch::channel(false);
        let (request, requested) = mpsc::channel(4);
        let (stop, mut stopped) = oneshot::channel();
        let observed = Arc::clone(&armed);
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break };
                        let (armed, released, request) = (Arc::clone(&observed), released.clone(), request.clone());
                        tasks.spawn(respond(socket, armed, released, request, body));
                    },
                    Some(_) = tasks.join_next() => {},
                }
            }
            tasks.shutdown().await;
        });
        Self {
            url,
            armed,
            release,
            requested,
            stop: Some(stop),
            task,
        }
    }

    pub(super) async fn close(&mut self) -> Result<(), tokio::task::JoinError> {
        let _ = self.release.send(true);
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        (&mut self.task).await
    }
}

async fn respond(
    mut socket: tokio::net::TcpStream,
    armed: Arc<AtomicBool>,
    mut released: watch::Receiver<bool>,
    request: mpsc::Sender<()>,
    body: &'static str,
) -> std::io::Result<()> {
    let mut headers = [0; 4096];
    let mut received = 0;
    while !headers[..received]
        .windows(4)
        .any(|bytes| bytes == b"\r\n\r\n")
    {
        if received == headers.len() {
            return Err(std::io::Error::other("fixture headers exceed limit"));
        }
        let count = socket.read(&mut headers[received..]).await?;
        if count == 0 {
            return Ok(());
        }
        received += count;
    }
    if headers[..received].starts_with(b"GET /document ") && armed.load(Ordering::SeqCst) {
        let _ = request.send(()).await;
        while !*released.borrow_and_update() {
            if released.changed().await.is_err() {
                return Ok(());
            }
        }
    }
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await?;
    socket.shutdown().await
}
