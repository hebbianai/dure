//! Codex's reader for the app's account usage check.
//!
//! 세션 JSONL은 "그 계정을 사용한 뒤"에만 갱신된다. 이 reader는 공식 Codex
//! App Server의 `account/rateLimits/read`를 각 CODEX_HOME에서 호출해, pane이나
//! turn을 만들지 않고 비활성 계정도 갱신한다. The schedule, the account
//! catalog and the owner-only cache are `account_usage_collector`'s.

use hmux_client::TerminalEnvironment;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::account_usage_collector::{AccountUsageReader, UsageAccount};
use crate::usage::{CodexRateLimitUsage as CodexPolledRateLimit, CodexUsageReading};

const BOOT_TIMEOUT: Duration = Duration::from_secs(40);
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE_LINE_BYTES: u64 = 1024 * 1024;
const MARKETPLACE_STAGING_ABANDONED_AFTER: Duration = Duration::from_secs(60 * 60);
const MAX_MARKETPLACE_STAGING_SWEEP: usize = 256;
const AMBIENT_PROVIDER_AUTH_ENVIRONMENT: [&str; 7] = [
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
    "CODEX_HOME",
    "CODEX_SQLITE_HOME",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

fn is_ambient_provider_auth_environment(key: &str) -> bool {
    AMBIENT_PROVIDER_AUTH_ENVIRONMENT.contains(&key)
}

pub(crate) struct CodexUsage;

/// What one collection resolves once for every Codex account.
pub(crate) struct CodexUsageContext {
    resolved: crate::provider_preflight::ResolvedLoginCommandEnvironment,
    sqlite_home: PathBuf,
}

impl AccountUsageReader for CodexUsage {
    const PROVIDER: &'static str = "codex";
    const CACHE_FILE_NAME: &'static str = "codex-usage-snapshots.json";
    const HOME_UNAVAILABLE: &'static str = "codex_usage_home_unavailable";
    const CREDENTIAL_UNAVAILABLE: &'static str = "codex_usage_credential_unavailable";
    type Reading = CodexUsageReading;
    type Context = CodexUsageContext;

    fn default_directory(home: &Path) -> PathBuf {
        home.join(".codex")
    }

    async fn prepare(home: &Path) -> Result<Self::Context, &'static str> {
        let sqlite_home =
            crate::accounts::resolve_codex_canonical_state_directory(&home.to_string_lossy())
                .map_err(|_| "codex_usage_canonical_state_unavailable")?;
        let resolved = resolve_codex_environment(home.to_path_buf()).await?;
        Ok(CodexUsageContext {
            resolved,
            sqlite_home,
        })
    }

    async fn read<'a>(
        context: &'a Self::Context,
        home: &'a Path,
        _account: &'a UsageAccount,
        codex_home: &'a Path,
    ) -> Result<Self::Reading, &'static str> {
        let staging = codex_home.to_path_buf();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            sweep_abandoned_marketplace_staging(&staging, SystemTime::now())
        })
        .await;
        probe_profile(&context.resolved, home, &context.sqlite_home, codex_home).await
    }
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
    codex_home: &Path,
) -> Result<CodexUsageReading, &'static str> {
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
        // A probe lives a few seconds. With plugins on, App Server starts a
        // marketplace upgrade at launch that the probe's stop interrupts,
        // leaving its staging copy in CODEX_HOME every poll. Codex ignores an
        // unrecognized feature override, so older releases still start.
        .args(["-c", "features.plugins=false"])
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
) -> Result<CodexUsageReading, &'static str> {
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

fn parse_rate_limits(response: &serde_json::Value) -> Result<CodexUsageReading, &'static str> {
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
    Ok(CodexUsageReading {
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

/// Probes before `features.plugins=false` stopped App Server during its
/// marketplace upgrade and left one staging clone per poll in CODEX_HOME.
/// Codex removes a copy it finishes with, so a copy untouched for an hour is
/// abandoned. Each poll removes a bounded batch and never follows a link out
/// of the profile's CODEX_HOME.
fn sweep_abandoned_marketplace_staging(codex_home: &Path, now: SystemTime) -> usize {
    let mut staging = codex_home.to_path_buf();
    for component in [".tmp", "marketplaces", ".staging"] {
        staging.push(component);
        if !std::fs::symlink_metadata(&staging).is_ok_and(|metadata| metadata.is_dir()) {
            return 0;
        }
    }
    let Ok(entries) = std::fs::read_dir(&staging) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        if removed == MAX_MARKETPLACE_STAGING_SWEEP {
            break;
        }
        let path = entry.path();
        let upgrade_copy = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("marketplace-upgrade-"));
        let abandoned = std::fs::symlink_metadata(&path).is_ok_and(|metadata| {
            metadata.is_dir()
                && metadata
                    .modified()
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|age| age >= MARKETPLACE_STAGING_ABANDONED_AFTER)
        });
        if upgrade_copy && abandoned && std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_usage_collector::apply_check as apply_probe_result;
    use crate::usage::CodexUsageSnapshot;
    use std::io::Write as _;

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
[ "$#" -eq 3 ] && [ "$1" = "app-server" ] && [ "$2" = "-c" ] && [ "$3" = "features.plugins=false" ] || exit 64
IFS= read -r initialize || exit 65
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized || exit 66
IFS= read -r request || exit 67
printf '%s\n' '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":21,"resetsAt":10},"secondary":{"usedPercent":34,"resetsAt":20}},"rateLimitResetCredits":{"availableCount":3,"credits":null}}}'
"#,
            )
            .unwrap();
        script.sync_all().unwrap();
        // Linux refuses to execute a file still open for writing.
        drop(script);

        let resolved = crate::provider_preflight::ResolvedLoginCommandEnvironment {
            executable,
            environment: BTreeMap::new(),
        };
        let limits = probe_profile(&resolved, directory.path(), directory.path(), &codex_home)
            .await
            .unwrap();
        assert_eq!(limits.rate_limits[0].used_percent, Some(21.0));
        assert_eq!(limits.rate_limits[0].used_percent_weekly, Some(34.0));
        assert_eq!(limits.rate_limit_resets_available, Some(3));
    }

    #[test]
    fn sweeps_only_abandoned_marketplace_upgrade_copies() {
        let directory = tempfile::tempdir().unwrap();
        let codex_home = directory.path().join("codex-home");
        let staging = codex_home.join(".tmp/marketplaces/.staging");
        std::fs::create_dir_all(staging.join("marketplace-upgrade-a/.git")).unwrap();
        std::fs::write(staging.join("marketplace-upgrade-a/.git/HEAD"), b"ref\n").unwrap();
        std::fs::create_dir(staging.join("unrelated")).unwrap();
        std::fs::write(staging.join("marketplace-upgrade-file"), b"").unwrap();
        let outside = directory.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep"), b"").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, staging.join("marketplace-upgrade-link")).unwrap();

        // A copy that may still be in use stays.
        assert_eq!(
            sweep_abandoned_marketplace_staging(&codex_home, SystemTime::now()),
            0
        );
        assert!(staging.join("marketplace-upgrade-a").exists());

        let later = SystemTime::now() + 2 * MARKETPLACE_STAGING_ABANDONED_AFTER;
        assert_eq!(sweep_abandoned_marketplace_staging(&codex_home, later), 1);
        assert!(!staging.join("marketplace-upgrade-a").exists());
        assert!(staging.join("unrelated").exists());
        assert!(staging.join("marketplace-upgrade-file").exists());
        assert!(outside.join("keep").exists());
    }

    #[cfg(unix)]
    #[test]
    fn staging_sweep_does_not_follow_a_linked_staging_directory() {
        let directory = tempfile::tempdir().unwrap();
        let codex_home = directory.path().join("codex-home");
        std::fs::create_dir_all(codex_home.join(".tmp/marketplaces")).unwrap();
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(outside.join("marketplace-upgrade-a")).unwrap();
        std::os::unix::fs::symlink(&outside, codex_home.join(".tmp/marketplaces/.staging"))
            .unwrap();
        let later = SystemTime::now() + 2 * MARKETPLACE_STAGING_ABANDONED_AFTER;
        assert_eq!(sweep_abandoned_marketplace_staging(&codex_home, later), 0);
        assert!(outside.join("marketplace-upgrade-a").exists());
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
            assert_eq!(decoded.reading.rate_limit_resets_available, Some(count));
            assert_eq!(decoded.captured_at, Some(100));
            apply_probe_result(&mut snapshot, 200, Err("codex_usage_unavailable"));
            assert_eq!(snapshot.reading.rate_limit_resets_available, Some(count));
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
            assert_eq!(snapshot.reading.rate_limit_resets_available, None);
            assert_eq!(snapshot.captured_at, Some(300));
            assert!(snapshot.error.is_none());
            assert_eq!(snapshot.reading.rate_limits[0].used_percent, Some(20.0));
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
        assert_eq!(old_cache.reading.rate_limits[0].used_percent, Some(0.0));
        assert_eq!(old_cache.reading.rate_limit_resets_available, None);
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
            reading: CodexUsageReading {
                rate_limit_resets_available: None,
                rate_limits: vec![CodexPolledRateLimit {
                    limit_id: "codex".into(),
                    used_percent: Some(30.0),
                    ..CodexPolledRateLimit::default()
                }],
            },
        };
        apply_probe_result(&mut snapshot, 200, Err("codex_usage_unavailable"));
        assert_eq!(snapshot.captured_at, Some(100));
        assert_eq!(snapshot.attempted_at, Some(200));
        assert_eq!(snapshot.reading.rate_limits[0].used_percent, Some(30.0));
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
