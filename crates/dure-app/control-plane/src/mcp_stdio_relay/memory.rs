//! Explicit restart contract for @modelcontextprotocol/server-memory 2026.8.31.
//! Graph calls commit to the selected file before replying. Subscriptions do
//! not: their worker must remain alive. This is not a generic MCP idle policy.

use super::{DEFAULT_IDLE_MS, Frames, Worker, error, invalid, send};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{self, Read},
    path::PathBuf,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    process::Command,
    time::Instant,
};

const WORKER_SHA256: &str = include_str!("../../../../../cli/lib/mcp-memory-worker.sha256");
const MAX_PENDING: usize = 1024;

struct Options {
    node: PathBuf,
    worker: PathBuf,
    memory_file: PathBuf,
    idle: Duration,
}

impl Options {
    fn parse(mut arguments: impl Iterator<Item = String>) -> io::Result<Self> {
        let (mut node, mut worker, mut memory_file, mut idle_ms) = (None, None, None, None);
        while let Some(key) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| invalid("missing Memory relay argument"))?;
            let valid = match key.as_str() {
                "--node" => node.replace(PathBuf::from(value)).is_none(),
                "--worker" => worker.replace(PathBuf::from(value)).is_none(),
                "--memory-file" => memory_file.replace(PathBuf::from(value)).is_none(),
                "--idle-ms" => {
                    let value = value
                        .parse::<u64>()
                        .map_err(|_| invalid("invalid idle interval"))?;
                    (1..=86_400_000).contains(&value) && idle_ms.replace(value).is_none()
                }
                _ => false,
            };
            if !valid {
                return Err(invalid("invalid or duplicate Memory relay argument"));
            }
        }
        let options = Self {
            node: node.ok_or_else(|| invalid("missing Node executable"))?,
            worker: worker.ok_or_else(|| invalid("missing Memory worker entrypoint"))?,
            memory_file: memory_file
                .ok_or_else(|| invalid("an explicit Memory data file is required"))?,
            idle: Duration::from_millis(idle_ms.unwrap_or(DEFAULT_IDLE_MS)),
        };
        if [&options.node, &options.worker, &options.memory_file]
            .iter()
            .any(|path| !path.is_absolute())
        {
            return Err(invalid("Memory relay paths must be absolute"));
        }
        Ok(options)
    }

    fn spawn(&self) -> io::Result<Worker> {
        // Do not infer persistence from a server name or tools schema. A new
        // implementation needs a reviewed restart contract, not an opt-in hash.
        let mut source = Vec::new();
        std::fs::File::open(&self.worker)?
            .take(1024 * 1024)
            .read_to_end(&mut source)?;
        if format!("{:x}", Sha256::digest(&source)) != WORKER_SHA256.trim() {
            return Err(invalid(
                "unsupported Memory worker source; no call was forwarded",
            ));
        }
        Worker::start(
            Command::new(&self.node)
                .arg(&self.worker)
                .env("MEMORY_FILE_PATH", &self.memory_file),
        )
    }
}

enum Request {
    Initialize(Value),
    Subscribe(String),
    Unsubscribe(String),
    Call,
}

#[derive(Default)]
struct State {
    pending: HashMap<String, Request>,
    subscriptions: HashSet<String>,
    initialization: Option<(Value, Value)>,
    initialized: bool,
    pinned: bool,
}

fn id_key(message: &Value) -> io::Result<String> {
    let id = &message["id"];
    if !id.is_string() && !id.is_number() {
        return Err(invalid("invalid Memory MCP request id"));
    }
    Ok(id.to_string())
}

impl State {
    fn can_retire(&self) -> bool {
        self.initialized && !self.pinned && self.pending.is_empty() && self.subscriptions.is_empty()
    }

    fn request(&mut self, message: &Value) -> io::Result<()> {
        let id = id_key(message)?;
        if self.pending.contains_key(&id) || self.pending.len() >= MAX_PENDING {
            return Err(invalid(
                "duplicate or excessive pending Memory MCP requests",
            ));
        }
        let request = match message["method"].as_str() {
            Some("initialize") if self.initialization.is_none() && self.pending.is_empty() => {
                Request::Initialize(message["params"].clone())
            }
            Some("initialize") => return Err(invalid("Memory MCP was already initialized")),
            Some("resources/subscribe" | "resources/unsubscribe") => {
                let uri = message["params"]["uri"]
                    .as_str()
                    .ok_or_else(|| invalid("missing subscription URI"))?
                    .to_owned();
                if self.pending.values().any(|request| {
                    matches!(request, Request::Subscribe(_) | Request::Unsubscribe(_))
                }) {
                    // Concurrent subscription changes do not prove their apply
                    // order from response order; preserve the worker instead.
                    self.pinned = true;
                }
                if message["method"] == "resources/subscribe" {
                    Request::Subscribe(uri)
                } else {
                    Request::Unsubscribe(uri)
                }
            }
            Some(
                "tools/list"
                | "tools/call"
                | "resources/list"
                | "resources/read"
                | "resources/templates/list"
                | "ping",
            ) => Request::Call,
            _ => {
                self.pinned = true;
                Request::Call
            }
        };
        if message["params"].get("task").is_some() {
            self.pinned = true;
        }
        self.pending.insert(id, request);
        Ok(())
    }

    fn response(&mut self, message: &Value) -> io::Result<()> {
        if message["jsonrpc"] != "2.0"
            || !((message.get("result").is_some() && message.get("error").is_none())
                || (message.get("result").is_none()
                    && message.get("error").is_some_and(Value::is_object)))
        {
            return Err(invalid("Memory response does not settle a request"));
        }
        let request = self
            .pending
            .remove(&id_key(message)?)
            .ok_or_else(|| invalid("unknown Memory response id"))?;
        let success = message.get("result").is_some();
        match request {
            Request::Initialize(params) => {
                let result = &message["result"];
                if !success
                    || result["serverInfo"] != json!({"name":"memory-server","version":"0.6.3"})
                    || result["capabilities"]
                        != json!({"tools":{"listChanged":true},"resources":{"listChanged":true,"subscribe":true}})
                    || !result["protocolVersion"].is_string()
                {
                    return Err(invalid("unsupported Memory MCP capabilities"));
                }
                self.initialization = Some((params, result.clone()));
            }
            Request::Subscribe(uri) if success => {
                if self.subscriptions.len() >= MAX_PENDING {
                    self.pinned = true;
                }
                if !self.pinned {
                    self.subscriptions.insert(uri);
                }
            }
            Request::Unsubscribe(uri) if success => {
                self.subscriptions.remove(&uri);
            }
            Request::Subscribe(_) | Request::Unsubscribe(_) => self.pinned = true,
            Request::Call => {}
        }
        Ok(())
    }

    fn notification(&mut self, message: &Value, from_client: bool) {
        match (from_client, message["method"].as_str()) {
            (true, Some("notifications/initialized")) if self.initialization.is_some() => {
                self.initialized = true
            }
            // Cancellation is forwarded, but pending work stays pending until
            // its actual response. A cancelled call with no response pins idle.
            (true, Some("notifications/cancelled")) => {}
            (false, Some("notifications/resources/updated" | "notifications/progress")) => {}
            _ => self.pinned = true,
        }
    }
}

struct Relay {
    options: Options,
    state: State,
    worker: Option<Worker>,
    idle_at: Instant,
}

impl Relay {
    async fn retire(&mut self) -> io::Result<()> {
        if let Some(worker) = self.worker.take() {
            worker.retire().await?;
        }
        Ok(())
    }

    async fn wake(&mut self) -> io::Result<()> {
        if self.worker.is_some() {
            return Ok(());
        }
        self.worker = Some(self.options.spawn()?);
        let worker = self.worker.as_mut().expect("owned Memory worker");
        if let Some((params, expected)) = &self.state.initialization {
            let response = worker.call(&json!({"jsonrpc":"2.0","id":"dure/memory-initialize","method":"initialize","params":params})).await?;
            if response.get("result") != Some(expected) {
                return Err(invalid(
                    "Memory restart handshake changed; no call was forwarded",
                ));
            }
            send(
                worker.input.as_mut().expect("open worker input"),
                &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            )
            .await?;
        }
        Ok(())
    }

    async fn run(
        &mut self,
        input: impl AsyncRead + Unpin,
        mut output: impl AsyncWrite + Unpin,
    ) -> io::Result<()> {
        let mut input = Frames::new(input);
        loop {
            let can_retire = self.worker.is_some() && self.state.can_retire();
            let worker_read = async {
                match &mut self.worker {
                    Some(worker) => worker.output.next().await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                biased;
                message = input.next() => {
                    let Some(message) = message? else { return Ok(()); };
                    if message["jsonrpc"] != "2.0" { return Err(invalid("invalid Memory JSON-RPC version")); }
                    if message.get("method").is_some() && message.get("id").is_some() {
                        // Keepalives do not need to start a dormant data worker.
                        if message["method"] == "ping" && self.state.initialized {
                            id_key(&message)?;
                            send(&mut output, &json!({"jsonrpc":"2.0","id":message["id"],"result":{}})).await?;
                            continue;
                        }
                        if !self.state.initialized && message["method"] != "initialize" {
                            send(&mut output, &error(&message["id"], "Memory MCP initialization has not completed")).await?;
                            continue;
                        }
                        self.wake().await?;
                        self.state.request(&message)?;
                    } else if message.get("method").is_some() {
                        self.state.notification(&message, true);
                    } else {
                        // Responses to an unexpected server-initiated request
                        // pass through without granting idle retirement.
                        self.state.pinned = true;
                    }
                    if self.state.pinned && self.worker.is_none() {
                        // Preserve new session state even when it arrives as a
                        // notification, rather than losing it while dormant.
                        self.wake().await?;
                    }
                    if let Some(worker) = &mut self.worker {
                        send(worker.input.as_mut().expect("open worker input"), &message).await?;
                    }
                    self.idle_at = Instant::now() + self.options.idle;
                }
                message = worker_read => {
                    // Unexpected exit is not idle retirement and never grants
                    // an automatic retry of a possibly committed mutation.
                    let message = message?.ok_or_else(|| invalid("Memory worker disconnected; calls were not replayed"))?;
                    if message["jsonrpc"] != "2.0" { return Err(invalid("invalid Memory JSON-RPC version")); }
                    if message.get("method").is_some() {
                        if message.get("id").is_some() { self.state.pinned = true; }
                        else { self.state.notification(&message, false); }
                    } else { self.state.response(&message)?; }
                    send(&mut output, &message).await?;
                    self.idle_at = Instant::now() + self.options.idle;
                }
                _ = tokio::time::sleep_until(self.idle_at), if can_retire => {
                    if self.worker.as_ref().is_some_and(|worker| !worker.output.pending.is_empty()) {
                        self.state.pinned = true;
                        continue;
                    }
                    // EOF and exact Child::wait complete before any successor
                    // is started. No PID census, signals or provider restart.
                    self.retire().await?;
                }
            }
        }
    }
}

pub async fn run_from_arguments(arguments: impl Iterator<Item = String>) -> io::Result<()> {
    let mut relay = Relay {
        options: Options::parse(arguments)?,
        state: State::default(),
        worker: None,
        idle_at: Instant::now(),
    };
    let result = relay.run(tokio::io::stdin(), tokio::io::stdout()).await;
    let cleanup = relay.retire().await;
    result.and(cleanup)
}

#[cfg(test)]
mod tests;
