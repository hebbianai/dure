//! What this host already observes about a provider login, for automatic
//! account recovery: the usage the app's account meter last recorded, the
//! provider account behind the login, and whether the provider says the login
//! is usable. Readers return unknown instead of failing; an unknown fact never
//! sets an account aside.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::Value;

/// The Claude statusLine collector writes one cache per profile directory
/// under the platform home, keyed by that directory's name ("default" for the
/// provider's own login), as the app's account usage meter reads it.
const CLAUDE_USAGE_CACHE: &str = ".dure/usage/claude-rate-limits";
/// The app's Codex usage check keeps App Server snapshots by account ID in the
/// application home, beside `accounts/`.
const CODEX_USAGE_CACHE: &str = "codex-usage-snapshots.json";
const CODEX_NOT_SIGNED_IN: &str = "codex_usage_not_signed_in";
const MAX_USAGE_CACHE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LOGIN_RECORD_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ProviderLoginObservationV1 {
    /// The fuller current limit window the app recorded and when. A window
    /// that has reset since then, or a full one that purchased credits keep
    /// working, is unknown.
    pub(crate) usage: Option<(Option<f64>, i64)>,
    /// When that fuller window resets, as the provider reported it.
    pub(crate) limit_resets_at_ms: Option<i64>,
    /// The provider account this login signs in as, when the provider records
    /// it. Two logins with one account share its limits.
    pub(crate) account: Option<String>,
    /// False when the app's latest check found the login signed out.
    pub(crate) signed_in: Option<bool>,
}

/// Where one login keeps its provider state: a registered profile directory,
/// or the platform home for the provider's default login.
pub(crate) struct ProviderLoginLocationV1<'a> {
    pub(crate) application_home: &'a Path,
    pub(crate) platform_home: &'a Path,
    pub(crate) profile_directory: Option<&'a Path>,
    /// Every account ID registered for this login; empty for the default.
    pub(crate) reference_ids: &'a [String],
}

pub(crate) fn observe(
    provider_id: &str,
    location: &ProviderLoginLocationV1<'_>,
    observed_at_ms: i64,
) -> ProviderLoginObservationV1 {
    match provider_id {
        "claude" => {
            let key = match location.profile_directory {
                Some(directory) => directory.file_name().and_then(|name| name.to_str()),
                None => Some("default"),
            };
            let (usage, limit_resets_at_ms) = key
                .and_then(|key| {
                    read_json(
                        &location
                            .platform_home
                            .join(CLAUDE_USAGE_CACHE)
                            .join(format!("{key}.json")),
                        MAX_USAGE_CACHE_BYTES,
                    )
                })
                .and_then(|cache| claude_usage(&cache, observed_at_ms))
                .map_or((None, None), |(used, captured_at_ms)| {
                    (
                        Some((used.map(|window| window.used), captured_at_ms)),
                        used.and_then(|window| window.resets_at_ms),
                    )
                });
            // Without CLAUDE_CONFIG_DIR, Claude Code keeps it in the home root.
            let record = location
                .profile_directory
                .unwrap_or(location.platform_home)
                .join(".claude.json");
            ProviderLoginObservationV1 {
                usage,
                limit_resets_at_ms,
                account: read_json(&record, MAX_LOGIN_RECORD_BYTES)
                    .and_then(|record| text(record.pointer("/oauthAccount/accountUuid"))),
                signed_in: None,
            }
        }
        "codex" => {
            let check = read_json(
                &location.application_home.join(CODEX_USAGE_CACHE),
                MAX_USAGE_CACHE_BYTES,
            )
            .map(|cache| codex_check(&cache, location.reference_ids, observed_at_ms))
            .unwrap_or_default();
            let auth = match location.profile_directory {
                Some(directory) => directory.join("auth.json"),
                None => location.platform_home.join(".codex/auth.json"),
            };
            ProviderLoginObservationV1 {
                account: read_json(&auth, MAX_LOGIN_RECORD_BYTES)
                    .and_then(|auth| text(auth.pointer("/tokens/account_id"))),
                ..check
            }
        }
        _ => ProviderLoginObservationV1::default(),
    }
}

/// Claude Code's own `auth status --json` answer: not logged in, or a login
/// past `loginExpiresAt` (its refresh token's end), is signed out.
pub(crate) fn claude_auth_status(output: &[u8], observed_at_ms: i64) -> Option<bool> {
    let status: Value = serde_json::from_slice(output).ok()?;
    if !status.get("loggedIn")?.as_bool()? {
        return Some(false);
    }
    let expired = status
        .get("loginExpiresAt")
        .and_then(Value::as_str)
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| at.timestamp_millis() <= observed_at_ms);
    Some(!expired)
}

fn read_json(path: &Path, max_bytes: u64) -> Option<Value> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return None;
    }
    let mut source = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(max_bytes + 1)
        .read_to_end(&mut source)
        .ok()?;
    if source.len() as u64 > max_bytes {
        return None;
    }
    serde_json::from_slice(&source).ok()
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn percent(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0))
}

/// Seconds since the epoch as milliseconds, when it is a valid time.
fn seconds_ms(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_i64)
        .filter(|seconds| *seconds >= 0)
        .and_then(|seconds| seconds.checked_mul(1000))
}

/// One current provider limit window: how full it is and when it resets.
#[derive(Clone, Copy, Debug, PartialEq)]
struct LimitWindow {
    used: f64,
    resets_at_ms: Option<i64>,
}

/// The fullest reported window; of equally full ones, the one that resets
/// last, since the limit holds until both have reset.
fn fuller(windows: impl IntoIterator<Item = Option<LimitWindow>>) -> Option<LimitWindow> {
    windows.into_iter().flatten().max_by(|a, b| {
        a.used
            .total_cmp(&b.used)
            .then(a.resets_at_ms.cmp(&b.resets_at_ms))
    })
}

/// `{captured_at, rate_limits: {five_hour, seven_day}}`, each window with
/// `used_percentage` and `resets_at` in seconds.
fn claude_usage(cache: &Value, observed_at_ms: i64) -> Option<(Option<LimitWindow>, i64)> {
    let captured_at_ms = seconds_ms(cache.get("captured_at")).filter(|at| *at <= observed_at_ms)?;
    let limits = cache.get("rate_limits")?;
    let window = |name: &str| {
        let window = limits.get(name)?;
        let resets_at_ms =
            seconds_ms(window.get("resets_at")).filter(|reset| *reset > observed_at_ms)?;
        Some(LimitWindow {
            used: percent(window.get("used_percentage"))?,
            resets_at_ms: Some(resets_at_ms),
        })
    };
    Some((
        fuller([window("five_hour"), window("seven_day")]),
        captured_at_ms,
    ))
}

/// The newest App Server snapshot among the login's account IDs (a null ID
/// is the default login) and the newest check, which may have failed since.
fn codex_check(
    cache: &Value,
    reference_ids: &[String],
    observed_at_ms: i64,
) -> ProviderLoginObservationV1 {
    let Some(entries) = cache
        .get("snapshots")
        .and_then(Value::as_array)
        .filter(|_| cache.get("schemaVersion").and_then(Value::as_u64) == Some(1))
    else {
        return ProviderLoginObservationV1::default();
    };
    let login = entries
        .iter()
        .filter(|entry| match entry.get("credentialId") {
            Some(Value::String(id)) => reference_ids.iter().any(|reference| reference == id),
            Some(Value::Null) | None => reference_ids.is_empty(),
            Some(_) => false,
        });
    let newest = |field: &str| {
        login
            .clone()
            .filter_map(|entry| Some((seconds_ms(entry.get(field))?, entry)))
            .filter(|(at, _)| *at <= observed_at_ms)
            .max_by_key(|(at, _)| *at)
    };
    let snapshot = newest("capturedAt");
    let usage = snapshot.map(|(captured_at_ms, snapshot)| {
        let general = snapshot
            .get("rateLimits")
            .and_then(Value::as_array)
            .and_then(|limits| {
                limits
                    .iter()
                    .find(|limit| limit.get("limitId").and_then(Value::as_str) == Some("codex"))
            });
        let window = |used: &str, reset: &str| {
            let general = general?;
            let resets_at_ms = match general.get(reset) {
                None | Some(Value::Null) => None,
                reset => Some(seconds_ms(reset).filter(|reset| *reset > observed_at_ms)?),
            };
            Some(LimitWindow {
                used: percent(general.get(used))?,
                resets_at_ms,
            })
        };
        let used = fuller([
            window("usedPercent", "resetsAt"),
            window("usedPercentWeekly", "weeklyResetsAt"),
        ]);
        let credits = general.and_then(|general| general.get("credits"));
        let has_credits = credits.is_some_and(|credits| {
            credits.get("unlimited").and_then(Value::as_bool) == Some(true)
                || credits
                    .get("balance")
                    .and_then(Value::as_str)
                    .and_then(|balance| balance.trim().parse::<f64>().ok())
                    .is_some_and(|balance| balance.is_finite() && balance > 0.0)
        });
        // Credits keep an account working past a full window.
        let used = used.filter(|window| !(has_credits && window.used >= 100.0));
        (used, captured_at_ms)
    });
    let signed_out = newest("attemptedAt").is_some_and(|(attempted_at_ms, attempt)| {
        attempt.get("error").and_then(Value::as_str) == Some(CODEX_NOT_SIGNED_IN)
            && snapshot.is_none_or(|(captured_at_ms, _)| attempted_at_ms >= captured_at_ms)
    });
    ProviderLoginObservationV1 {
        usage: usage.map(|(used, captured_at_ms)| (used.map(|window| window.used), captured_at_ms)),
        limit_resets_at_ms: usage.and_then(|(used, _)| used?.resets_at_ms),
        account: None,
        signed_in: signed_out.then_some(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW_MS: i64 = 2_000_000_000_000;
    const NOW_S: i64 = NOW_MS / 1000;

    fn write(path: &Path, value: &Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    #[test]
    fn claude_reads_the_profile_cache_and_its_own_account() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        let application_home = home.join(".dure");
        let profile = application_home.join("accounts/claude-work");
        write(
            &home.join(CLAUDE_USAGE_CACHE).join("claude-work.json"),
            &json!({"captured_at": NOW_S - 60, "rate_limits": {
                "five_hour": {"used_percentage": 30.0, "resets_at": NOW_S + 600},
                "seven_day": {"used_percentage": 72.5, "resets_at": NOW_S + 6000}}}),
        );
        write(
            &profile.join(".claude.json"),
            &json!({"oauthAccount": {"accountUuid": "account-work", "emailAddress": "a@b"}}),
        );
        write(
            &home.join(CLAUDE_USAGE_CACHE).join("default.json"),
            &json!({"captured_at": NOW_S - 60, "rate_limits": {
                "five_hour": {"used_percentage": 99.0, "resets_at": NOW_S - 1},
                "seven_day": {"used_percentage": 10.0, "resets_at": NOW_S + 6000}}}),
        );
        write(
            &home.join(".claude.json"),
            &json!({"oauthAccount": {"accountUuid": "account-work"}}),
        );
        let observe_at = |profile_directory| {
            observe(
                "claude",
                &ProviderLoginLocationV1 {
                    application_home: &application_home,
                    platform_home: home,
                    profile_directory,
                    reference_ids: &[],
                },
                NOW_MS,
            )
        };
        // The fuller window describes use and says when the limit resets.
        assert_eq!(
            observe_at(Some(&profile)),
            ProviderLoginObservationV1 {
                usage: Some((Some(72.5), (NOW_S - 60) * 1000)),
                limit_resets_at_ms: Some((NOW_S + 6000) * 1000),
                account: Some("account-work".into()),
                signed_in: None,
            }
        );
        // A window that reset after the capture no longer describes use.
        assert_eq!(
            observe_at(None),
            ProviderLoginObservationV1 {
                usage: Some((Some(10.0), (NOW_S - 60) * 1000)),
                limit_resets_at_ms: Some((NOW_S + 6000) * 1000),
                account: Some("account-work".into()),
                signed_in: None,
            }
        );
        let missing = application_home.join("accounts/claude-other");
        assert_eq!(
            observe_at(Some(&missing)),
            ProviderLoginObservationV1::default()
        );
    }

    #[test]
    fn codex_reads_the_app_check_by_account_id_and_its_signed_out_result() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        let application_home = home.join(".dure");
        let profile = application_home.join("accounts/codex-work");
        let limit = |five: f64, weekly: f64, credits: Value| {
            json!([{"limitId": "codex", "usedPercent": five, "resetsAt": NOW_S + 60,
                "usedPercentWeekly": weekly, "weeklyResetsAt": NOW_S + 600, "credits": credits}])
        };
        write(
            &application_home.join(CODEX_USAGE_CACHE),
            &json!({"schemaVersion": 1, "snapshots": [
                {"credentialId": "acc-work", "capturedAt": NOW_S - 100, "attemptedAt": NOW_S - 100,
                    "error": null, "rateLimits": limit(12.0, 40.0, Value::Null)},
                {"credentialId": "acc-work-alias", "capturedAt": NOW_S - 50, "attemptedAt": NOW_S - 50,
                    "error": null, "rateLimits": limit(100.0, 20.0, json!({"balance": "12.5"}))},
                {"credentialId": "acc-out", "capturedAt": NOW_S - 900, "attemptedAt": NOW_S - 10,
                    "error": CODEX_NOT_SIGNED_IN, "rateLimits": limit(5.0, 5.0, Value::Null)},
                {"credentialId": "acc-down", "capturedAt": null, "attemptedAt": NOW_S - 10,
                    "error": "codex_usage_unavailable", "rateLimits": []},
                {"credentialId": null, "capturedAt": NOW_S - 30, "attemptedAt": NOW_S - 30,
                    "error": null, "rateLimits": limit(1.0, 11.0, Value::Null)},
            ]}),
        );
        write(
            &profile.join("auth.json"),
            &json!({"tokens": {"account_id": "chatgpt-work", "id_token": "secret"}}),
        );
        write(
            &home.join(".codex/auth.json"),
            &json!({"tokens": {"account_id": "chatgpt-default"}}),
        );
        let observe_at = |profile_directory, ids: &[&str]| {
            let ids = ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
            observe(
                "codex",
                &ProviderLoginLocationV1 {
                    application_home: &application_home,
                    platform_home: home,
                    profile_directory,
                    reference_ids: &ids,
                },
                NOW_MS,
            )
        };
        // The newest snapshot among the login's IDs wins; its credits keep a
        // full window usable, so its headroom is unknown rather than none.
        assert_eq!(
            observe_at(Some(&profile), &["acc-work", "acc-work-alias"]),
            ProviderLoginObservationV1 {
                usage: Some((None, (NOW_S - 50) * 1000)),
                limit_resets_at_ms: None,
                account: Some("chatgpt-work".into()),
                signed_in: None,
            }
        );
        let work = observe_at(Some(&profile), &["acc-work"]);
        assert_eq!(work.usage, Some((Some(40.0), (NOW_S - 100) * 1000)));
        assert_eq!(work.limit_resets_at_ms, Some((NOW_S + 600) * 1000));
        let signed_out = observe_at(None, &["acc-out"]);
        assert_eq!(signed_out.signed_in, Some(false));
        // Another failed check says nothing about the login.
        assert_eq!(observe_at(None, &["acc-down"]).signed_in, None);
        assert_eq!(
            observe_at(None, &[]),
            ProviderLoginObservationV1 {
                usage: Some((Some(11.0), (NOW_S - 30) * 1000)),
                limit_resets_at_ms: Some((NOW_S + 600) * 1000),
                account: Some("chatgpt-default".into()),
                signed_in: None,
            }
        );
    }

    #[test]
    fn equally_full_windows_reset_when_the_later_one_does() {
        let window = |used, resets_at_ms| Some(LimitWindow { used, resets_at_ms });
        assert_eq!(
            fuller([
                window(100.0, Some(NOW_MS + 600)),
                window(100.0, Some(NOW_MS + 60))
            ]),
            window(100.0, Some(NOW_MS + 600))
        );
        assert_eq!(
            fuller([
                window(99.0, Some(NOW_MS + 600)),
                window(100.0, Some(NOW_MS + 60))
            ]),
            window(100.0, Some(NOW_MS + 60))
        );
        // A window that reports no reset never hides one that does.
        assert_eq!(
            fuller([window(100.0, None), window(100.0, Some(NOW_MS + 60))]),
            window(100.0, Some(NOW_MS + 60))
        );
        assert_eq!(fuller([None, None]), None);
    }

    #[test]
    fn claude_auth_status_treats_a_logged_out_or_expired_login_as_signed_out() {
        let at = |seconds: i64| {
            chrono::DateTime::from_timestamp(seconds, 0)
                .unwrap()
                .to_rfc3339()
        };
        let status =
            |value: Value| claude_auth_status(&serde_json::to_vec(&value).unwrap(), NOW_MS);
        assert_eq!(status(json!({"loggedIn": false})), Some(false));
        assert_eq!(
            status(json!({"loggedIn": true, "loginExpiresAt": at(NOW_S - 1)})),
            Some(false)
        );
        assert_eq!(
            status(json!({"loggedIn": true, "loginExpiresAt": at(NOW_S + 3600)})),
            Some(true)
        );
        assert_eq!(status(json!({"loggedIn": true})), Some(true));
        assert_eq!(status(json!({"authMethod": "none"})), None);
        assert_eq!(claude_auth_status(b"Not logged in", NOW_MS), None);
    }
}
