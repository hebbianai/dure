use super::socket::Socket;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{Duration, timeout};
use tokio_tungstenite::tungstenite::{http::Uri, protocol::WebSocketConfig};

mod wire;
use wire::Wire;

#[cfg(test)]
mod tests;

const CONTROL_BYTES: usize = 2 * 1024 * 1024;
const CAPTURE_BYTES: usize = 96 * 1024 * 1024;

fn response_bytes(method: &str) -> usize {
    // Native snapshots and response bodies use the existing bulk capture
    // budget. Ordinary control replies keep their smaller transport bound.
    if matches!(
        method,
        "DOMSnapshot.captureSnapshot"
            | "Network.getResponseBody"
            | "DOMStorage.getDOMStorageItems"
            | "Network.getAllCookies"
    ) {
        CAPTURE_BYTES
    } else {
        CONTROL_BYTES
    }
}

/// An owned native connection. Its address never reaches clients; callers
/// admit input through Host before using mutation methods.
pub(super) struct Connection {
    wire: Wire,
    sessions: Mutex<BTreeMap<String, String>>,
    frame: Arc<Mutex<()>>,
}

impl Connection {
    pub(super) async fn connect(address: &str) -> Result<Self, &'static str> {
        let uri: Uri = address.parse().map_err(|_| "browser_cdp_address_invalid")?;
        if uri.scheme_str() != Some("ws")
            || uri.host() != Some("127.0.0.1")
            || !uri.path().starts_with("/devtools/browser/")
        {
            return Err("browser_cdp_address_invalid");
        }
        let port = uri
            .port_u16()
            .filter(|port| *port != 0)
            .ok_or("browser_cdp_address_invalid")?;
        timeout(Duration::from_secs(5), async {
            let stream = TcpStream::connect(("127.0.0.1", port))
                .await
                .map_err(|_| "browser_cdp_unavailable")?;
            stream
                .set_nodelay(true)
                .map_err(|_| "browser_cdp_unavailable")?;
            let config = WebSocketConfig::default()
                .max_message_size(Some(CONTROL_BYTES))
                .max_frame_size(Some(CONTROL_BYTES));
            let socket = Socket::connect(address, stream, config)
                .await
                .map_err(|_| "browser_cdp_handshake_failed")?;
            Ok(Self {
                wire: Wire::start(socket),
                sessions: Mutex::new(BTreeMap::new()),
                frame: Arc::new(Mutex::new(())),
            })
        })
        .await
        .map_err(|_| "browser_cdp_connect_timeout")?
    }

    pub(super) async fn request(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, &'static str> {
        self.request_with_deadline(method, params, session, Duration::from_secs(5))
            .await
    }

    pub(super) async fn request_with_deadline(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        deadline: Duration,
    ) -> Result<Value, &'static str> {
        self.request_until(method, params, session, async move {
            tokio::time::sleep(deadline).await;
            "browser_cdp_response_timeout"
        })
        .await
    }

    pub(super) async fn request_until(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        expired: impl std::future::Future<Output = &'static str>,
    ) -> Result<Value, &'static str> {
        tokio::pin!(expired);
        // A canceled frame reader leaves its stop with the capture task.
        // Recording must wait for that acknowledgement on this same session.
        let _capture = if method == "Page.startScreenRecording" {
            Some(tokio::select! {
                guard = self.frame.lock() => guard,
                error = &mut expired => return Err(error),
            })
        } else {
            None
        };
        self.wire
            .request_until(method, params, session, expired, response_bytes(method))
            .await
    }

    pub(super) async fn capture_screenshot(
        &self,
        params: Value,
        session: &str,
    ) -> Result<Value, &'static str> {
        self.request_with_limit(
            "Page.captureScreenshot",
            params,
            Some(session),
            Duration::from_secs(30),
            CAPTURE_BYTES,
        )
        .await
    }

    /// Sample the compositor without the screenshot path's forced redraw.
    /// The owned task stops capture even if its view/request is canceled.
    pub(super) async fn capture_frame(
        self: &Arc<Self>,
        session: &str,
    ) -> Result<Value, &'static str> {
        let guard = Arc::clone(&self.frame).lock_owned().await;
        let connection = Arc::clone(self);
        let session = session.to_owned();
        tokio::spawn(async move {
            let _guard = guard;
            let (_frame, received) = connection.wire.frame(&session)?;
            let captured = async {
                connection
                    .request(
                        "Page.startScreencast",
                        json!({"format":"jpeg","quality":90,"everyNthFrame":1}),
                        Some(&session),
                    )
                    .await?;
                timeout(Duration::from_secs(5), received)
                    .await
                    .map_err(|_| "browser_frame_timeout")?
                    .map_err(|_| "browser_cdp_closed")?
            }
            .await;
            // No acknowledgement requests another image. Stop after the one
            // admitted sample, including uncertain starts and canceled readers.
            if connection
                .request("Page.stopScreencast", json!({}), Some(&session))
                .await
                .is_err()
            {
                connection.wire.retire().await;
                return Err("browser_frame_stop_unknown");
            }
            captured
        })
        .await
        .map_err(|_| "browser_frame_interrupted")?
    }

    async fn request_with_limit(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        deadline: Duration,
        bytes: usize,
    ) -> Result<Value, &'static str> {
        self.wire
            .request(method, params, session, deadline, bytes)
            .await
    }

    pub(super) fn retain_events(&self) {
        self.wire.retain_events();
    }

    pub(super) fn pop_event(&self) -> Option<Value> {
        self.wire.pop_event()
    }

    pub(super) async fn next_event(&self) -> Result<Value, &'static str> {
        self.wire.next_event().await
    }

    pub(super) async fn attach(&self, target: &str) -> Result<String, &'static str> {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(target) {
            return Ok(session.clone());
        }
        let result = self
            .request(
                "Target.attachToTarget",
                json!({"targetId":target,"flatten":true}),
                None,
            )
            .await?;
        let session = result["sessionId"]
            .as_str()
            .ok_or("browser_cdp_session_missing")?
            .to_owned();
        sessions.insert(target.to_owned(), session.clone());
        Ok(session)
    }

    pub(super) async fn has_session(&self, session: &str) -> bool {
        self.sessions
            .lock()
            .await
            .values()
            .any(|attached| attached == session)
    }

    pub(super) async fn retain_targets(&self, targets: &[&str]) {
        self.sessions
            .lock()
            .await
            .retain(|target, _| targets.contains(&target.as_str()));
    }

    pub(super) async fn retire(&self) {
        self.wire.retire().await;
        self.sessions.lock().await.clear();
    }
}
