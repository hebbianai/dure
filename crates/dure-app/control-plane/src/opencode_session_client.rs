//! OpenCode's public HTTP session protocol. The provider owns conversation and
//! message identity; callers never select a session by recency or workspace.

use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

use dure_app::{AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1};
use reqwest::{Client, Method, Response, StatusCode};
use serde_json::{Value, json};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// Message page sizes, largest first. A page whose answer is over the
/// response bound is read again at the next smaller size.
const PAGE_SIZES: [usize; 3] = [100, 10, 1];
/// The size of a page that skips one message too large to read.
const UNREADABLE_MESSAGE_BYTES: usize = MAX_RESPONSE_BYTES + 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionId(String);

impl SessionId {
    pub(crate) fn for_binding(
        binding: &dure_app::AgentInteractionBindingV1,
    ) -> Result<Self, Error> {
        use sha2::{Digest, Sha256};
        match binding.provider_conversation_ref.as_deref() {
            Some(id) => Self::parse(id),
            None => Self::parse(&format!(
                "ses_dure_{:x}",
                Sha256::digest(binding.interaction_session_id.as_str().as_bytes())
            )),
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, Error> {
        if !valid_id(value, "ses_") {
            return Err(Error::Identity);
        }
        Ok(Self(value.into()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Error {
    Identity,
    Protocol,
    Unavailable,
    Rejected(u16),
    Limit,
}

/// The address and password come only from the exact managed process receipt.
/// Redirects and proxies cannot redirect a local session mutation elsewhere.
#[derive(Clone)]
pub(crate) struct OpenCodeSessionClient {
    client: Client,
    origin: String,
    password: String,
    directory: String,
}

impl OpenCodeSessionClient {
    pub(crate) async fn connect(endpoint: &Path, directory: &Path) -> Result<Self, Error> {
        use tokio::io::AsyncReadExt;
        let receipt = tokio::time::timeout(Duration::from_secs(5), async {
            let socket = tokio::net::UnixStream::connect(endpoint)
                .await
                .map_err(|_| Error::Unavailable)?;
            let mut bytes = Vec::new();
            socket
                .take(4097)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| Error::Unavailable)?;
            if bytes.len() > 4096 {
                return Err(Error::Limit);
            }
            serde_json::from_slice::<crate::opencode_connection_driver::OpenCodeEndpoint>(&bytes)
                .map_err(|_| Error::Protocol)
        })
        .await
        .map_err(|_| Error::Unavailable)??;
        if receipt.version != 1 {
            return Err(Error::Protocol);
        }
        Self::new(receipt.port, receipt.password, directory)
    }

    pub(crate) fn new(port: u16, password: String, directory: &Path) -> Result<Self, Error> {
        if port == 0 || password.is_empty() || password.len() > 256 || !directory.is_absolute() {
            return Err(Error::Protocol);
        }
        let directory = directory.to_str().ok_or(Error::Protocol)?.to_owned();
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| Error::Unavailable)?;
        Ok(Self {
            client,
            origin: format!("http://127.0.0.1:{port}"),
            password,
            directory,
        })
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.origin))
            .basic_auth("opencode", Some(&self.password))
            .header("x-opencode-directory", &self.directory)
    }

    async fn json(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, Error> {
        let mut request = self.request(method, path).timeout(Duration::from_secs(30));
        if let Some(body) = body {
            request = request.json(&body);
        }
        read_json(request.send().await.map_err(|_| Error::Unavailable)?).await
    }

    pub(crate) async fn health(&self) -> Result<String, Error> {
        let health = self.json(Method::GET, "/global/health", None).await?;
        if health.get("healthy") != Some(&Value::Bool(true)) {
            return Err(Error::Unavailable);
        }
        health
            .get("version")
            .and_then(Value::as_str)
            .filter(|version| !version.is_empty() && version.len() <= 128)
            .map(str::to_owned)
            .ok_or(Error::Protocol)
    }

    pub(crate) async fn catalog(&self) -> Result<Value, Error> {
        let response = self.json(Method::GET, "/config/providers", None).await?;
        let mut models = Vec::new();
        for provider in response
            .get("providers")
            .and_then(Value::as_array)
            .ok_or(Error::Protocol)?
        {
            let provider_id = provider
                .get("id")
                .and_then(Value::as_str)
                .ok_or(Error::Protocol)?;
            for (id, model) in provider
                .get("models")
                .and_then(Value::as_object)
                .ok_or(Error::Protocol)?
            {
                let value = AgentSpawnModelSelectionV1::parse(&format!("{provider_id}/{id}"))
                    .map_err(|_| Error::Protocol)?;
                let efforts = model
                    .get("variants")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flat_map(|variants| variants.keys())
                    .map(|effort| {
                        AgentSpawnEffortSelectionV1::parse(effort)
                            .map(|effort| effort.as_str().to_owned())
                            .map_err(|_| Error::Protocol)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                models.push(json!({"value": value.as_str(), "displayName": model.get("name").and_then(Value::as_str).unwrap_or(id), "supportsEffort": !efforts.is_empty(), "supportedEffortLevels": efforts}));
            }
        }
        Ok(json!({"models": models}))
    }

    /// V2 allocation accepts a caller-owned identity and replays it exactly.
    /// Turn execution deliberately uses the separately qualified session API;
    /// a documented V2 prompt/wait route alone is not execution capability.
    pub(crate) async fn create(&self, id: &SessionId) -> Result<Value, Error> {
        let response = self
            .json(
                Method::POST,
                "/api/session",
                Some(json!({
                    "id": id.as_str(), "location": { "directory": self.directory }
                })),
            )
            .await?;
        let session = response.get("data").ok_or(Error::Protocol)?;
        verify_session(session, id, &self.directory)?;
        Ok(session.clone())
    }

    pub(crate) async fn session(&self, id: &SessionId) -> Result<Value, Error> {
        let session = self
            .json(Method::GET, &format!("/session/{}", id.as_str()), None)
            .await?;
        verify_session(&session, id, &self.directory)?;
        Ok(session)
    }

    pub(crate) async fn prompt(
        &self,
        id: &SessionId,
        message_id: &str,
        input: &str,
        model: Option<&AgentSpawnModelSelectionV1>,
        effort: Option<&AgentSpawnEffortSelectionV1>,
    ) -> Result<(), Error> {
        let body = prompt_body(message_id, input, model, effort)?;
        self.json(
            Method::POST,
            &format!("/session/{}/prompt_async", id.as_str()),
            Some(body),
        )
        .await?;
        Ok(())
    }

    /// Records a user message that asks for no reply, as another client of
    /// the same conversation may have recorded it.
    #[cfg(test)]
    pub(crate) async fn record_without_reply(
        &self,
        id: &SessionId,
        message_id: &str,
        input: &str,
    ) -> Result<(), Error> {
        let mut body = prompt_body(message_id, input, None, None)?;
        body["noReply"] = json!(true);
        self.json(
            Method::POST,
            &format!("/session/{}/prompt_async", id.as_str()),
            Some(body),
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn message(
        &self,
        id: &SessionId,
        message_id: &str,
    ) -> Result<Option<Value>, Error> {
        if !valid_id(message_id, "msg_") {
            return Err(Error::Identity);
        }
        match self
            .json(
                Method::GET,
                &format!("/session/{}/message/{message_id}", id.as_str()),
                None,
            )
            .await
        {
            Ok(message) => {
                verify_message(&message, id)?;
                if message.pointer("/info/id").and_then(Value::as_str) != Some(message_id) {
                    return Err(Error::Identity);
                }
                Ok(Some(message))
            }
            Err(Error::Rejected(404)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The session's messages, newest page first, which a caller reads back as
    /// far as it needs.
    pub(crate) fn message_pages<'a>(&'a self, id: &'a SessionId) -> MessagePages<'a> {
        MessagePages {
            client: self,
            session: id,
            before: None,
            exhausted: false,
            size: 0,
            cursors: BTreeSet::new(),
            message_ids: BTreeSet::new(),
        }
    }

    /// The session's whole history, oldest first.
    #[cfg(test)]
    pub(crate) async fn messages(&self, id: &SessionId) -> Result<Vec<Value>, Error> {
        let mut pages = self.message_pages(id);
        let mut newest_first = Vec::new();
        while let Some(page) = pages.next().await? {
            newest_first.push(page.messages);
        }
        Ok(newest_first.into_iter().rev().flatten().collect())
    }

    /// One page of at most `limit` messages before the opaque cursor, oldest
    /// first, or `None` when its answer is over the response bound; and the
    /// cursor of the page before it.
    async fn message_page(
        &self,
        id: &SessionId,
        before: Option<&str>,
        limit: usize,
    ) -> Result<(Option<MessagePage>, Option<String>), Error> {
        let mut query = vec![("limit", limit.to_string())];
        if let Some(cursor) = before {
            query.push(("before", cursor.to_owned()));
        }
        let response = self
            .request(Method::GET, &format!("/session/{}/message", id.as_str()))
            .query(&query)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| Error::Unavailable)?;
        let next = response
            .headers()
            .get("x-next-cursor")
            .map(|header| {
                header
                    .to_str()
                    .map(str::to_owned)
                    .map_err(|_| Error::Protocol)
            })
            .transpose()?;
        let (value, bytes) = match read_json_sized(response).await {
            Ok(answer) => answer,
            Err(Error::Limit) => return Ok((None, next)),
            Err(error) => return Err(error),
        };
        let Value::Array(messages) = value else {
            return Err(Error::Protocol);
        };
        if messages.len() > limit || (next.is_some() && messages.is_empty()) {
            return Err(Error::Protocol);
        }
        let page = MessagePage {
            messages,
            bytes,
            unreadable: false,
        };
        Ok((Some(page), next))
    }

    pub(crate) async fn is_busy(&self, id: &SessionId) -> Result<bool, Error> {
        let statuses = self.json(Method::GET, "/session/status", None).await?;
        let statuses = statuses.as_object().ok_or(Error::Protocol)?;
        let Some(status) = statuses.get(id.as_str()) else {
            return Ok(false);
        };
        match status.get("type") {
            Some(Value::String(status)) if status == "idle" => Ok(false),
            Some(Value::String(status)) if status == "busy" || status == "retry" => Ok(true),
            _ => Err(Error::Protocol),
        }
    }

    pub(crate) async fn abort(&self, id: &SessionId) -> Result<(), Error> {
        self.json(
            Method::POST,
            &format!("/session/{}/abort", id.as_str()),
            None,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn events(&self) -> Result<OpenCodeEvents, Error> {
        let response = self
            .request(Method::GET, "/event")
            .send()
            .await
            .map_err(|_| Error::Unavailable)?;
        if !response.status().is_success() {
            return Err(Error::Rejected(response.status().as_u16()));
        }
        Ok(OpenCodeEvents {
            response,
            buffer: Vec::new(),
        })
    }

    pub(crate) async fn pending(
        &self,
        session: &SessionId,
    ) -> Result<Vec<(PendingKind, Value)>, Error> {
        let mut pending = Vec::new();
        for kind in [PendingKind::Permission, PendingKind::Question] {
            let entries = self.json(Method::GET, kind.path(), None).await?;
            for entry in entries.as_array().ok_or(Error::Protocol)? {
                if entry.get("sessionID").and_then(Value::as_str) == Some(session.as_str()) {
                    let id = entry
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or(Error::Identity)?;
                    if !valid_id(id, kind.prefix()) {
                        return Err(Error::Identity);
                    }
                    pending.push((kind, entry.clone()));
                }
            }
        }
        Ok(pending)
    }

    pub(crate) async fn reply(
        &self,
        kind: PendingKind,
        id: &str,
        body: Value,
    ) -> Result<(), Error> {
        if !valid_id(id, kind.prefix()) {
            return Err(Error::Identity);
        }
        self.json(
            Method::POST,
            &format!("{}/{id}/reply", kind.path()),
            Some(body),
        )
        .await?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PendingKind {
    Permission,
    Question,
}

impl PendingKind {
    fn path(self) -> &'static str {
        match self {
            Self::Permission => "/permission",
            Self::Question => "/question",
        }
    }
    fn prefix(self) -> &'static str {
        match self {
            Self::Permission => "per_",
            Self::Question => "que_",
        }
    }
}

/// One page of a session's messages, oldest first.
pub(crate) struct MessagePage {
    pub(crate) messages: Vec<Value>,
    /// The size in bytes of the provider's answer for this page.
    pub(crate) bytes: usize,
    /// The page is one message too large to read, which it skips: it holds
    /// no messages.
    pub(crate) unreadable: bool,
}

/// A session's messages, read back from the newest through opaque cursors on
/// the same exact session endpoint. Each message belongs to the session and
/// appears once across pages.
pub(crate) struct MessagePages<'a> {
    client: &'a OpenCodeSessionClient,
    session: &'a SessionId,
    before: Option<String>,
    exhausted: bool,
    /// The index in [`PAGE_SIZES`] the next page is first asked for at.
    size: usize,
    cursors: BTreeSet<String>,
    message_ids: BTreeSet<String>,
}

impl MessagePages<'_> {
    /// The page before the last one read, or `None` past the session's start.
    /// A message alone over the response bound is skipped unread, as an
    /// [`MessagePage::unreadable`] page.
    pub(crate) async fn next(&mut self) -> Result<Option<MessagePage>, Error> {
        if self.exhausted {
            return Ok(None);
        }
        let (page, next) = loop {
            let (page, next) = self
                .client
                .message_page(self.session, self.before.as_deref(), PAGE_SIZES[self.size])
                .await?;
            match page {
                Some(page) => break (page, next),
                None if self.size + 1 < PAGE_SIZES.len() => self.size += 1,
                None => {
                    let page = MessagePage {
                        messages: Vec::new(),
                        bytes: UNREADABLE_MESSAGE_BYTES,
                        unreadable: true,
                    };
                    break (page, next);
                }
            }
        };
        // The next page starts at the largest size whose answer the average
        // message of this one fits, so pages of large messages are not first
        // asked for at a size they cannot be read at.
        if let Some(average) = page.bytes.checked_div(page.messages.len()) {
            self.size = PAGE_SIZES
                .iter()
                .position(|size| average.saturating_mul(*size) <= MAX_RESPONSE_BYTES)
                .unwrap_or(PAGE_SIZES.len() - 1);
        }
        for message in &page.messages {
            let message_id = verify_message(message, self.session)?;
            if !self.message_ids.insert(message_id.to_owned()) {
                return Err(Error::Identity);
            }
        }
        match next {
            Some(cursor) => {
                if cursor.is_empty() || cursor.len() > 4096 || !self.cursors.insert(cursor.clone())
                {
                    return Err(Error::Protocol);
                }
                self.before = Some(cursor);
            }
            None => self.exhausted = true,
        }
        Ok(Some(page))
    }

    /// Whether older messages precede the last page read.
    pub(crate) fn has_older(&self) -> bool {
        !self.exhausted
    }
}

pub(crate) struct OpenCodeEvents {
    response: Response,
    buffer: Vec<u8>,
}

impl OpenCodeEvents {
    pub(crate) async fn next(&mut self) -> Result<Value, Error> {
        loop {
            let boundary = self
                .buffer
                .windows(2)
                .position(|bytes| bytes == b"\n\n")
                .map(|end| end + 2)
                .into_iter()
                .chain(
                    self.buffer
                        .windows(4)
                        .position(|bytes| bytes == b"\r\n\r\n")
                        .map(|end| end + 4),
                )
                .min();
            if let Some(end) = boundary {
                let frame = self.buffer.drain(..end).collect::<Vec<_>>();
                let frame = std::str::from_utf8(&frame).map_err(|_| Error::Protocol)?;
                let data = frame
                    .lines()
                    .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !data.is_empty() {
                    return serde_json::from_str(&data).map_err(|_| Error::Protocol);
                }
                continue;
            }
            let chunk = tokio::time::timeout(Duration::from_secs(45), self.response.chunk())
                .await
                .map_err(|_| Error::Unavailable)?
                .map_err(|_| Error::Unavailable)?
                .ok_or(Error::Unavailable)?;
            if self.buffer.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(Error::Limit);
            }
            self.buffer.extend_from_slice(&chunk);
        }
    }
}

fn prompt_body(
    message_id: &str,
    input: &str,
    model: Option<&AgentSpawnModelSelectionV1>,
    effort: Option<&AgentSpawnEffortSelectionV1>,
) -> Result<Value, Error> {
    if !valid_id(message_id, "msg_") || input.is_empty() || input.len() > MAX_RESPONSE_BYTES {
        return Err(Error::Identity);
    }
    let mut body = json!({"messageID": message_id, "parts": [{"type": "text", "text": input}]});
    if let Some(model) = model {
        let (provider, model) = model.as_str().split_once('/').ok_or(Error::Protocol)?;
        if provider.is_empty() || model.is_empty() {
            return Err(Error::Protocol);
        }
        body["model"] = json!({"providerID": provider, "modelID": model});
    }
    if let Some(effort) = effort {
        body["variant"] = json!(effort.as_str());
    }
    Ok(body)
}

fn valid_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() > prefix.len()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn verify_session(session: &Value, id: &SessionId, directory: &str) -> Result<(), Error> {
    if session.get("id").and_then(Value::as_str) != Some(id.as_str())
        || session
            .get("directory")
            .or_else(|| session.pointer("/location/directory"))
            .and_then(Value::as_str)
            != Some(directory)
    {
        return Err(Error::Identity);
    }
    Ok(())
}

fn verify_message<'a>(message: &'a Value, session: &SessionId) -> Result<&'a str, Error> {
    let id = message
        .pointer("/info/id")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id, "msg_"))
        .ok_or(Error::Identity)?;
    if message.pointer("/info/sessionID").and_then(Value::as_str) != Some(session.as_str()) {
        return Err(Error::Identity);
    }
    for part in message
        .get("parts")
        .and_then(Value::as_array)
        .ok_or(Error::Protocol)?
    {
        if part.get("sessionID").and_then(Value::as_str) != Some(session.as_str())
            || part.get("messageID").and_then(Value::as_str) != Some(id)
        {
            return Err(Error::Identity);
        }
    }
    Ok(id)
}

async fn read_json(response: Response) -> Result<Value, Error> {
    read_json_sized(response).await.map(|(value, _)| value)
}

/// The answer's JSON and its size, within the response bound.
async fn read_json_sized(mut response: Response) -> Result<(Value, usize), Error> {
    let status = response.status();
    if !status.is_success() {
        return Err(Error::Rejected(status.as_u16()));
    }
    if status == StatusCode::NO_CONTENT {
        return Ok((Value::Null, 0));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(Error::Limit);
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes).map_err(|_| Error::Protocol)?;
    Ok((value, bytes.len()))
}

#[cfg(test)]
mod tests;
