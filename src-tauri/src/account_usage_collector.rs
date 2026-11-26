//! The app's one periodic account usage check.
//!
//! Session logs change only after an account is used. This owner reads every
//! registered account's current limits on one schedule, through that
//! provider's own usage reader and without opening a pane or a turn, so
//! inactive accounts stay current too: Codex through App Server
//! (`codex_usage_collector`), Claude through the account usage request Claude
//! Code's `/usage` view makes (`claude_usage_reader`). Each provider's latest
//! successful reading per account is kept owner-only in the app home, and a
//! failed check never erases it: the error describes only that attempt.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Debug;
use std::future::Future;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;

use crate::claude_usage_reader::ClaudeUsage;
use crate::codex_usage_collector::CodexUsage;
use crate::usage::{AccountUsageSnapshot, UsageReport};
use crate::usage_recent_runtime::UsageRefreshProvider;

const CACHE_SCHEMA_VERSION: u32 = 1;
const POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);
const MAX_POLL_JITTER: Duration = Duration::from_secs(60);
const INACTIVE_PROBE_STAGGER: Duration = Duration::from_secs(2);
const MAX_CACHE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PROFILES: usize = 64;
const DEFAULT_CREDENTIAL_KEY: &str = "default";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// One provider's usage reader, run by the shared schedule.
pub(crate) trait AccountUsageReader: Send + Sync + 'static {
    /// The provider ID the account catalog names it by.
    const PROVIDER: &'static str;
    /// The cache in the app home that keeps this provider's readings.
    const CACHE_FILE_NAME: &'static str;
    /// The check failed before it could read any account.
    const HOME_UNAVAILABLE: &'static str;
    /// The account's registered profile directory did not validate.
    const CREDENTIAL_UNAVAILABLE: &'static str;
    /// What one successful check observes.
    type Reading: Clone
        + Debug
        + Default
        + PartialEq
        + Serialize
        + DeserializeOwned
        + Send
        + Sync
        + 'static;
    /// What one collection prepares once for all of this provider's accounts.
    type Context: Send + Sync;

    /// The provider's own state directory for its default login.
    fn default_directory(home: &Path) -> PathBuf;

    fn prepare(home: &Path) -> impl Future<Output = Result<Self::Context, &'static str>> + Send;

    fn read<'a>(
        context: &'a Self::Context,
        home: &'a Path,
        account: &'a UsageAccount,
        directory: &'a Path,
    ) -> impl Future<Output = Result<Self::Reading, &'static str>> + Send + 'a;
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageProfileInput {
    pub provider_id: String,
    pub credential_id: Option<String>,
    pub directory: Option<String>,
}

/// One account the check reads: a registered credential with its validated
/// profile directory, or the provider's default login (`credential_id` is
/// `None`). `directory` is `None` when the registered one did not validate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UsageAccount {
    pub(crate) credential_id: Option<String>,
    pub(crate) directory: Option<PathBuf>,
}

struct AccountsInner<T> {
    loaded: bool,
    accounts: BTreeMap<String, UsageAccount>,
    snapshots: BTreeMap<String, AccountUsageSnapshot<T>>,
}

impl<T> Default for AccountsInner<T> {
    fn default() -> Self {
        Self {
            loaded: false,
            accounts: BTreeMap::new(),
            snapshots: BTreeMap::new(),
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotCache<T> {
    schema_version: u32,
    snapshots: Vec<AccountUsageSnapshot<T>>,
}

/// One provider's accounts and readings inside the shared owner.
pub(crate) struct ProviderAccounts<R: AccountUsageReader> {
    inner: Mutex<AccountsInner<R::Reading>>,
    refresh: AsyncMutex<bool>,
    cache_path: Option<PathBuf>,
}

impl<R: AccountUsageReader> Default for ProviderAccounts<R> {
    fn default() -> Self {
        Self {
            inner: Mutex::new(AccountsInner::default()),
            refresh: AsyncMutex::new(false),
            cache_path: None,
        }
    }
}

impl<R: AccountUsageReader> ProviderAccounts<R> {
    #[cfg(test)]
    pub(crate) fn with_cache_path(cache_path: PathBuf) -> Self {
        Self {
            cache_path: Some(cache_path),
            ..Self::default()
        }
    }

    fn cache_path(&self) -> Result<PathBuf, String> {
        match &self.cache_path {
            Some(path) => Ok(path.clone()),
            None => Ok(crate::app_home::app_root_resolution()?
                .0
                .join(R::CACHE_FILE_NAME)),
        }
    }

    fn load_if_needed(&self, inner: &mut AccountsInner<R::Reading>) {
        if inner.loaded {
            return;
        }
        inner.loaded = true;
        let Ok(path) = self.cache_path() else { return };
        if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > MAX_CACHE_BYTES) {
            return;
        }
        let Ok(bytes) = std::fs::read(path) else {
            return;
        };
        let Ok(cache) = serde_json::from_slice::<SnapshotCache<R::Reading>>(&bytes) else {
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

    /// Replace this provider's catalog and drop readings of removed
    /// accounts. Returns whether the catalog changed, and the cache write.
    fn sync(&self, accounts: BTreeMap<String, UsageAccount>) -> (bool, Result<(), String>) {
        let mut inner = self.inner.lock().unwrap();
        self.load_if_needed(&mut inner);
        let changed = inner.accounts != accounts;
        inner.accounts = accounts;
        let current: BTreeSet<_> = inner.accounts.keys().cloned().collect();
        let snapshot_count = inner.snapshots.len();
        inner.snapshots.retain(|key, _| current.contains(key));
        let persisted = if inner.snapshots.len() == snapshot_count {
            Ok(())
        } else {
            self.persist(&inner.snapshots)
        };
        (changed, persisted)
    }

    pub(crate) fn snapshots(&self) -> Vec<AccountUsageSnapshot<R::Reading>> {
        let mut inner = self.inner.lock().unwrap();
        self.load_if_needed(&mut inner);
        inner.snapshots.values().cloned().collect()
    }

    /// Check every account now. A refresh requested while one is running
    /// shares that collection's result instead of starting another.
    pub(crate) async fn refresh(&self) -> bool {
        let mut result = match self.refresh.try_lock() {
            Ok(guard) => guard,
            Err(_) => return *self.refresh.lock().await,
        };
        *result = self.collect().await;
        *result
    }

    async fn collect(&self) -> bool {
        let accounts: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .accounts
            .values()
            .cloned()
            .collect();
        if accounts.is_empty() {
            return true;
        }
        let home = match std::env::var("HOME") {
            Ok(home) => PathBuf::from(home),
            Err(_) => {
                self.record_all_failures(&accounts, R::HOME_UNAVAILABLE);
                return false;
            }
        };
        let context = match R::prepare(&home).await {
            Ok(context) => context,
            Err(code) => {
                self.record_all_failures(&accounts, code);
                return false;
            }
        };
        let mut any_success = false;
        for (index, account) in accounts.iter().enumerate() {
            if index > 0 {
                tokio::time::sleep(INACTIVE_PROBE_STAGGER).await;
            }
            let attempted_at = now_secs();
            let result = match account.directory.as_deref() {
                Some(directory) => R::read(&context, &home, account, directory).await,
                None => Err(R::CREDENTIAL_UNAVAILABLE),
            };
            any_success |= result.is_ok();
            self.record_result(account, attempted_at, result);
        }
        any_success
    }

    fn record_all_failures(&self, accounts: &[UsageAccount], code: &'static str) {
        let attempted_at = now_secs();
        for account in accounts {
            self.record_result(account, attempted_at, Err(code));
        }
    }

    fn record_result(
        &self,
        account: &UsageAccount,
        attempted_at: u64,
        result: Result<R::Reading, &'static str>,
    ) {
        let key = credential_key(account.credential_id.as_deref());
        let mut inner = self.inner.lock().unwrap();
        let Some(current) = inner.accounts.get(&key) else {
            return;
        };
        // The catalog moved this account to another directory mid-check.
        if current.directory != account.directory {
            return;
        }
        let snapshot = inner
            .snapshots
            .entry(key)
            .or_insert_with(|| AccountUsageSnapshot {
                credential_id: account.credential_id.clone(),
                ..AccountUsageSnapshot::default()
            });
        apply_check(snapshot, attempted_at, result);
        let _ = self.persist(&inner.snapshots);
    }

    fn persist(
        &self,
        snapshots: &BTreeMap<String, AccountUsageSnapshot<R::Reading>>,
    ) -> Result<(), String> {
        persist_cache(
            &self.cache_path()?,
            &SnapshotCache {
                schema_version: CACHE_SCHEMA_VERSION,
                snapshots: snapshots.values().cloned().collect(),
            },
        )
    }
}

/// Validate one provider's catalog. Registered directories go through the
/// same trust boundary as managed launches; a renderer-supplied path that
/// fails it is kept as an account the check reports unavailable.
fn validate_accounts<R: AccountUsageReader>(
    home: &str,
    profiles: &[&AccountUsageProfileInput],
) -> Result<BTreeMap<String, UsageAccount>, String> {
    if profiles.len() > MAX_PROFILES {
        return Err("account_usage_profile_limit_exceeded".to_string());
    }
    let mut validated = BTreeMap::new();
    for profile in profiles {
        let key = credential_key(profile.credential_id.as_deref());
        if validated.contains_key(&key) {
            return Err("account_usage_duplicate_credential".to_string());
        }
        let directory = match (&profile.credential_id, &profile.directory) {
            (None, None) => Some(R::default_directory(Path::new(home))),
            (Some(credential_id), Some(directory)) => {
                crate::accounts::resolve_account_profile_directory(
                    R::PROVIDER,
                    home,
                    credential_id,
                    directory,
                )
                .ok()
            }
            _ => return Err("account_usage_invalid_credential_reference".to_string()),
        };
        validated.insert(
            key,
            UsageAccount {
                credential_id: profile.credential_id.clone(),
                directory,
            },
        );
    }
    Ok(validated)
}

pub(crate) fn apply_check<T>(
    snapshot: &mut AccountUsageSnapshot<T>,
    attempted_at: u64,
    result: Result<T, &'static str>,
) {
    snapshot.attempted_at = Some(attempted_at);
    match result {
        Ok(reading) => {
            snapshot.captured_at = Some(attempted_at);
            snapshot.error = None;
            snapshot.reading = reading;
        }
        Err(code) => {
            // 마지막 성공값은 절대 지우지 않는다. 오류는 이번 시도 상태만
            // 설명하며, UI가 capturedAt과 함께 stale로 표시한다.
            snapshot.error = Some(code.to_string());
        }
    }
}

struct CollectorShared {
    codex: ProviderAccounts<CodexUsage>,
    claude: ProviderAccounts<ClaudeUsage>,
    wake: tokio::sync::Notify,
    started: AtomicBool,
}

impl Default for CollectorShared {
    fn default() -> Self {
        Self {
            codex: ProviderAccounts::default(),
            claude: ProviderAccounts::default(),
            wake: tokio::sync::Notify::new(),
            started: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Default)]
pub struct AccountUsageCollector {
    shared: Arc<CollectorShared>,
}

impl AccountUsageCollector {
    /// Check one provider's accounts now, for a manual refresh. It joins a
    /// collection already running for that provider.
    pub(crate) async fn refresh(&self, provider: UsageRefreshProvider) -> bool {
        match provider {
            UsageRefreshProvider::Codex => self.shared.codex.refresh().await,
            UsageRefreshProvider::Claude => self.shared.claude.refresh().await,
        }
    }

    /// Put every provider's latest account readings on a usage report.
    pub(crate) fn attach_snapshots(&self, report: &mut UsageReport) {
        report.codex_account_snapshots = self.shared.codex.snapshots();
        report.claude_account_snapshots = self.shared.claude.snapshots();
    }

    fn sync_profiles(&self, profiles: Vec<AccountUsageProfileInput>) -> Result<(), String> {
        let home =
            std::env::var("HOME").map_err(|_| "account_usage_home_unavailable".to_string())?;
        let providers = [CodexUsage::PROVIDER, ClaudeUsage::PROVIDER];
        if profiles
            .iter()
            .any(|profile| !providers.contains(&profile.provider_id.as_str()))
        {
            return Err("account_usage_unknown_provider".to_string());
        }
        let of = |provider: &str| {
            profiles
                .iter()
                .filter(|profile| profile.provider_id == provider)
                .collect::<Vec<_>>()
        };
        let codex = validate_accounts::<CodexUsage>(&home, &of(CodexUsage::PROVIDER))?;
        let claude = validate_accounts::<ClaudeUsage>(&home, &of(ClaudeUsage::PROVIDER))?;
        let (codex_changed, codex_persisted) = self.shared.codex.sync(codex);
        let (claude_changed, claude_persisted) = self.shared.claude.sync(claude);
        let started = self.start();
        if (codex_changed || claude_changed) && !started {
            self.shared.wake.notify_one();
        }
        codex_persisted.and(claude_persisted)
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
                // Backs off only while no provider reads any account.
                let codex = collector.shared.codex.refresh().await;
                let claude = collector.shared.claude.refresh().await;
                if codex || claude {
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
}

#[tauri::command(async)]
pub fn account_usage_profiles_sync(
    state: tauri::State<'_, AccountUsageCollector>,
    profiles: Vec<AccountUsageProfileInput>,
) -> Result<(), String> {
    state.sync_profiles(profiles)
}

fn credential_key(credential_id: Option<&str>) -> String {
    credential_id
        .map(|credential_id| format!("credential:{credential_id}"))
        .unwrap_or_else(|| DEFAULT_CREDENTIAL_KEY.to_string())
}

pub(crate) fn now_secs() -> u64 {
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
        .map_err(|_| "account_usage_cache_publish_failed".to_string())
}

#[cfg(windows)]
fn replace_cache_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    if !destination.exists() {
        return std::fs::rename(temporary, destination)
            .map_err(|_| "account_usage_cache_publish_failed".to_string());
    }
    let backup = destination.with_extension("backup");
    let _ = std::fs::remove_file(&backup);
    std::fs::rename(destination, &backup)
        .map_err(|_| "account_usage_cache_publish_failed".to_string())?;
    match std::fs::rename(temporary, destination) {
        Ok(()) => {
            let _ = std::fs::remove_file(backup);
            Ok(())
        }
        Err(_) => {
            let _ = std::fs::rename(backup, destination);
            Err("account_usage_cache_publish_failed".to_string())
        }
    }
}

fn persist_cache<T: Serialize>(path: &Path, cache: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "account_usage_cache_path_invalid".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "account_usage_cache_unavailable".to_string())?;
    let bytes =
        serde_json::to_vec(cache).map_err(|_| "account_usage_cache_encode_failed".to_string())?;
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
            .map_err(|_| "account_usage_cache_unavailable".to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "account_usage_cache_write_failed".to_string())?;
        replace_cache_file(&temporary, path)?;
        #[cfg(unix)]
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "account_usage_cache_publish_failed".to_string())?;
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
    use crate::usage::{ClaudeUsageReading, ClaudeUsageWindow, ClaudeUsageWindowKind};

    #[tokio::test]
    async fn concurrent_refresh_joins_the_running_collection_result() {
        let accounts = ProviderAccounts::<CodexUsage>::default();
        let mut running = accounts.refresh.lock().await;
        *running = false;
        let joined = accounts.refresh();
        tokio::pin!(joined);
        tokio::select! {
            biased;
            _ = &mut joined => panic!("refresh must wait for the running collection"),
            _ = tokio::task::yield_now() => {}
        }
        drop(running);
        // An extra pass over the empty catalog would return true, hiding failure.
        assert!(!joined.await);
        assert!(accounts.refresh().await);
    }

    fn reading(used: f64) -> ClaudeUsageReading {
        ClaudeUsageReading {
            windows: vec![ClaudeUsageWindow {
                id: "seven_day_fable".into(),
                kind: ClaudeUsageWindowKind::ModelWeekly,
                model: Some("Fable".into()),
                used_percent: used,
                resets_at: Some(500),
            }],
        }
    }

    /// The owner keeps each Claude account's last success through later
    /// failed checks, persists it owner-only, and reloads it after a restart.
    #[test]
    fn claude_readings_survive_failures_and_restarts() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("claude-usage-snapshots.json");
        let accounts = ProviderAccounts::<ClaudeUsage>::with_cache_path(cache.clone());
        let account = UsageAccount {
            credential_id: Some("acc-a".into()),
            directory: Some(root.path().join("claude-a")),
        };
        let catalog = BTreeMap::from([(credential_key(Some("acc-a")), account.clone())]);
        assert_eq!(accounts.sync(catalog.clone()), (true, Ok(())));
        assert_eq!(accounts.sync(catalog.clone()), (false, Ok(())));

        accounts.record_result(&account, 100, Ok(reading(100.0)));
        accounts.record_result(&account, 200, Err("claude_usage_login_expired"));
        let snapshot = accounts.snapshots().pop().unwrap();
        assert_eq!(snapshot.credential_id.as_deref(), Some("acc-a"));
        assert_eq!(snapshot.captured_at, Some(100));
        assert_eq!(snapshot.attempted_at, Some(200));
        assert_eq!(
            snapshot.error.as_deref(),
            Some("claude_usage_login_expired")
        );
        assert_eq!(snapshot.reading, reading(100.0));

        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        assert_eq!(stored["schemaVersion"], 1);
        assert_eq!(stored["snapshots"][0]["windows"][0]["kind"], "modelWeekly");
        assert_eq!(stored["snapshots"][0]["windows"][0]["usedPercent"], 100.0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&cache).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let restarted = ProviderAccounts::<ClaudeUsage>::with_cache_path(cache.clone());
        assert_eq!(restarted.snapshots(), vec![snapshot]);
        // A result for a directory the catalog no longer holds is dropped,
        // and removing the account drops its reading.
        restarted.sync(catalog).1.unwrap();
        restarted.record_result(
            &UsageAccount {
                directory: Some(root.path().join("moved")),
                ..account
            },
            300,
            Ok(reading(1.0)),
        );
        assert_eq!(restarted.snapshots()[0].captured_at, Some(100));
        restarted.sync(BTreeMap::new()).1.unwrap();
        assert!(restarted.snapshots().is_empty());
    }

    fn collector_in(root: &Path) -> AccountUsageCollector {
        AccountUsageCollector {
            shared: Arc::new(CollectorShared {
                codex: ProviderAccounts::with_cache_path(root.join("codex-usage-snapshots.json")),
                claude: ProviderAccounts::with_cache_path(root.join("claude-usage-snapshots.json")),
                ..CollectorShared::default()
            }),
        }
    }

    /// A usage report carries every provider's account readings, each window
    /// typed, in the shape the desktop reads.
    #[test]
    fn a_usage_report_carries_every_providers_account_readings() {
        let root = tempfile::tempdir().unwrap();
        let collector = collector_in(root.path());
        let account = UsageAccount {
            credential_id: Some("acc-a".into()),
            directory: Some(root.path().join("claude-a")),
        };
        let catalog = BTreeMap::from([(credential_key(Some("acc-a")), account.clone())]);
        collector.shared.claude.sync(catalog).1.unwrap();
        collector
            .shared
            .claude
            .record_result(&account, 100, Ok(reading(100.0)));

        let mut report = UsageReport::default();
        collector.attach_snapshots(&mut report);
        let wire = serde_json::to_value(&report).unwrap();
        assert_eq!(
            wire["claudeAccountSnapshots"],
            serde_json::json!([{
                "credentialId": "acc-a",
                "capturedAt": 100,
                "attemptedAt": 100,
                "error": null,
                "windows": [{
                    "id": "seven_day_fable",
                    "kind": "modelWeekly",
                    "model": "Fable",
                    "usedPercent": 100.0,
                    "resetsAt": 500,
                }],
            }])
        );
        assert_eq!(wire["codexAccountSnapshots"], serde_json::json!([]));
    }

    /// A manual Claude refresh checks the Claude accounts, not Codex's.
    #[tokio::test]
    async fn a_manual_refresh_checks_only_the_provider_asked_for() {
        let root = tempfile::tempdir().unwrap();
        let collector = collector_in(root.path());
        // A directory that did not validate fails the check without a request.
        let unavailable = |id: &str| {
            BTreeMap::from([(
                credential_key(Some(id)),
                UsageAccount {
                    credential_id: Some(id.into()),
                    directory: None,
                },
            )])
        };
        collector
            .shared
            .claude
            .sync(unavailable("claude-a"))
            .1
            .unwrap();
        collector
            .shared
            .codex
            .sync(unavailable("codex-a"))
            .1
            .unwrap();

        assert!(!collector.refresh(UsageRefreshProvider::Claude).await);
        let claude = collector.shared.claude.snapshots();
        assert_eq!(claude.len(), 1);
        assert_eq!(
            claude[0].error.as_deref(),
            Some(ClaudeUsage::CREDENTIAL_UNAVAILABLE)
        );
        assert!(collector.shared.codex.snapshots().is_empty());
    }

    #[test]
    fn the_catalog_splits_by_provider_and_validates_each_reference() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().to_str().unwrap();
        let input =
            |provider: &str, id: Option<&str>, directory: Option<&str>| AccountUsageProfileInput {
                provider_id: provider.into(),
                credential_id: id.map(str::to_owned),
                directory: directory.map(str::to_owned),
            };
        let claude = [
            input("claude", None, None),
            input("claude", Some("acc-a"), Some("/outside/claude-a")),
        ];
        let accounts =
            validate_accounts::<ClaudeUsage>(home, &claude.iter().collect::<Vec<_>>()).unwrap();
        assert_eq!(
            accounts["default"].directory,
            Some(Path::new(home).join(".claude"))
        );
        // A path outside the account root never becomes a credential source.
        assert_eq!(accounts["credential:acc-a"].directory, None);
        let duplicate = [input("claude", None, None), input("claude", None, None)];
        assert!(
            validate_accounts::<ClaudeUsage>(home, &duplicate.iter().collect::<Vec<_>>()).is_err()
        );
        let half = [input("claude", Some("acc-a"), None)];
        assert!(validate_accounts::<ClaudeUsage>(home, &half.iter().collect::<Vec<_>>()).is_err());
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
    fn failure_keeps_the_last_success_reading() {
        let mut snapshot = AccountUsageSnapshot {
            credential_id: Some("acc-a".into()),
            captured_at: Some(100),
            attempted_at: Some(100),
            error: None,
            reading: reading(30.0),
        };
        apply_check(&mut snapshot, 200, Err("claude_usage_unavailable"));
        assert_eq!(snapshot.captured_at, Some(100));
        assert_eq!(snapshot.attempted_at, Some(200));
        assert_eq!(snapshot.reading, reading(30.0));
        apply_check(&mut snapshot, 300, Ok(reading(40.0)));
        assert_eq!(snapshot.captured_at, Some(300));
        assert_eq!(snapshot.error, None);
        assert_eq!(snapshot.reading, reading(40.0));
    }
}
