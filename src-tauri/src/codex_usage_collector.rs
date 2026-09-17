//! 등록된 Codex credential별 rate-limit snapshot 수집기.
//!
//! 세션 JSONL은 "그 계정을 사용한 뒤"에만 갱신된다. 이 수집기는 공식 Codex
//! App Server의 `account/rateLimits/read`를 각 CODEX_HOME에서 호출해, pane이나
//! turn을 만들지 않고 비활성 계정도 갱신한다. 성공 snapshot은 앱 홈에
//! owner-only로 보존하며 이후 probe 실패가 마지막 성공값을 지우지 않는다.

use hmux_client::TerminalEnvironment;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;

use crate::usage::{CodexRateLimitUsage as CodexPolledRateLimit, CodexUsageSnapshot};

const CACHE_SCHEMA_VERSION: u32 = 1;
const CACHE_FILE_NAME: &str = "codex-usage-snapshots.json";
const POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);
const MAX_POLL_JITTER: Duration = Duration::from_secs(60);
const INACTIVE_PROBE_STAGGER: Duration = Duration::from_secs(2);
const BOOT_TIMEOUT: Duration = Duration::from_secs(40);
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE_LINE_BYTES: u64 = 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PROFILES: usize = 64;
const DEFAULT_CREDENTIAL_KEY: &str = "default";
const AMBIENT_PROVIDER_AUTH_ENVIRONMENT: [&str; 7] = [
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
    "CODEX_HOME",
    "CODEX_SQLITE_HOME",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
];
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn is_ambient_provider_auth_environment(key: &str) -> bool {
    AMBIENT_PROVIDER_AUTH_ENVIRONMENT.contains(&key)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageProfileInput {
    pub credential_id: Option<String>,
    pub directory: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ValidatedProfile {
    credential_id: Option<String>,
    codex_home: Option<PathBuf>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotCache {
    schema_version: u32,
    snapshots: Vec<CodexUsageSnapshot>,
}

#[derive(Default)]
struct CollectorInner {
    loaded: bool,
    profiles: BTreeMap<String, ValidatedProfile>,
    snapshots: BTreeMap<String, CodexUsageSnapshot>,
}

struct CollectorShared {
    inner: Mutex<CollectorInner>,
    refresh: AsyncMutex<bool>,
    wake: tokio::sync::Notify,
    started: AtomicBool,
}

impl Default for CollectorShared {
    fn default() -> Self {
        Self {
            inner: Mutex::new(CollectorInner::default()),
            refresh: AsyncMutex::new(false),
            wake: tokio::sync::Notify::new(),
            started: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Default)]
pub struct CodexUsageCollector {
    shared: Arc<CollectorShared>,
}

impl CodexUsageCollector {
    fn cache_path() -> Result<PathBuf, String> {
        Ok(crate::app_home::app_root_resolution()?
            .0
            .join(CACHE_FILE_NAME))
    }

    fn load_if_needed(&self, inner: &mut CollectorInner) {
        if inner.loaded {
            return;
        }
        inner.loaded = true;
        let Ok(path) = Self::cache_path() else { return };
        if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > MAX_CACHE_BYTES) {
            return;
        }
        let Ok(bytes) = std::fs::read(path) else {
            return;
        };
        let Ok(cache) = serde_json::from_slice::<SnapshotCache>(&bytes) else {
            return;
        };
        if cache.schema_version != CACHE_SCHEMA_VERSION {
            return;
        }
        for snapshot in cache.snapshots {
            inner
                .snapshots
                .insert(credential_key(snapshot.credential_id.as_deref()), snapshot);
        }
    }

    fn sync_profiles(&self, profiles: Vec<CodexUsageProfileInput>) -> Result<(), String> {
        if profiles.len() > MAX_PROFILES {
            return Err("codex_usage_profile_limit_exceeded".to_string());
        }
        let home = std::env::var("HOME").map_err(|_| "codex_usage_home_unavailable".to_string())?;
        let mut validated = BTreeMap::new();
        for profile in profiles {
            let key = credential_key(profile.credential_id.as_deref());
            if validated.contains_key(&key) {
                return Err("codex_usage_duplicate_credential".to_string());
            }
            let codex_home = match (&profile.credential_id, &profile.directory) {
                (None, None) => Some(Path::new(&home).join(".codex")),
                (Some(credential_id), Some(directory)) => {
                    crate::accounts::resolve_account_profile_directory(
                        "codex",
                        &home,
                        credential_id,
                        directory,
                    )
                    .ok()
                }
                _ => return Err("codex_usage_invalid_credential_reference".to_string()),
            };
            validated.insert(
                key,
                ValidatedProfile {
                    credential_id: profile.credential_id,
                    codex_home,
                },
            );
        }

        let mut inner = self.shared.inner.lock().unwrap();
        self.load_if_needed(&mut inner);
        let changed = inner.profiles != validated;
        inner.profiles = validated;
        let current: BTreeSet<_> = inner.profiles.keys().cloned().collect();
        let snapshot_count = inner.snapshots.len();
        inner.snapshots.retain(|key, _| current.contains(key));
        let persisted = if inner.snapshots.len() == snapshot_count {
            Ok(())
        } else {
            persist_cache(&inner.snapshots)
        };
        drop(inner);
        let started = self.start();
        if changed && !started {
            self.shared.wake.notify_one();
        }
        persisted
    }

    fn start(&self) -> bool {
        if self
            .shared
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        let collector = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut failure_streak = 0_u32;
            loop {
                if collector.refresh_all().await {
                    failure_streak = 0;
                } else {
                    failure_streak = failure_streak.saturating_add(1);
                }
                tokio::select! {
                    _ = tokio::time::sleep(poll_delay(now_secs(), failure_streak)) => {}
                    _ = collector.shared.wake.notified() => {}
                }
            }
        });
        true
    }

    pub fn snapshots(&self) -> Vec<CodexUsageSnapshot> {
        let mut inner = self.shared.inner.lock().unwrap();
        self.load_if_needed(&mut inner);
        inner.snapshots.values().cloned().collect()
    }

    pub async fn refresh_all(&self) -> bool {
        let mut result = match self.shared.refresh.try_lock() {
            Ok(guard) => guard,
            // Manual and scheduled requests share the current collection result.
            Err(_) => return *self.shared.refresh.lock().await,
        };
        *result = self.collect_profiles().await;
        *result
    }

    async fn collect_profiles(&self) -> bool {
        let profiles: Vec<_> = self
            .shared
            .inner
            .lock()
            .unwrap()
            .profiles
            .values()
            .cloned()
            .collect();
        if profiles.is_empty() {
            return true;
        }
        let home = match std::env::var("HOME") {
            Ok(home) => PathBuf::from(home),
            Err(_) => {
                self.record_all_failures(&profiles, "codex_usage_home_unavailable");
                return false;
            }
        };
        let sqlite_home =
            match crate::accounts::resolve_codex_canonical_state_directory(&home.to_string_lossy())
            {
                Ok(sqlite_home) => sqlite_home,
                Err(_) => {
                    self.record_all_failures(&profiles, "codex_usage_canonical_state_unavailable");
                    return false;
                }
            };
        let resolved = match resolve_codex_environment(home.clone()).await {
            Ok(resolved) => resolved,
            Err(code) => {
                self.record_all_failures(&profiles, code);
                return false;
            }
        };

        let mut any_success = false;
        for (index, profile) in profiles.iter().enumerate() {
            if index > 0 {
                tokio::time::sleep(INACTIVE_PROBE_STAGGER).await;
            }
            let attempted_at = now_secs();
            let result = if profile.codex_home.is_some() {
                probe_profile(&resolved, &home, &sqlite_home, profile).await
            } else {
                Err("codex_usage_credential_unavailable")
            };
            any_success |= result.is_ok();
            self.record_result(profile, attempted_at, result);
        }
        any_success
    }

    fn record_all_failures(&self, profiles: &[ValidatedProfile], code: &'static str) {
        let attempted_at = now_secs();
        for profile in profiles {
            self.record_result(profile, attempted_at, Err(code));
        }
    }

    fn record_result(
        &self,
        profile: &ValidatedProfile,
        attempted_at: u64,
        result: Result<PolledUsage, &'static str>,
    ) {
        let key = credential_key(profile.credential_id.as_deref());
        let mut inner = self.shared.inner.lock().unwrap();
        let Some(current) = inner.profiles.get(&key) else {
            return;
        };
        if current.codex_home != profile.codex_home {
            return;
        }
        let snapshot = inner
            .snapshots
            .entry(key)
            .or_insert_with(|| CodexUsageSnapshot {
                credential_id: profile.credential_id.clone(),
                ..CodexUsageSnapshot::default()
            });
        apply_probe_result(snapshot, attempted_at, result);
        let _ = persist_cache(&inner.snapshots);
    }
}

struct PolledUsage {
    rate_limits: Vec<CodexPolledRateLimit>,
    rate_limit_resets_available: Option<u64>,
}

fn apply_probe_result(
    snapshot: &mut CodexUsageSnapshot,
    attempted_at: u64,
    result: Result<PolledUsage, &'static str>,
) {
    snapshot.attempted_at = Some(attempted_at);
    match result {
        Ok(usage) => {
            snapshot.captured_at = Some(attempted_at);
            snapshot.error = None;
            snapshot.rate_limits = usage.rate_limits;
            snapshot.rate_limit_resets_available = usage.rate_limit_resets_available;
        }
        Err(code) => {
            // 마지막 성공값은 절대 지우지 않는다. 오류는 이번 시도 상태만
            // 설명하며, UI가 capturedAt과 함께 stale로 표시한다.
            snapshot.error = Some(code.to_string());
        }
    }
}

#[tauri::command(async)]
pub fn codex_usage_profiles_sync(
    state: tauri::State<'_, CodexUsageCollector>,
    profiles: Vec<CodexUsageProfileInput>,
) -> Result<(), String> {
    state.sync_profiles(profiles)
}

async fn resolve_codex_environment(
    home: PathBuf,
) -> Result<crate::provider_preflight::ResolvedLoginCommandEnvironment, &'static str> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::provider_preflight::resolve_login_command_environment(
            "codex",
            &home,
            TerminalEnvironment::default(),
        )
    })
    .await
    .map_err(|_| "codex_usage_environment_failed")?
    .map_err(|_| "codex_usage_codex_unavailable")
}

async fn probe_profile(
    resolved: &crate::provider_preflight::ResolvedLoginCommandEnvironment,
    home: &Path,
    sqlite_home: &Path,
    profile: &ValidatedProfile,
) -> Result<PolledUsage, &'static str> {
    let codex_home = profile
        .codex_home
        .as_ref()
        .ok_or("codex_usage_credential_unavailable")?;
    if !std::fs::metadata(codex_home.join("auth.json")).is_ok_and(|metadata| metadata.is_file()) {
        return Err("codex_usage_not_signed_in");
    }
    let mut command = Command::new(&resolved.executable);
    command
        // App Server is the complete probe interface. TUI execution policy
        // flags are unrelated to this protocol and have changed across Codex
        // releases, so coupling the collector to them makes upgrades fail
        // before initialize can run.
        .arg("app-server")
        .current_dir(home)
        .env_clear()
        .envs(
            resolved
                .environment
                .iter()
                .filter(|(key, _)| !is_ambient_provider_auth_environment(key)),
        )
        // The selected profile's auth.json is the credential authority. A
        // login-shell token must not silently turn every profile probe into
        // the same ambient account.
        .env("HOME", home)
        .env("CODEX_HOME", codex_home)
        .env("CODEX_SQLITE_HOME", sqlite_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "codex_usage_probe_spawn_failed")?;
    let Some(mut stdin) = child.stdin.take() else {
        stop_probe(&mut child).await;
        return Err("codex_usage_probe_stdio_unavailable");
    };
    let Some(stdout) = child.stdout.take() else {
        drop(stdin);
        stop_probe(&mut child).await;
        return Err("codex_usage_probe_stdio_unavailable");
    };
    let mut reader = BufReader::new(stdout);

    let result = run_protocol(&mut stdin, &mut reader).await;
    drop(stdin);
    stop_probe(&mut child).await;
    result
}

async fn run_protocol(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
) -> Result<PolledUsage, &'static str> {
    write_message(
        stdin,
        serde_json::json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {
                    "name": "dure",
                    "title": "Dure",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }
        }),
    )
    .await?;
    tokio::time::timeout(BOOT_TIMEOUT, read_response(stdout, 1))
        .await
        .map_err(|_| "codex_usage_probe_boot_timeout")??;

    write_message(
        stdin,
        serde_json::json!({ "method": "initialized", "params": {} }),
    )
    .await?;
    write_message(
        stdin,
        serde_json::json!({ "method": "account/rateLimits/read", "id": 2 }),
    )
    .await?;
    let response = tokio::time::timeout(READ_TIMEOUT, read_response(stdout, 2))
        .await
        .map_err(|_| "codex_usage_probe_read_timeout")??;
    parse_rate_limits(&response)
}

async fn write_message(
    stdin: &mut ChildStdin,
    message: serde_json::Value,
) -> Result<(), &'static str> {
    let mut encoded = serde_json::to_vec(&message).map_err(|_| "codex_usage_invalid_request")?;
    encoded.push(b'\n');
    stdin
        .write_all(&encoded)
        .await
        .map_err(|_| "codex_usage_probe_write_failed")?;
    stdin
        .flush()
        .await
        .map_err(|_| "codex_usage_probe_write_failed")
}

async fn read_response(
    reader: &mut BufReader<ChildStdout>,
    response_id: u64,
) -> Result<serde_json::Value, &'static str> {
    loop {
        let mut line = Vec::new();
        let count = reader
            .take(MAX_RESPONSE_LINE_BYTES + 1)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| "codex_usage_probe_read_failed")?;
        if count == 0 {
            return Err("codex_usage_probe_closed");
        }
        if count as u64 > MAX_RESPONSE_LINE_BYTES {
            return Err("codex_usage_probe_response_too_large");
        }
        let message: serde_json::Value =
            serde_json::from_slice(&line).map_err(|_| "codex_usage_probe_invalid_response")?;
        if message.get("id").and_then(serde_json::Value::as_u64) != Some(response_id) {
            continue;
        }
        if message.get("error").is_some_and(|error| !error.is_null()) {
            return Err("codex_usage_unavailable");
        }
        return Ok(message);
    }
}

fn parse_rate_limits(response: &serde_json::Value) -> Result<PolledUsage, &'static str> {
    let result = response
        .get("result")
        .and_then(serde_json::Value::as_object)
        .ok_or("codex_usage_probe_invalid_response")?;
    let mut limits = Vec::new();
    let rate_limit_resets_available = result
        .get("rateLimitResetCredits")
        .and_then(|credits| credits.get("availableCount"))
        .and_then(serde_json::Value::as_u64);
    if let Some(by_id) = result
        .get("rateLimitsByLimitId")
        .and_then(serde_json::Value::as_object)
    {
        for (id, value) in by_id {
            if let Some(limit) = parse_rate_limit(value, id) {
                limits.push(limit);
            }
        }
    }
    if let Some(value) = result.get("rateLimits").filter(|_| limits.is_empty()) {
        if let Some(limit) = parse_rate_limit(value, "codex") {
            limits.push(limit);
        }
    }
    limits.sort_by(|left, right| left.limit_id.cmp(&right.limit_id));
    if limits.is_empty() && rate_limit_resets_available.is_none() {
        return Err("codex_usage_no_rate_limits");
    }
    Ok(PolledUsage {
        rate_limits: limits,
        rate_limit_resets_available,
    })
}

fn parse_rate_limit(value: &serde_json::Value, fallback_id: &str) -> Option<CodexPolledRateLimit> {
    let mut limit = CodexPolledRateLimit {
        limit_id: value
            .get("limitId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .unwrap_or(fallback_id)
            .to_string(),
        limit_name: value
            .get("limitName")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        credits: value
            .get("credits")
            .and_then(|credits| serde_json::from_value(credits.clone()).ok()),
        ..CodexPolledRateLimit::default()
    };
    for key in ["primary", "secondary"] {
        let Some(window) = value.get(key).filter(|window| window.is_object()) else {
            continue;
        };
        let Some(used_percent) = window
            .get("usedPercent")
            .and_then(serde_json::Value::as_f64)
        else {
            continue;
        };
        let used_percent = used_percent.clamp(0.0, 100.0);
        let duration = window
            .get("windowDurationMins")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let resets_at = window.get("resetsAt").and_then(serde_json::Value::as_u64);
        if duration > 1440 || (duration == 0 && key == "secondary") {
            limit.used_percent_weekly = Some(used_percent);
            limit.weekly_resets_at = resets_at;
        } else {
            limit.used_percent = Some(used_percent);
            limit.resets_at = resets_at;
        }
    }
    (limit.used_percent.is_some() || limit.used_percent_weekly.is_some() || limit.credits.is_some())
        .then_some(limit)
}

async fn stop_probe(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: pid는 이 collector가 방금 spawn해 아직 소유 중인 exact child다.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    if tokio::time::timeout(DRAIN_TIMEOUT, child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

fn credential_key(credential_id: Option<&str>) -> String {
    credential_id
        .map(|credential_id| format!("credential:{credential_id}"))
        .unwrap_or_else(|| DEFAULT_CREDENTIAL_KEY.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn poll_delay(now: u64, failure_streak: u32) -> Duration {
    let multiplier = 1_u32 << failure_streak.min(2);
    POLL_INTERVAL * multiplier + Duration::from_secs(now % (MAX_POLL_JITTER.as_secs() + 1))
}

#[cfg(unix)]
fn owner_only(options: &mut std::fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
}

#[cfg(not(unix))]
fn owner_only(_options: &mut std::fs::OpenOptions) {}

#[cfg(not(windows))]
fn replace_cache_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    std::fs::rename(temporary, destination)
        .map_err(|_| "codex_usage_cache_publish_failed".to_string())
}

#[cfg(windows)]
fn replace_cache_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    if !destination.exists() {
        return std::fs::rename(temporary, destination)
            .map_err(|_| "codex_usage_cache_publish_failed".to_string());
    }
    let backup = destination.with_extension("backup");
    let _ = std::fs::remove_file(&backup);
    std::fs::rename(destination, &backup)
        .map_err(|_| "codex_usage_cache_publish_failed".to_string())?;
    match std::fs::rename(temporary, destination) {
        Ok(()) => {
            let _ = std::fs::remove_file(backup);
            Ok(())
        }
        Err(_) => {
            let _ = std::fs::rename(backup, destination);
            Err("codex_usage_cache_publish_failed".to_string())
        }
    }
}

fn persist_cache(snapshots: &BTreeMap<String, CodexUsageSnapshot>) -> Result<(), String> {
    let path = CodexUsageCollector::cache_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "codex_usage_cache_path_invalid".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "codex_usage_cache_unavailable".to_string())?;
    let cache = SnapshotCache {
        schema_version: CACHE_SCHEMA_VERSION,
        snapshots: snapshots.values().cloned().collect(),
    };
    let bytes =
        serde_json::to_vec(&cache).map_err(|_| "codex_usage_cache_encode_failed".to_string())?;
    let temporary = path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        owner_only(&mut options);
        let mut file = options
            .open(&temporary)
            .map_err(|_| "codex_usage_cache_unavailable".to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "codex_usage_cache_write_failed".to_string())?;
        replace_cache_file(&temporary, &path)?;
        #[cfg(unix)]
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "codex_usage_cache_publish_failed".to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn concurrent_refresh_joins_the_running_collection_result() {
        let collector = CodexUsageCollector::default();
        let mut running = collector.shared.refresh.lock().await;
        *running = false;
        let joined = collector.refresh_all();
        tokio::pin!(joined);
        tokio::select! {
            biased;
            _ = &mut joined => panic!("refresh must wait for the running collection"),
            _ = tokio::task::yield_now() => {}
        }
        drop(running);
        // An extra pass over the empty catalog would return true, hiding failure.
        assert!(!joined.await);
        assert!(collector.refresh_all().await);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn profile_probe_uses_only_the_app_server_interface() {
        use std::collections::BTreeMap;
        use std::os::unix::fs::OpenOptionsExt;

        let directory = tempfile::tempdir().unwrap();
        let codex_home = directory.path().join("codex-home");
        std::fs::create_dir(&codex_home).unwrap();
        std::fs::write(codex_home.join("auth.json"), b"{}\n").unwrap();
        let executable = directory.path().join("codex");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true).mode(0o700);
        let mut script = options.open(&executable).unwrap();
        script
            .write_all(
                br#"#!/bin/sh
[ "$#" -eq 1 ] && [ "$1" = "app-server" ] || exit 64
IFS= read -r initialize || exit 65
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized || exit 66
IFS= read -r request || exit 67
printf '%s\n' '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":21,"resetsAt":10},"secondary":{"usedPercent":34,"resetsAt":20}},"rateLimitResetCredits":{"availableCount":3,"credits":null}}}'
"#,
            )
            .unwrap();
        script.sync_all().unwrap();

        let resolved = crate::provider_preflight::ResolvedLoginCommandEnvironment {
            executable,
            environment: BTreeMap::new(),
        };
        let profile = ValidatedProfile {
            credential_id: Some("acc-a".into()),
            codex_home: Some(codex_home),
        };
        let limits = probe_profile(
            &resolved,
            directory.path(),
            directory.path(),
            &profile,
        )
        .await
        .unwrap();
        assert_eq!(limits.rate_limits[0].used_percent, Some(21.0));
        assert_eq!(limits.rate_limits[0].used_percent_weekly, Some(34.0));
        assert_eq!(limits.rate_limit_resets_available, Some(3));
    }

    #[test]
    fn preserves_reset_credit_count_separately_from_zero_workspace_balance() {
        let response = serde_json::json!({ "result": {
            "rateLimits": {
                "credits": { "hasCredits": false, "unlimited": false, "balance": "0" }
            },
            "rateLimitResetCredits": { "availableCount": 3, "credits": [] }
        }});
        let mut snapshot = CodexUsageSnapshot::default();
        apply_probe_result(&mut snapshot, 100, parse_rate_limits(&response));
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["rateLimitResetsAvailable"], 3);
        assert_eq!(json["rateLimits"][0]["credits"]["balance"], "0");
    }

    #[test]
    fn reset_credit_observations_roundtrip_retain_on_failure_and_clear_on_success() {
        let mut snapshot = CodexUsageSnapshot::default();
        for count in [3, 0] {
            let response = serde_json::json!({ "result": {
                "rateLimitResetCredits": { "availableCount": count, "credits": null }
            }});
            apply_probe_result(&mut snapshot, 100, parse_rate_limits(&response));
            let encoded = serde_json::to_string(&snapshot).unwrap();
            let decoded: CodexUsageSnapshot = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded.rate_limit_resets_available, Some(count));
            assert_eq!(decoded.captured_at, Some(100));
            apply_probe_result(&mut snapshot, 200, Err("codex_usage_unavailable"));
            assert_eq!(snapshot.rate_limit_resets_available, Some(count));
            assert_eq!(snapshot.captured_at, Some(100));
            assert!(snapshot.error.is_some());
        }
        for reset_credits in [
            serde_json::Value::Null,
            serde_json::json!({ "credits": [{ "status": "available" }] }),
            serde_json::json!({ "availableCount": -1 }),
            serde_json::json!({ "availableCount": 1.5 }),
            serde_json::json!({ "availableCount": "3" }),
        ] {
            let response = serde_json::json!({ "result": {
                "rateLimits": { "primary": { "usedPercent": 20 } },
                "rateLimitResetCredits": reset_credits
            }});
            apply_probe_result(&mut snapshot, 300, parse_rate_limits(&response));
            assert_eq!(snapshot.rate_limit_resets_available, None);
            assert_eq!(snapshot.captured_at, Some(300));
            assert!(snapshot.error.is_none());
            assert_eq!(snapshot.rate_limits[0].used_percent, Some(20.0));
        }
    }

    #[test]
    fn preserves_credits_in_the_serialized_account_snapshot() {
        let response = serde_json::json!({
            "result": { "rateLimits": {
                "primary": { "usedPercent": 21 },
                "credits": { "hasCredits": true, "unlimited": false, "balance": "1250.5" }
            }}
        });
        let mut snapshot = CodexUsageSnapshot::default();
        apply_probe_result(&mut snapshot, 100, parse_rate_limits(&response));
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["rateLimits"][0]["credits"]["balance"], "1250.5");
        apply_probe_result(&mut snapshot, 200, Err("codex_usage_unavailable"));
        assert_eq!(
            serde_json::to_value(&snapshot).unwrap()["rateLimits"],
            json["rateLimits"]
        );
        assert_eq!(snapshot.captured_at, Some(100));
    }

    #[test]
    fn credit_only_snapshots_survive_cache_roundtrip_and_clear_on_a_new_observation() {
        let response = serde_json::json!({ "result": { "rateLimits": {
            "credits": { "hasCredits": false, "unlimited": false, "balance": "0" }
        }}});
        let mut snapshot = CodexUsageSnapshot::default();
        apply_probe_result(&mut snapshot, 100, parse_rate_limits(&response));
        assert_eq!(snapshot.captured_at, Some(100));
        let encoded = serde_json::to_string(&snapshot).unwrap();
        let decoded: CodexUsageSnapshot = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, snapshot);
        assert_eq!(
            serde_json::to_value(&decoded).unwrap()["rateLimits"][0]["credits"]["balance"],
            "0"
        );

        let no_credits = serde_json::json!({ "result": { "rateLimits": {
            "primary": { "usedPercent": 0 }
        }}});
        apply_probe_result(&mut snapshot, 200, parse_rate_limits(&no_credits));
        assert!(serde_json::to_value(&snapshot).unwrap()["rateLimits"][0]["credits"].is_null());
        let old_cache: CodexUsageSnapshot = serde_json::from_value(serde_json::json!({
            "credentialId": null, "capturedAt": 1, "attemptedAt": 1, "error": null,
            "rateLimits": [{ "limitId": "codex", "usedPercent": 0 }]
        }))
        .unwrap();
        assert_eq!(old_cache.rate_limits[0].used_percent, Some(0.0));
        assert_eq!(old_cache.rate_limit_resets_available, None);
    }

    #[test]
    fn credits_stay_with_their_bucket_and_malformed_credits_do_not_erase_limits() {
        let response = serde_json::json!({ "result": { "rateLimitsByLimitId": {
            "codex": { "primary": { "usedPercent": 10 }, "credits": { "balance": "5" } },
            "model-only": { "credits": { "hasCredits": true, "unlimited": true, "balance": null } }
        }}});
        let limits = parse_rate_limits(&response).unwrap().rate_limits;
        let json = serde_json::to_value(limits).unwrap();
        assert_eq!(json[0]["limitId"], "codex");
        assert_eq!(json[0]["usedPercent"], 10.0);
        assert!(json[0]["credits"].is_null());
        assert_eq!(json[1]["limitId"], "model-only");
        assert_eq!(json[1]["credits"]["unlimited"], true);
    }

    #[test]
    fn parses_multi_bucket_windows_by_duration() {
        let response = serde_json::json!({
            "result": {
                "rateLimitsByLimitId": {
                    "codex": {
                        "limitId": "codex",
                        "primary": { "usedPercent": 25.0, "windowDurationMins": 300, "resetsAt": 10 },
                        "secondary": { "usedPercent": 40.0, "windowDurationMins": 10080, "resetsAt": 20 }
                    },
                    "codex_other": {
                        "limitId": "codex_other",
                        "limitName": "Other",
                        "primary": { "usedPercent": 12.0, "windowDurationMins": 60, "resetsAt": 30 }
                    }
                }
            }
        });
        let limits = parse_rate_limits(&response).unwrap().rate_limits;
        assert_eq!(limits.len(), 2);
        assert_eq!(limits[0].used_percent, Some(25.0));
        assert_eq!(limits[0].used_percent_weekly, Some(40.0));
        assert_eq!(limits[1].limit_name.as_deref(), Some("Other"));
    }

    #[test]
    fn parses_official_single_bucket_wrapper_and_secondary_position_fallback() {
        let response = serde_json::json!({
            "result": {
                "rateLimits": {
                    "primary": { "usedPercent": 15.0, "resetsAt": 10 },
                    "secondary": { "usedPercent": 35.0, "resetsAt": 20 }
                }
            }
        });
        let limits = parse_rate_limits(&response).unwrap().rate_limits;
        assert_eq!(limits.len(), 1);
        assert_eq!(limits[0].used_percent, Some(15.0));
        assert_eq!(limits[0].used_percent_weekly, Some(35.0));
    }

    #[test]
    fn failure_keeps_the_last_success_snapshot_fields() {
        let mut snapshot = CodexUsageSnapshot {
            credential_id: Some("acc-a".into()),
            captured_at: Some(100),
            attempted_at: Some(100),
            error: None,
            rate_limit_resets_available: None,
            rate_limits: vec![CodexPolledRateLimit {
                limit_id: "codex".into(),
                used_percent: Some(30.0),
                ..CodexPolledRateLimit::default()
            }],
        };
        apply_probe_result(&mut snapshot, 200, Err("codex_usage_unavailable"));
        assert_eq!(snapshot.captured_at, Some(100));
        assert_eq!(snapshot.attempted_at, Some(200));
        assert_eq!(snapshot.rate_limits[0].used_percent, Some(30.0));
    }

    #[test]
    fn poll_jitter_is_bounded_without_shortening_the_cadence() {
        assert!(poll_delay(0, 0) >= POLL_INTERVAL);
        assert!(poll_delay(59, 0) <= POLL_INTERVAL + MAX_POLL_JITTER);
        assert!(poll_delay(0, 3) >= POLL_INTERVAL * 4);
    }

    #[test]
    fn explicit_default_named_credential_does_not_alias_the_implicit_default() {
        assert_ne!(credential_key(None), credential_key(Some("default")));
    }

    #[test]
    fn profile_probe_filters_ambient_provider_credentials() {
        for key in [
            "OPENAI_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "CODEX_API_KEY",
            "CODEX_HOME",
            "CODEX_SQLITE_HOME",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ] {
            assert!(is_ambient_provider_auth_environment(key));
        }
        assert!(!is_ambient_provider_auth_environment("HOME"));
        assert!(!is_ambient_provider_auth_environment("PATH"));
    }
}
