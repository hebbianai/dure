//! Best-effort Telegram notification.
//!
//! The GitHub issue created by [`crate::sink`] is the durable record; this
//! client is only a convenience ping to a team channel, so every failure
//! here is for the caller to log, never to propagate. The API base URL is a
//! constructor argument so tests can point this at a local mock server
//! instead of `https://api.telegram.org`.

use reqwest::Client;
use serde_json::json;

/// A failure sending a Telegram notification. Never fatal to delivery —
/// see the module docs.
#[derive(Debug)]
pub struct TelegramError(pub String);

impl std::fmt::Display for TelegramError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for TelegramError {}

pub struct TelegramClient {
    http: Client,
    api_base: String,
    token: String,
    chat_id: String,
}

impl TelegramClient {
    pub fn new(
        http: Client,
        api_base: impl Into<String>,
        token: impl Into<String>,
        chat_id: impl Into<String>,
    ) -> Self {
        Self {
            http,
            api_base: api_base.into(),
            token: token.into(),
            chat_id: chat_id.into(),
        }
    }

    async fn check(response: reqwest::Response, method: &str) -> Result<(), TelegramError> {
        if response.status().is_success() {
            return Ok(());
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(TelegramError(format!(
            "telegram {method} failed: {status}: {body}"
        )))
    }

    /// Sends a plain text notification.
    pub async fn send_message(&self, text: &str) -> Result<(), TelegramError> {
        let url = format!("{}/bot{}/sendMessage", self.api_base, self.token);
        let response = self
            .http
            .post(&url)
            .json(&json!({ "chat_id": self.chat_id, "text": text }))
            .send()
            .await
            .map_err(|err| TelegramError(err.to_string()))?;
        Self::check(response, "sendMessage").await
    }

    /// Sends `png_bytes` as a photo with `caption`, uploaded directly rather
    /// than referenced by URL — the asset repo the bytes were also committed
    /// to may not be publicly reachable, so Telegram cannot be asked to
    /// fetch it itself.
    pub async fn send_photo(
        &self,
        caption: &str,
        filename: &str,
        png_bytes: Vec<u8>,
    ) -> Result<(), TelegramError> {
        let url = format!("{}/bot{}/sendPhoto", self.api_base, self.token);
        let part = reqwest::multipart::Part::bytes(png_bytes)
            .file_name(filename.to_string())
            .mime_str("image/png")
            .map_err(|err| TelegramError(err.to_string()))?;
        let form = reqwest::multipart::Form::new()
            .text("chat_id", self.chat_id.clone())
            .text("caption", caption.to_string())
            .part("photo", part);
        let response = self
            .http
            .post(&url)
            .multipart(form)
            .send()
            .await
            .map_err(|err| TelegramError(err.to_string()))?;
        Self::check(response, "sendPhoto").await
    }
}
