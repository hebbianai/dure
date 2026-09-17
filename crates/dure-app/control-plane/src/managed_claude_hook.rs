//! Bounded transport for the app-owned Claude hook. The app's existing hook
//! endpoint normalizes the event and the Host owns identity/activity admission.

mod coalescing;
mod descriptor;

use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use reqwest::{
    Client, Response,
    header::{HeaderMap, HeaderValue},
};
use serde_json::Value;
use tokio::io::AsyncReadExt;

const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const TOTAL_TIMEOUT: Duration = Duration::from_millis(2_400);
const CAPABILITY: &str = "managed_claude_host_report_causality_v1";
const SOURCE_SEQUENCE_HEADER: &str = "x-hebbian-hmux-source-sequence";
const FENCE_HEADERS: [(&str, &str); 7] = [
    ("X-Hebbian-Hmux-Session-Id", "HMUX_SESSION_ID"),
    ("X-Hebbian-Hmux-Workspace-Id", "HMUX_WORKSPACE_ID"),
    ("X-Hebbian-Hmux-Runner-Principal", "HMUX_RUNNER_PRINCIPAL"),
    ("X-Hebbian-Hmux-Runner-Instance", "HMUX_RUNNER_INSTANCE"),
    ("X-Hebbian-Hmux-Channel-Epoch", "HMUX_CHANNEL_EPOCH"),
    ("X-Hebbian-Hmux-Host-Instance-Id", "HMUX_HOST_INSTANCE_ID"),
    ("X-Hebbian-Hmux-Terminal-Epoch", "HMUX_TERMINAL_EPOCH"),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HookFailure {
    InputUnavailable,
    InvalidInput,
    InvalidFence,
    Unavailable,
    Timeout,
}

impl HookFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::InputUnavailable => "managed_hook_input_unavailable",
            Self::InvalidInput => "managed_hook_input_invalid",
            Self::InvalidFence => "managed_hook_fence_invalid",
            Self::Unavailable => "managed_hook_report_unavailable",
            Self::Timeout => "managed_hook_report_timeout",
        }
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte))
}

/// Shared with the direct Python hook: a host-wide clock captured before any
/// input or transport wait, never a receiver timestamp or process-local epoch.
#[cfg(unix)]
fn source_sequence() -> Result<u64, HookFailure> {
    let mut time = std::mem::MaybeUninit::<libc::timespec>::uninit();
    // SAFETY: clock_gettime writes one timespec to a valid output pointer.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, time.as_mut_ptr()) } != 0 {
        return Err(HookFailure::Unavailable);
    }
    // SAFETY: the successful call initialized the timespec.
    let time = unsafe { time.assume_init() };
    u64::try_from(time.tv_sec)
        .ok()
        .and_then(|seconds| seconds.checked_mul(1_000_000_000))
        .and_then(|nanos| nanos.checked_add(u64::try_from(time.tv_nsec).ok()?))
        .filter(|sequence| *sequence > 0)
        .ok_or(HookFailure::Unavailable)
}

#[cfg(windows)]
fn source_sequence() -> Result<u64, HookFailure> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn QueryPerformanceCounter(value: *mut i64) -> i32;
        fn QueryPerformanceFrequency(value: *mut i64) -> i32;
    }
    let (mut counter, mut frequency) = (0_i64, 0_i64);
    // SAFETY: both Windows APIs receive valid writable LARGE_INTEGER pointers.
    if unsafe {
        QueryPerformanceCounter(&mut counter) == 0 || QueryPerformanceFrequency(&mut frequency) == 0
    } || counter <= 0
        || frequency <= 0
    {
        return Err(HookFailure::Unavailable);
    }
    u64::try_from((counter as u128) * 1_000_000_000 / (frequency as u128))
        .map_err(|_| HookFailure::Unavailable)
}

fn fence_headers(environment: &BTreeMap<String, String>) -> Result<HeaderMap, HookFailure> {
    let mut headers = HeaderMap::new();
    for (header, variable) in FENCE_HEADERS {
        let value = environment
            .get(variable)
            .ok_or(HookFailure::InvalidFence)?
            .trim();
        let valid = if variable == "HMUX_CHANNEL_EPOCH" {
            value.parse::<u64>().is_ok_and(|epoch| epoch > 0)
                && value.bytes().all(|byte| byte.is_ascii_digit())
        } else {
            identifier(value)
        };
        if !valid {
            return Err(HookFailure::InvalidFence);
        }
        headers.insert(
            reqwest::header::HeaderName::from_bytes(header.as_bytes())
                .map_err(|_| HookFailure::InvalidFence)?,
            HeaderValue::from_str(value).map_err(|_| HookFailure::InvalidFence)?,
        );
    }
    Ok(headers)
}

#[derive(Debug, PartialEq)]
struct Input {
    body: Vec<u8>,
    pre_tool_conversation: Option<String>,
}

fn bounded_body(raw: Vec<u8>) -> Result<Input, HookFailure> {
    if raw.is_empty() || raw.len() > MAX_INPUT_BYTES {
        return Err(HookFailure::InvalidInput);
    }
    let input: Value = serde_json::from_slice(&raw).map_err(|_| HookFailure::InvalidInput)?;
    let object = input.as_object().ok_or(HookFailure::InvalidInput)?;
    let pre_tool_conversation = (object.get("hook_event_name").and_then(Value::as_str)
        == Some("PreToolUse"))
    .then(|| {
        object
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|value| identifier(value))
            .map(str::to_owned)
    })
    .flatten();
    if raw.len() <= MAX_BODY_BYTES {
        return Ok(Input {
            body: raw,
            pre_tool_conversation,
        });
    }
    let mut minimal = serde_json::Map::new();
    for field in [
        "hook_event_name",
        "session_id",
        "prompt_id",
        "notification_type",
        "tool_name",
        "transcript_path",
    ] {
        if let Some(value) = object.get(field).and_then(Value::as_str) {
            minimal.insert(field.into(), Value::String(value.into()));
        }
    }
    if let Some(prompt) = object.get("prompt").and_then(Value::as_str) {
        minimal.insert(
            "prompt".into(),
            Value::String(prompt.chars().take(4096).collect()),
        );
    }
    // Empty registries are complete evidence. Nonempty or malformed values
    // may degrade to unknown, but never to fabricated quiescence.
    for field in ["background_tasks", "session_crons"] {
        if object
            .get(field)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            minimal.insert(field.into(), Value::Array(Vec::new()));
        }
    }
    let body = serde_json::to_vec(&minimal).map_err(|_| HookFailure::InvalidInput)?;
    if body.len() > MAX_BODY_BYTES {
        return Err(HookFailure::InvalidInput);
    }
    Ok(Input {
        body,
        pre_tool_conversation,
    })
}

async fn bounded_response(mut response: Response) -> Result<Vec<u8>, HookFailure> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| HookFailure::Unavailable)?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(HookFailure::Unavailable);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn deliver(
    root: descriptor::AppRoot,
    headers: HeaderMap,
    raw: Vec<u8>,
    deadline: Instant,
) -> Result<(), HookFailure> {
    let input = bounded_body(raw)?;
    let stamp = input
        .pre_tool_conversation
        .as_deref()
        .map(|conversation| coalescing::Stamp::new(&root.path, conversation, &headers));
    if stamp.as_ref().is_some_and(coalescing::Stamp::recent) {
        return Ok(());
    }
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| HookFailure::Unavailable)?;
    let template = client
        .post("http://127.0.0.1/hooks/claude")
        .headers(headers)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(input.body)
        .timeout(Duration::from_millis(1_500))
        .build()
        .map_err(|_| HookFailure::Unavailable)?;
    for candidate in descriptor::candidates(&root.path, deadline) {
        if Instant::now() >= deadline {
            return Err(HookFailure::Timeout);
        }
        let Some(descriptor) = descriptor::read(&root.path, &candidate) else {
            continue;
        };
        let ping = client
            .get(format!("http://127.0.0.1:{}/ping", descriptor.port))
            .bearer_auth(&descriptor.report_token)
            .timeout(Duration::from_millis(350))
            .send()
            .await;
        let Ok(ping) = ping else { continue };
        if !ping.status().is_success() {
            continue;
        }
        let Ok(ping) = bounded_response(ping).await else {
            continue;
        };
        let Ok(ping) = serde_json::from_slice::<Value>(&ping) else {
            continue;
        };
        if ping.get("ok") != Some(&Value::Bool(true))
            || ping.get("channel").and_then(Value::as_str) != Some(&descriptor.channel)
            || ping.get("generation").and_then(Value::as_str) != Some(&descriptor.generation)
            || ping.get("processId").and_then(Value::as_u64)
                != Some(u64::from(descriptor.process_id))
            || !ping
                .get("capabilities")
                .and_then(Value::as_array)
                .is_some_and(|values| {
                    values
                        .iter()
                        .any(|value| value.as_str() == Some(CAPABILITY))
                })
        {
            continue;
        }
        let mut request = template.try_clone().ok_or(HookFailure::InvalidInput)?;
        request
            .url_mut()
            .set_port(Some(descriptor.port))
            .map_err(|_| HookFailure::Unavailable)?;
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {}", descriptor.report_token))
                .map_err(|_| HookFailure::Unavailable)?;
        authorization.set_sensitive(true);
        request
            .headers_mut()
            .insert(reqwest::header::AUTHORIZATION, authorization);
        let sent = client.execute(request).await;
        if let Ok(response) = sent {
            if response.status().is_success() && bounded_response(response).await.is_ok() {
                if root.writable {
                    if let Some(stamp) = &stamp {
                        stamp.record();
                    }
                }
                return Ok(());
            }
        }
    }
    Err(HookFailure::Unavailable)
}

/// One invocation owns one deadline, including input and discovery. Neither
/// provider input nor descriptor credentials are included in failure output.
pub async fn run() -> Result<(), HookFailure> {
    let sequence = source_sequence()?;
    let environment = FENCE_HEADERS
        .iter()
        .filter_map(|(_, variable)| {
            std::env::var(variable)
                .ok()
                .map(|value| ((*variable).into(), value))
        })
        .collect();
    let mut headers = fence_headers(&environment)?;
    headers.insert(
        SOURCE_SEQUENCE_HEADER,
        HeaderValue::from_str(&sequence.to_string()).map_err(|_| HookFailure::Unavailable)?,
    );
    let root = descriptor::app_root().ok_or(HookFailure::Unavailable)?;
    let deadline = Instant::now() + TOTAL_TIMEOUT;
    tokio::time::timeout(TOTAL_TIMEOUT, async {
        let mut raw = Vec::new();
        tokio::io::stdin()
            .take((MAX_INPUT_BYTES + 1) as u64)
            .read_to_end(&mut raw)
            .await
            .map_err(|_| HookFailure::InputUnavailable)?;
        deliver(root, headers, raw, deadline).await
    })
    .await
    .map_err(|_| HookFailure::Timeout)?
}

#[cfg(test)]
mod tests;
