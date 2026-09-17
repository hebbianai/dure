//! An on-demand worker for Dure's stateless orchestration MCP integration.
//!
//! The provider-facing transport and immutable catalogue stay resident. Only
//! our direct worker child is retired; provider/session lifetime is untouched.

use serde_json::{Value, json};
use std::{io, io::Read, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::Instant,
};

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_IDLE_MS: u64 = 300_000;

pub mod memory;

struct Options {
    node: PathBuf,
    worker: PathBuf,
    catalogue: PathBuf,
    receipt: String,
    idle: Duration,
}

impl Options {
    fn parse(arguments: impl Iterator<Item = String>) -> io::Result<Self> {
        let mut arguments = arguments;
        let (mut node, mut worker, mut catalogue, mut idle_ms) = (None, None, None, None);
        let mut receipt = None;
        while let Some(key) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| invalid("missing relay argument"))?;
            let valid = match key.as_str() {
                "--node" => node.replace(PathBuf::from(value)).is_none(),
                "--worker" => worker.replace(PathBuf::from(value)).is_none(),
                "--catalogue" => catalogue.replace(PathBuf::from(value)).is_none(),
                "--receipt-json" => {
                    value.len() <= 16 * 1024
                        && serde_json::from_str::<Value>(&value)
                            .is_ok_and(|value| value.is_object())
                        && receipt.replace(value).is_none()
                }
                "--idle-ms" => {
                    let value = value
                        .parse::<u64>()
                        .map_err(|_| invalid("invalid idle interval"))?;
                    (1..=86_400_000).contains(&value) && idle_ms.replace(value).is_none()
                }
                _ => false,
            };
            if !valid {
                return Err(invalid("invalid or duplicate relay argument"));
            }
        }
        let options = Self {
            node: node.ok_or_else(|| invalid("missing Node executable"))?,
            worker: worker.ok_or_else(|| invalid("missing worker entrypoint"))?,
            catalogue: catalogue.ok_or_else(|| invalid("missing worker catalogue"))?,
            receipt: receipt.ok_or_else(|| invalid("missing integration receipt"))?,
            idle: Duration::from_millis(idle_ms.unwrap_or(DEFAULT_IDLE_MS)),
        };
        if [&options.node, &options.worker, &options.catalogue]
            .iter()
            .any(|path| !path.is_absolute())
        {
            return Err(invalid("relay paths must be absolute"));
        }
        Ok(options)
    }
}

struct Catalogue {
    initialize: Value,
    tools: Value,
}

impl Catalogue {
    fn parse(value: Value) -> io::Result<Self> {
        if value["schemaVersion"] != 1
            || value["kind"] != "dure.mcp.stateless-worker-catalogue"
            || value["initialize"]["capabilities"] != json!({"tools": {}})
            || value["initialize"]["serverInfo"]["name"] != "dure-orchestration"
            || !value["initialize"]["protocolVersion"].is_string()
            || !value["tools"]["tools"].is_array()
        {
            // New stateful capabilities require their own restart contract.
            return Err(invalid("unsupported Dure worker catalogue"));
        }
        Ok(Self {
            initialize: value["initialize"].clone(),
            tools: value["tools"].clone(),
        })
    }

    fn initialize_result(&self, params: &Value) -> Value {
        let mut result = self.initialize.clone();
        if let Some(version) = params
            .get("protocolVersion")
            .filter(|value| !value.is_null())
        {
            result["protocolVersion"] = version.clone();
        }
        result
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Unlike read_line, accumulated bytes survive cancellation by the idle timer.
struct Frames<R> {
    reader: BufReader<R>,
    pending: Vec<u8>,
}

impl<R: AsyncRead + Unpin> Frames<R> {
    fn new(reader: R) -> Self {
        Self {
            reader: BufReader::new(reader),
            pending: Vec::new(),
        }
    }

    async fn next(&mut self) -> io::Result<Option<Value>> {
        loop {
            let available = self.reader.fill_buf().await?;
            if available.is_empty() {
                return if self.pending.is_empty() {
                    Ok(None)
                } else {
                    Err(invalid("truncated MCP frame"))
                };
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let count = newline.map_or(available.len(), |index| index + 1);
            if self.pending.len() + count > MAX_FRAME_BYTES {
                return Err(invalid("MCP frame exceeds its byte limit"));
            }
            self.pending.extend_from_slice(&available[..count]);
            self.reader.consume(count);
            if newline.is_some() {
                let bytes = std::mem::take(&mut self.pending);
                if bytes.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                return serde_json::from_slice(&bytes)
                    .map(Some)
                    .map_err(|_| invalid("invalid MCP JSON"));
            }
        }
    }
}

async fn send(output: &mut (impl AsyncWrite + Unpin), value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() >= MAX_FRAME_BYTES {
        return Err(invalid("MCP frame exceeds its byte limit"));
    }
    output.write_all(&bytes).await?;
    output.write_all(b"\n").await?;
    output.flush().await
}

fn error(id: &Value, message: &str) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32000,"message":message}})
}

struct Worker {
    child: Child,
    input: Option<ChildStdin>,
    output: Frames<ChildStdout>,
    healthy: bool,
}

impl Worker {
    fn spawn(options: &Options) -> io::Result<Self> {
        Self::start(
            Command::new(&options.node)
                .arg(&options.worker)
                .arg("--receipt-json")
                .arg(&options.receipt),
        )
    }

    fn start(command: &mut Command) -> io::Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let input = child.stdin.take().expect("piped worker input");
        let output = child.stdout.take().expect("piped worker output");
        Ok(Self {
            child,
            input: Some(input),
            output: Frames::new(output),
            healthy: false,
        })
    }

    async fn call(&mut self, request: &Value) -> io::Result<Value> {
        send(
            self.input
                .as_mut()
                .ok_or_else(|| invalid("worker is retiring"))?,
            request,
        )
        .await?;
        let response = self
            .output
            .next()
            .await?
            .ok_or_else(|| invalid("worker closed before its response"))?;
        if response["jsonrpc"] != "2.0"
            || response.get("id") != request.get("id")
            || !((response.get("result").is_some() && response.get("error").is_none())
                || (response.get("result").is_none()
                    && response.get("error").is_some_and(Value::is_object)))
        {
            return Err(invalid("worker response did not settle the exact request"));
        }
        Ok(response)
    }

    async fn initialize(&mut self, params: &Value, catalogue: &Catalogue) -> io::Result<()> {
        let response = self.call(&json!({"jsonrpc":"2.0", "id":"dure/initialize", "method":"initialize", "params":params})).await?;
        if response.get("result") != Some(&catalogue.initialize_result(params)) {
            return Err(invalid(
                "worker initialization differs from its immutable catalogue",
            ));
        }
        send(
            self.input.as_mut().expect("open worker input"),
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await?;
        let response = self
            .call(&json!({"jsonrpc":"2.0","id":"dure/tools","method":"tools/list"}))
            .await?;
        if response.get("result") != Some(&catalogue.tools) {
            return Err(invalid(
                "worker tools differ from their immutable catalogue",
            ));
        }
        self.healthy = true;
        Ok(())
    }

    async fn retire(mut self) -> io::Result<()> {
        // EOF lets the existing handler complete its accepted call. Drain its
        // output before wait so a full pipe cannot prevent graceful exit.
        drop(self.input.take());
        let drain = tokio::io::copy(&mut self.output.reader, &mut tokio::io::sink()).await;
        let exited = self.child.wait().await;
        drain?;
        exited.map(|_| ())
    }
}

struct Relay {
    options: Options,
    catalogue: Catalogue,
    worker: Option<Worker>,
    initialization: Option<Value>,
    initialized: bool,
    idle_at: Instant,
}

impl Relay {
    async fn retire(&mut self) -> io::Result<()> {
        if let Some(worker) = self.worker.take() {
            worker.retire().await?;
        }
        Ok(())
    }

    async fn invoke(&mut self, request: &Value) -> Value {
        let id = &request["id"];
        if !self.initialized {
            return error(id, "Dure MCP initialization has not completed");
        }
        if let Some(worker) = &mut self.worker {
            match worker.child.try_wait() {
                Ok(Some(_)) => {
                    if self.retire().await.is_err() {
                        return error(
                            id,
                            "Dure MCP worker exit could not be reconciled; no tool was invoked",
                        );
                    }
                }
                Ok(None) => {}
                Err(_) => {
                    worker.healthy = false;
                    return error(
                        id,
                        "Dure MCP worker lifetime is unknown; no tool was invoked",
                    );
                }
            }
        }
        if self.worker.is_none() {
            match Worker::spawn(&self.options) {
                Ok(worker) => self.worker = Some(worker),
                Err(_) => {
                    return error(
                        id,
                        "Dure MCP worker could not start; the tool was not invoked",
                    );
                }
            }
            let worker = self.worker.as_mut().expect("owned worker");
            let initialization = self.initialization.as_ref().expect("initialized client");
            if worker
                .initialize(initialization, &self.catalogue)
                .await
                .is_err()
            {
                // No tool has been forwarded. A mismatched worker is not an
                // eligible idle resource, and cannot accept subsequent calls.
                return error(
                    id,
                    "Dure MCP worker handshake failed; the tool was not invoked",
                );
            }
        }
        let worker = self.worker.as_mut().expect("owned worker");
        if !worker.healthy {
            return error(
                id,
                "Dure MCP worker state is unknown; no new tool was invoked",
            );
        }
        match worker.call(request).await {
            Ok(response) => response,
            Err(_) => {
                worker.healthy = false;
                error(id, "Dure MCP call outcome is unknown; it was not retried")
            }
        }
    }

    async fn run(
        &mut self,
        input: impl AsyncRead + Unpin,
        mut output: impl AsyncWrite + Unpin,
    ) -> io::Result<()> {
        let mut frames = Frames::new(input);
        loop {
            let can_retire = self.worker.as_ref().is_some_and(|worker| worker.healthy);
            // This loop never runs while a call is in flight. It preserves the
            // existing Dure handler's serial request semantics without a new
            // pending-work registry, polling loop or cancellation-based guess.
            let message = tokio::select! {
                message = frames.next() => message?,
                _ = tokio::time::sleep_until(self.idle_at), if can_retire => {
                    self.retire().await?;
                    continue;
                }
            };
            let Some(message) = message else {
                return Ok(());
            };
            if message["jsonrpc"] != "2.0" {
                return Err(invalid("invalid JSON-RPC version"));
            }
            let method = message["method"].as_str().unwrap_or("");
            let id = message.get("id");
            if id.is_none() {
                if method == "notifications/initialized" && self.initialization.is_some() {
                    self.initialized = true;
                }
                // In particular, cancellation cannot prove worker completion.
                continue;
            }
            let id = id.expect("request id");
            if !id.is_string() && !id.is_number() {
                return Err(invalid("invalid MCP request id"));
            }
            let response = match method {
                "initialize" if self.initialization.is_none() => {
                    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
                    let result = self.catalogue.initialize_result(&params);
                    self.initialization = Some(params);
                    json!({"jsonrpc":"2.0","id":id,"result":result})
                }
                "tools/list" => json!({"jsonrpc":"2.0","id":id,"result":self.catalogue.tools}),
                "ping" => json!({"jsonrpc":"2.0","id":id,"result":{}}),
                "tools/call" => {
                    let response = self.invoke(&message).await;
                    self.idle_at = Instant::now() + self.options.idle;
                    response
                }
                _ => error(id, "Unsupported Dure MCP method"),
            };
            send(&mut output, &response).await?;
        }
    }
}

pub async fn run_from_arguments(arguments: impl Iterator<Item = String>) -> io::Result<()> {
    let options = Options::parse(arguments)?;
    let mut bytes = Vec::new();
    std::fs::File::open(&options.catalogue)?
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(invalid("worker catalogue exceeds its byte limit"));
    }
    let catalogue = Catalogue::parse(serde_json::from_slice(&bytes)?)?;
    let mut relay = Relay {
        options,
        catalogue,
        worker: None,
        initialization: None,
        initialized: false,
        idle_at: Instant::now(),
    };
    let result = relay.run(tokio::io::stdin(), tokio::io::stdout()).await;
    let cleanup = relay.retire().await;
    result.and(cleanup)
}

#[cfg(test)]
mod tests;
