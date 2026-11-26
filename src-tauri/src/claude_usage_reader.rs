//! Claude's reader for the app's account usage check.
//!
//! The statusLine input Claude Code gives the collector carries only the
//! 5-hour and overall weekly windows. Claude Code's `/usage` view asks the
//! account usage endpoint, which also reports each model's own weekly window.
//! This reader makes that request with the account's stored login.
//!
//! Claude Code stays the only writer of that login: an access token past its
//! expiry is a failed check that Claude Code fixes the next time the account
//! is used, never a refresh here. The token goes only into the request's
//! bearer header; no error, log or reading carries it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::account_usage_collector::{AccountUsageReader, UsageAccount};
use crate::usage::{ClaudeUsageReading, ClaudeUsageWindow, ClaudeUsageWindowKind};

const USAGE_ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";
/// The API accepts a Claude login's OAuth bearer under this beta.
const OAUTH_BETA: &str = "oauth-2025-04-20";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_CREDENTIAL_BYTES: u64 = 4 * 1024 * 1024;
const CREDENTIAL_FILE: &str = ".credentials.json";

pub(crate) struct ClaudeUsage;

impl AccountUsageReader for ClaudeUsage {
    const PROVIDER: &'static str = "claude";
    const CACHE_FILE_NAME: &'static str = "claude-usage-snapshots.json";
    const HOME_UNAVAILABLE: &'static str = "claude_usage_home_unavailable";
    const CREDENTIAL_UNAVAILABLE: &'static str = "claude_usage_credential_unavailable";
    type Reading = ClaudeUsageReading;
    type Context = reqwest::Client;

    /// Without CLAUDE_CONFIG_DIR, Claude Code keeps its state in `~/.claude`.
    fn default_directory(home: &Path) -> PathBuf {
        home.join(".claude")
    }

    async fn prepare(_home: &Path) -> Result<Self::Context, &'static str> {
        // reqwest is built with `rustls-no-provider`; a second install is a
        // harmless Err.
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("dure/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| "claude_usage_client_unavailable")
    }

    async fn read<'a>(
        client: &'a Self::Context,
        _home: &'a Path,
        account: &'a UsageAccount,
        directory: &'a Path,
    ) -> Result<Self::Reading, &'static str> {
        let scoped = account.credential_id.is_some();
        let directory = directory.to_path_buf();
        let credential =
            tauri::async_runtime::spawn_blocking(move || stored_login(&directory, scoped))
                .await
                .map_err(|_| "claude_usage_credential_unreadable")??;
        let token = access_token(&credential, now_ms())?;
        drop(credential);
        let response = request_usage(client, USAGE_ENDPOINT, &token).await?;
        parse_usage(&response)
    }
}

/// The login Claude Code stored for this config directory: on macOS its
/// Keychain item (scoped by the directory for an account profile), else the
/// directory's credential file, which Claude Code also falls back to.
fn stored_login(directory: &Path, scoped: bool) -> Result<Vec<u8>, &'static str> {
    #[cfg(target_os = "macos")]
    {
        let root = if scoped {
            Some(
                directory
                    .to_str()
                    .ok_or("claude_usage_credential_unavailable")?,
            )
        } else {
            None
        };
        if let Some(item) = crate::login_identity::read_claude_keychain_login(root, None)
            .map_err(|_| "claude_usage_credential_unreadable")?
        {
            return Ok(item);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = scoped;
    read_credential_file(&directory.join(CREDENTIAL_FILE))
}

fn read_credential_file(path: &Path) -> Result<Vec<u8>, &'static str> {
    use std::io::Read as _;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("claude_usage_not_signed_in");
        }
        Err(_) => return Err("claude_usage_credential_unreadable"),
    };
    if !metadata.is_file() || metadata.len() > MAX_CREDENTIAL_BYTES {
        return Err("claude_usage_credential_unreadable");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_CREDENTIAL_BYTES).read_to_end(&mut bytes))
        .map_err(|_| "claude_usage_credential_unreadable")?;
    Ok(bytes)
}

/// The stored login's OAuth access token while it is still valid.
fn access_token(credential: &[u8], now_ms: u64) -> Result<String, &'static str> {
    let stored: Value =
        serde_json::from_slice(credential).map_err(|_| "claude_usage_credential_unreadable")?;
    let oauth = stored
        .get("claudeAiOauth")
        .filter(|oauth| oauth.is_object())
        .ok_or("claude_usage_not_signed_in")?;
    let token = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or("claude_usage_not_signed_in")?;
    if oauth
        .get("expiresAt")
        .and_then(Value::as_u64)
        .is_some_and(|expires_at| expires_at <= now_ms)
    {
        return Err("claude_usage_login_expired");
    }
    Ok(token.to_owned())
}

async fn request_usage(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
) -> Result<Value, &'static str> {
    let mut response = client
        .get(endpoint)
        .bearer_auth(token)
        .header("anthropic-beta", OAUTH_BETA)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "claude_usage_unreachable")?;
    match response.status().as_u16() {
        200..=299 => {}
        401 => return Err("claude_usage_login_rejected"),
        // Claude Code reads a 403 here as the endpoint limiting requests too.
        403 | 429 => return Err("claude_usage_rate_limited"),
        _ => return Err("claude_usage_unavailable"),
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("claude_usage_response_too_large");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "claude_usage_unreachable")?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("claude_usage_response_too_large");
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "claude_usage_invalid_response")
}

/// Every limit window the response reports, typed. A top-level entry with a
/// `utilization` and a `resets_at` is a window; `limits` lists scoped ones,
/// where `weekly_scoped` with a model is that model's weekly window. Windows
/// Dure does not know are kept as `Other` under the response's name.
pub(crate) fn parse_usage(response: &Value) -> Result<ClaudeUsageReading, &'static str> {
    let entries = response
        .as_object()
        .ok_or("claude_usage_invalid_response")?;
    let mut windows = BTreeMap::new();
    for (name, entry) in entries {
        if name == "limits" || !valid_name(name) || entry.get("resets_at").is_none() {
            continue;
        }
        let (kind, model) = match name.as_str() {
            "five_hour" => (ClaudeUsageWindowKind::FiveHour, None),
            "seven_day" => (ClaudeUsageWindowKind::Weekly, None),
            "seven_day_opus" => (ClaudeUsageWindowKind::ModelWeekly, Some("Opus")),
            "seven_day_sonnet" => (ClaudeUsageWindowKind::ModelWeekly, Some("Sonnet")),
            _ => (ClaudeUsageWindowKind::Other, None),
        };
        if let Some(window) = window(name.clone(), kind, model, entry, "utilization") {
            windows.insert(window.id.clone(), window);
        }
    }
    for entry in entries
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(scope) = entry
            .get("kind")
            .and_then(Value::as_str)
            .filter(|kind| valid_name(kind))
        else {
            continue;
        };
        let model = entry
            .pointer("/scope/model/display_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|model| !model.is_empty() && model.len() <= 128);
        let (id, kind) = match (scope, model) {
            ("weekly_scoped", Some(model)) => (
                format!("seven_day_{}", name_part(model)),
                ClaudeUsageWindowKind::ModelWeekly,
            ),
            (scope, Some(model)) => (
                format!("{scope}_{}", name_part(model)),
                ClaudeUsageWindowKind::Other,
            ),
            (scope, None) => (scope.to_owned(), ClaudeUsageWindowKind::Other),
        };
        if let Some(window) = window(id, kind, model, entry, "percent") {
            windows.insert(window.id.clone(), window);
        }
    }
    let mut windows: Vec<_> = windows.into_values().collect();
    windows.sort_by(|left, right| (left.kind, &left.id).cmp(&(right.kind, &right.id)));
    if windows.is_empty() {
        return Err("claude_usage_no_windows");
    }
    Ok(ClaudeUsageReading { windows })
}

fn window(
    id: String,
    kind: ClaudeUsageWindowKind,
    model: Option<&str>,
    entry: &Value,
    used_field: &str,
) -> Option<ClaudeUsageWindow> {
    let used_percent = entry
        .get(used_field)
        .and_then(Value::as_f64)
        .filter(|used| used.is_finite())?
        .clamp(0.0, 100.0);
    Some(ClaudeUsageWindow {
        id,
        kind,
        model: model.map(str::to_owned),
        used_percent,
        resets_at: reset_seconds(entry.get("resets_at")),
    })
}

/// `resets_at` is an RFC 3339 time, or null when the window has not started.
fn reset_seconds(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::String(at) => chrono::DateTime::parse_from_rfc3339(at)
            .ok()
            .and_then(|at| u64::try_from(at.timestamp()).ok()),
        Value::Number(seconds) => seconds.as_u64(),
        _ => None,
    }
}

fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// A model's display name as a window name part: `Fable 5.1` → `fable_5_1`.
fn name_part(model: &str) -> String {
    let mut part = String::new();
    for character in model.chars() {
        if character.is_ascii_alphanumeric() {
            part.push(character.to_ascii_lowercase());
        } else if !part.ends_with('_') && !part.is_empty() {
            part.push('_');
        }
    }
    part.trim_end_matches('_').to_owned()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn kinds(reading: &ClaudeUsageReading) -> Vec<(&str, ClaudeUsageWindowKind, Option<&str>)> {
        reading
            .windows
            .iter()
            .map(|window| (window.id.as_str(), window.kind, window.model.as_deref()))
            .collect()
    }

    #[test]
    fn parses_every_window_with_its_reset_and_keeps_unknown_ones_by_name() {
        let reading = parse_usage(&json!({
            "five_hour": {"utilization": 12.5, "resets_at": "2026-11-26T12:00:00.123456+00:00"},
            "seven_day": {"utilization": 40, "resets_at": "2026-11-30T00:00:00Z"},
            "seven_day_oauth_apps": null,
            "seven_day_opus": {"utilization": 0, "resets_at": null},
            "seven_day_sonnet": {"utilization": 130, "resets_at": "2026-11-30T00:00:00Z"},
            "seven_day_lantern": {"utilization": 7, "resets_at": "2026-11-29T00:00:00Z"},
            "extra_usage": {"is_enabled": true, "utilization": 50},
            "limits": [
                {"kind": "weekly_scoped", "scope": {"model": {"display_name": "Fable 5.1"}},
                    "percent": 100, "resets_at": "2026-11-28T06:00:00Z"},
                {"kind": "daily_scoped", "scope": {"model": {"display_name": "Fable"}},
                    "percent": 3, "resets_at": null},
                {"kind": "weekly_scoped", "percent": 9, "resets_at": null},
                {"kind": "Not A Name", "percent": 9, "resets_at": null},
                {"kind": "weekly_scoped", "scope": {"model": {"display_name": "Haiku"}}},
            ],
        }))
        .unwrap();
        assert_eq!(
            kinds(&reading),
            [
                ("five_hour", ClaudeUsageWindowKind::FiveHour, None),
                ("seven_day", ClaudeUsageWindowKind::Weekly, None),
                (
                    "seven_day_fable_5_1",
                    ClaudeUsageWindowKind::ModelWeekly,
                    Some("Fable 5.1")
                ),
                (
                    "seven_day_opus",
                    ClaudeUsageWindowKind::ModelWeekly,
                    Some("Opus")
                ),
                (
                    "seven_day_sonnet",
                    ClaudeUsageWindowKind::ModelWeekly,
                    Some("Sonnet")
                ),
                (
                    "daily_scoped_fable",
                    ClaudeUsageWindowKind::Other,
                    Some("Fable")
                ),
                ("seven_day_lantern", ClaudeUsageWindowKind::Other, None),
                ("weekly_scoped", ClaudeUsageWindowKind::Other, None),
            ]
        );
        let by_id = |id: &str| {
            reading
                .windows
                .iter()
                .find(|window| window.id == id)
                .unwrap()
        };
        assert_eq!(by_id("five_hour").used_percent, 12.5);
        assert_eq!(by_id("five_hour").resets_at, Some(1_795_694_400));
        assert_eq!(by_id("seven_day_fable_5_1").used_percent, 100.0);
        assert_eq!(by_id("seven_day_fable_5_1").resets_at, Some(1_795_845_600));
        assert_eq!(by_id("seven_day_opus").resets_at, None);
        assert_eq!(by_id("seven_day_sonnet").used_percent, 100.0);

        // Unknown kinds round-trip as `other`, as an older reader sees them.
        let stored = serde_json::to_value(&reading).unwrap();
        assert_eq!(stored["windows"][2]["kind"], "modelWeekly");
        assert_eq!(stored["windows"][2]["model"], "Fable 5.1");
        let mut future = stored.clone();
        future["windows"][0]["kind"] = json!("someNewKind");
        let decoded: ClaudeUsageReading = serde_json::from_value(future).unwrap();
        assert_eq!(decoded.windows[0].kind, ClaudeUsageWindowKind::Other);
    }

    #[test]
    fn a_response_without_windows_is_a_failed_check() {
        assert_eq!(
            parse_usage(&json!({"five_hour": null, "limits": []})),
            Err("claude_usage_no_windows")
        );
        assert_eq!(
            parse_usage(&json!([])),
            Err("claude_usage_invalid_response")
        );
    }

    #[test]
    fn uses_only_an_unexpired_oauth_login() {
        let login = |oauth: Value| serde_json::to_vec(&json!({"claudeAiOauth": oauth})).unwrap();
        assert_eq!(
            access_token(
                &login(json!({"accessToken": "fixture-token", "expiresAt": 2_000})),
                1_000
            ),
            Ok("fixture-token".into())
        );
        assert_eq!(
            access_token(&login(json!({"accessToken": "fixture-token"})), 1_000),
            Ok("fixture-token".into())
        );
        assert_eq!(
            access_token(
                &login(json!({"accessToken": "fixture-token", "expiresAt": 1_000})),
                1_000
            ),
            Err("claude_usage_login_expired")
        );
        assert_eq!(
            access_token(&login(json!({"accessToken": ""})), 1_000),
            Err("claude_usage_not_signed_in")
        );
        assert_eq!(
            access_token(br#"{"mcpOAuth":{}}"#, 1_000),
            Err("claude_usage_not_signed_in")
        );
        assert_eq!(
            access_token(b"not json", 1_000),
            Err("claude_usage_credential_unreadable")
        );
    }

    #[test]
    fn reads_the_profile_credential_file_and_reports_a_missing_one_as_signed_out() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            read_credential_file(&root.path().join(CREDENTIAL_FILE)),
            Err("claude_usage_not_signed_in")
        );
        std::fs::write(root.path().join(CREDENTIAL_FILE), b"{}").unwrap();
        assert_eq!(
            read_credential_file(&root.path().join(CREDENTIAL_FILE)),
            Ok(b"{}".to_vec())
        );
    }

    /// One local HTTP exchange: returns the request head it received.
    async fn serve_once(
        listener: tokio::net::TcpListener,
        status: &'static str,
        body: &'static str,
    ) -> String {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        while !request.windows(4).any(|end| end == b"\r\n\r\n") {
            let read = stream.read(&mut buffer).await.unwrap();
            assert!(read > 0);
            request.extend_from_slice(&buffer[..read]);
        }
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8(request).unwrap()
    }

    #[tokio::test]
    async fn requests_usage_with_the_login_bearer_and_types_refusals() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder().build().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/api/oauth/usage", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_once(
            listener,
            "200 OK",
            r#"{"seven_day":{"utilization":5,"resets_at":null}}"#,
        ));
        let response = request_usage(&client, &endpoint, "fixture-token")
            .await
            .unwrap();
        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /api/oauth/usage http/1.1"));
        assert!(request.contains("authorization: bearer fixture-token\r\n"));
        assert!(request.contains("anthropic-beta: oauth-2025-04-20\r\n"));
        assert_eq!(response["seven_day"]["utilization"], 5);

        for (status, code) in [
            ("401 Unauthorized", "claude_usage_login_rejected"),
            ("429 Too Many Requests", "claude_usage_rate_limited"),
            ("500 Internal Server Error", "claude_usage_unavailable"),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}/api/oauth/usage", listener.local_addr().unwrap());
            let server = tokio::spawn(serve_once(listener, status, "{}"));
            assert_eq!(
                request_usage(&client, &endpoint, "fixture-token").await,
                Err(code)
            );
            server.await.unwrap();
        }
    }
}
