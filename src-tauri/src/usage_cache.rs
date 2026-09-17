//! usage_stats의 파일 단위 파싱 결과 캐시.
//!
//! 42일 창에 드는 로그는 실측 6,438개 파일 3.86GB였고, 매번 전부 읽어 22초가
//! 걸렸다. 설정을 닫았다 열 때마다 반복된다. 세션 로그는 append-only라
//! (mtime, size)가 그대로면 파싱 결과도 그대로다 — 그 결과를 캐시한다.
//!
//! 캐시는 파일별 합계와 bounded recent projection만 보관한다. 원시 로그 이벤트를
//! 프로세스 수명만큼 붙들면 로그 I/O를 multi-GiB heap으로 바꾸는 셈이다.
//!
//! Claude와 Codex의 캐시 단위가 다른 이유:
//! - Claude는 message.id로 **파일을 가로질러** 중복을 제거한다(재개한 대화는
//!   이전 메시지를 새 파일에 복사한다). 그래서 레코드를 id째로 보관해야 한다.
//! - Codex는 가로지르는 중복 제거가 없다. 통계 화면은 파일별 일일 합계를 쓰고,
//!   정확한 5시간/24시간 창은 같은 초의 토큰 이벤트를 하나로 접은 projection을
//!   쓴다. UI cutoff가 초 단위라 표시값은 원시 이벤트와 같다.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

/// 파일이 바뀌었는지 판정하는 지문. 내용 해시가 아니라 메타데이터인 이유는
/// 내용을 읽는 순간 캐시의 목적이 사라지기 때문이다.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct FileStamp {
    #[serde(rename = "m", alias = "mtime")]
    pub mtime: u64,
    #[serde(rename = "s", alias = "size")]
    pub size: u64,
}

impl FileStamp {
    pub fn of(path: &Path) -> Option<Self> {
        let meta = fs::metadata(path).ok()?;
        let mtime = meta
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos()
            .min(u128::from(u64::MAX)) as u64;
        Some(FileStamp { mtime, size: meta.len() })
    }

    pub fn modified_seconds(self) -> u64 {
        self.mtime / 1_000_000_000
    }
}

/// Claude 로그 한 줄에서 뽑은 usage 레코드.
///
/// id는 파일을 가로지르는 중복 제거 키라 보관한다. 날짜가 아니라 **전체
/// 타임스탬프**를 담는 이유는 캐시가 창에 종속되지 않게 하기 위해서다 —
/// 배지는 5시간, 설정은 N일 창을 쓰는데 날짜만 남기면 5시간 창에서 하루치가
/// 통째로 딸려 들어온다. 창 필터는 읽는 쪽이 건다.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct ClaudeRecord {
    #[serde(rename = "i", alias = "id")]
    pub id: Option<String>,
    #[serde(rename = "n", alias = "input")]
    pub input: u64,
    #[serde(rename = "o", alias = "output")]
    pub output: u64,
    #[serde(rename = "r", alias = "cache_read")]
    pub cache_read: u64,
    #[serde(rename = "w", alias = "cache_write")]
    pub cache_write: u64,
    #[serde(rename = "t", alias = "ts")]
    pub ts: String,
}

/// Codex 파일 하나를 **날짜별로** 접은 값.
///
/// 파일 통째 합계로 두면 집계 기간이 바뀔 때마다 캐시가 통째로 무효가 된다
/// (기간은 이제 사용자가 고른다). 날짜 버킷이면 창이 바뀌어도 버킷만 골라
/// 더하면 되므로 캐시가 살아남는다.
///
/// Codex는 파일을 가로지르는 중복 제거가 없어 줄 단위로 보관할 이유가 없다.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CodexFileTotals {
    /// 날짜 → 그날의 원시 합계
    pub days: BTreeMap<String, CodexDayTotals>,
    /// limit_id → 그 파일 안에서 가장 새로운 rate limit
    pub rate_limits: BTreeMap<String, TimedLimit>,
    /// 세션-계정 귀속에 쓰는 conversation id (파일 내용에서 뽑는다).
    pub conversation_id: Option<String>,
    /// 이 시각부터 `recent`가 완전하다. None이면 일일 합계만 cache hit로 쓸 수
    /// 있고 exact recent query는 파일을 다시 읽는다.
    #[serde(rename = "f", default, skip_serializing_if = "Option::is_none")]
    pub recent_floor: Option<String>,
    /// 분 단위 recent token projection(분 floor를 초 모양으로 기록). rate
    /// limit은 파일별 최신 값 하나만 있으면
    /// 모든 창에서 같은 결과가 나오므로 위 `rate_limits`가 sole authority다.
    #[serde(rename = "r", default, skip_serializing_if = "Vec::is_empty")]
    pub recent: Vec<CodexTimeBucket>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct CodexTimeBucket {
    #[serde(rename = "s")]
    pub second: String,
    #[serde(rename = "i")]
    pub input: u64,
    #[serde(rename = "o")]
    pub output: u64,
    #[serde(rename = "c")]
    pub cache_read: u64,
    #[serde(rename = "n")]
    pub turns: u64,
}

impl CodexTimeBucket {
    fn absorb(&mut self, input: u64, output: u64, cache_read: u64, turns: u64) {
        self.input += input;
        self.output += output;
        self.cache_read += cache_read;
        self.turns += turns;
    }
}

impl CodexFileTotals {
    pub fn absorb_recent(&mut self, timestamp: &str, input: u64, output: u64, cache_read: u64) {
        // Minute floor, second-shaped ("…T10:15:00") so ISO ordering and every
        // window comparison stay valid. Per-second buckets made bucket count
        // proportional to event count: one live 43k-turns/day rollout alone
        // approached MAX_CODEX_RECENT_BUCKETS, and capacity eviction then
        // erased that file's recent_floor, forcing a full re-parse of the
        // multi-hundred-MB file on every scan (2026-08-24 live daily driver:
        // a self-sustaining ~876MB disk-read loop). Minute buckets are bounded
        // by time (2,880 per file per 48h), not by activity; moving-window
        // queries get minute precision at the boundary, and exact daily sums
        // stay second-independent in `days`.
        let minute = timestamp.get(..16).unwrap_or(timestamp);
        let second = format!("{minute}:00");
        match self
            .recent
            .binary_search_by(|bucket| bucket.second.as_str().cmp(&second))
        {
            Ok(index) => self.recent[index].absorb(input, output, cache_read, 1),
            Err(index) => self.recent.insert(
                index,
                CodexTimeBucket {
                    second,
                    input,
                    output,
                    cache_read,
                    turns: 1,
                },
            ),
        }
    }
}

/// 하루치 원시 합계. 활동 토큰은 (input - cache_read) + output이라 파생 가능한
/// 값이지만, 원시 값을 남겨야 입력·출력·캐시를 따로 쓰는 화면이 성립한다.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CodexDayTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub turns: u64,
}

impl CodexDayTotals {
    pub fn absorb(&mut self, input: u64, output: u64, cache_read: u64) {
        self.input += input;
        self.output += output;
        self.cache_read += cache_read;
        self.turns += 1;
    }

    /// 로컬 활동 토큰 — Codex의 input_tokens는 cached_input_tokens를 이미
    /// 포함하므로 재사용분을 빼야 한 번만 센다.
    pub fn activity(&self) -> u64 {
        self.input.saturating_sub(self.cache_read) + self.output
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct TimedLimit {
    pub timestamp: String,
    /// timestamp의 날짜 부분 — 기간 필터를 날짜 단위로 걸기 위해 함께 둔다.
    pub date: String,
    pub limit_id: String,
    pub limit_name: Option<String>,
    pub used_percent: Option<f64>,
    pub used_percent_weekly: Option<f64>,
    pub resets_at: Option<u64>,
    pub weekly_resets_at: Option<u64>,
}

/// 캐시 항목의 재개 지점.
///
/// `parsed_bytes`는 **마지막 완결 줄 다음** 오프셋이다. 쓰는 중인 파일은
/// 마지막 줄이 잘려 있을 수 있으므로, 여기서 개행까지만 인정하지 않으면
/// 다음 스캔이 반 토막 줄을 이어 붙여 레코드를 잃는다.
///
/// `head`는 앞 4KB 지문이다. append-only라는 가정이 깨졌을 때(회전·재작성)
/// 꼬리만 읽으면 조용히 남의 파일을 이어 붙이게 된다 — 그 경우를 잡는다.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Resume {
    #[serde(rename = "p", alias = "parsed_bytes")]
    pub parsed_bytes: u64,
    #[serde(rename = "h", alias = "head")]
    pub head: u64,
}

/// 캐시 항목을 어떻게 쓸지.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ResumePlan {
    /// 지문이 그대로 — 파일을 아예 열지 않는다.
    Reuse,
    /// append-only로 자랐다 — 이 오프셋부터 끝까지만 읽는다.
    Tail(u64),
    /// 처음부터 다시 (캐시 없음·절단·재작성).
    Full,
}

/// 지문과 앞부분이 맞을 때만 꼬리 읽기를 허용한다.
///
/// 크기가 줄었으면 절단/회전이고, 앞 4KB가 달라졌으면 다른 파일이 같은
/// 이름을 차지한 것이다. 둘 다 이어 붙이면 없던 사용량이 생긴다.
pub fn resume_plan(cached: Option<(Resume, FileStamp)>, now: FileStamp, head: u64) -> ResumePlan {
    let Some((resume, was)) = cached else { return ResumePlan::Full };
    if was == now {
        return ResumePlan::Reuse;
    }
    if resume.head != head || now.size < resume.parsed_bytes {
        return ResumePlan::Full;
    }
    ResumePlan::Tail(resume.parsed_bytes)
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct ClaudeEntry {
    stamp: FileStamp,
    #[serde(default)]
    resume: Resume,
    records: Vec<ClaudeRecord>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct CodexEntry {
    stamp: FileStamp,
    #[serde(default)]
    resume: Resume,
    totals: CodexFileTotals,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct UsageScanCache {
    /// 형식이 바뀌면 통째로 버린다 — 낡은 항목을 새 코드로 해석하면 조용히
    /// 틀린 숫자가 나온다.
    version: u32,
    claude: BTreeMap<String, Arc<ClaudeEntry>>,
    codex: BTreeMap<String, Arc<CodexEntry>>,
    #[serde(skip)]
    dirty_claude: BTreeSet<String>,
    #[serde(skip)]
    dirty_codex: BTreeSet<String>,
    #[serde(skip)]
    codex_prune_before: Option<String>,
    #[serde(skip)]
    compact_persisted: bool,
}

const CACHE_VERSION: u32 = 5;
const JOURNAL_VERSION: u32 = 4;
const JOURNAL_COMPACT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CACHE_JOURNAL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_JOURNAL_RECORD_BYTES: u64 = 2 * 1024 * 1024;
const JOURNAL_WRITE_BUFFER_BYTES: usize = 64 * 1024;
const MAX_CACHE_ENTRIES_PER_PROVIDER: usize = 8_192;
const MAX_CLAUDE_RECORDS: usize = 262_144;
const MAX_CODEX_RECENT_BUCKETS: usize = 262_144;

impl ClaudeEntry {
    fn append(&mut self, stamp: FileStamp, resume: Resume, mut records: Vec<ClaudeRecord>) {
        self.records.append(&mut records);
        self.records = compact_claude(std::mem::take(&mut self.records));
        self.stamp = stamp;
        self.resume = resume;
    }
}

fn merge_codex_totals(target: &mut CodexFileTotals, more: CodexFileTotals) {
    for (date, day) in more.days {
        let slot = target.days.entry(date).or_default();
        slot.input += day.input;
        slot.output += day.output;
        slot.cache_read += day.cache_read;
        slot.turns += day.turns;
    }
    for (id, limit) in more.rate_limits {
        let newer = target
            .rate_limits
            .get(&id)
            .is_none_or(|current| limit.timestamp > current.timestamp);
        if newer {
            target.rate_limits.insert(id, limit);
        }
    }
    if target.conversation_id.is_none() {
        target.conversation_id = more.conversation_id;
    }
    for bucket in more.recent {
        match target
            .recent
            .binary_search_by(|current| current.second.cmp(&bucket.second))
        {
            Ok(index) => target.recent[index].absorb(
                bucket.input,
                bucket.output,
                bucket.cache_read,
                bucket.turns,
            ),
            Err(index) => target.recent.insert(index, bucket),
        }
    }
}

impl CodexEntry {
    fn merge(&mut self, stamp: FileStamp, resume: Resume, totals: CodexFileTotals) {
        merge_codex_totals(&mut self.totals, totals);
        self.stamp = stamp;
        self.resume = resume;
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct UsageCacheReplacement {
    #[serde(rename = "v")]
    version: u32,
    #[serde(rename = "c", default, skip_serializing_if = "BTreeMap::is_empty")]
    claude: BTreeMap<String, Option<Arc<ClaudeEntry>>>,
    #[serde(rename = "x", default, skip_serializing_if = "BTreeMap::is_empty")]
    codex: BTreeMap<String, Option<Arc<CodexEntry>>>,
    #[serde(rename = "xp", default, skip_serializing_if = "Option::is_none")]
    codex_prune_before: Option<String>,
}

impl UsageCacheReplacement {
    fn merge(&mut self, newer: UsageCacheReplacement) {
        self.version = JOURNAL_VERSION;
        for (key, entry) in newer.claude {
            self.claude.insert(key, entry);
        }
        for (key, entry) in newer.codex {
            self.codex.insert(key, entry);
        }
        if let Some(cutoff) = newer.codex_prune_before {
            self.codex_prune_before = Some(
                self.codex_prune_before
                    .as_deref()
                    .map_or(cutoff.clone(), |current| current.max(cutoff.as_str()).to_string()),
            );
        }
    }

    fn retain_current_file_generations(&mut self) {
        let matches_raw = |path: &str, stamp: FileStamp, resume: Resume| {
            let path = Path::new(path);
            FileStamp::of(path) == Some(stamp)
                && head_fingerprint(path, resume) == resume.head
        };
        let raw_is_absent = |path: &str| {
            fs::metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        };
        self.claude.retain(|path, entry| match entry {
            Some(entry) => matches_raw(path, entry.stamp, entry.resume),
            None => raw_is_absent(path),
        });
        self.codex.retain(|path, entry| match entry {
            Some(entry) => matches_raw(path, entry.stamp, entry.resume),
            None => raw_is_absent(path),
        });
    }

    fn is_empty(&self) -> bool {
        self.claude.is_empty() && self.codex.is_empty() && self.codex_prune_before.is_none()
    }
}

#[derive(Debug, Default)]
pub(crate) struct UsageCacheWrite {
    compact_first: bool,
    entries: UsageCacheReplacement,
}

pub fn cache_path(home: &str) -> PathBuf {
    crate::app_home::app_root_under(Path::new(home))
        .join(format!("usage-scan-cache-v{CACHE_VERSION}.json"))
}

pub fn cache_journal_path(home: &str) -> PathBuf {
    crate::app_home::app_root_under(Path::new(home))
        .join(format!("usage-scan-cache-v{CACHE_VERSION}.journal.jsonl"))
}

fn cache_lock_path(home: &str) -> PathBuf {
    crate::app_home::app_root_under(Path::new(home))
        .join(format!("usage-scan-cache-v{CACHE_VERSION}.lock"))
}

struct CacheFileLock(fs::File);

impl CacheFileLock {
    fn acquire(home: &str) -> Option<Self> {
        // uiux-dev, hebbianide, and the installed app share one canonical HOME.
        // This lock is therefore a filesystem generation boundary, not merely a
        // process mutex around JSON writes.
        let path = cache_lock_path(home);
        fs::create_dir_all(path.parent()?).ok()?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
            .ok()?;
        FileExt::lock_exclusive(&file).ok()?;
        Some(Self(file))
    }
}

impl Drop for CacheFileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub(crate) fn journal_needs_compaction(home: &str) -> bool {
    fs::metadata(cache_journal_path(home))
        .is_ok_and(|metadata| metadata.len() >= JOURNAL_COMPACT_BYTES)
}

pub(crate) fn compact_persisted_cache(home: &str) -> bool {
    let Some(_file_lock) = CacheFileLock::acquire(home) else { return false };
    compact_persisted_cache_locked(home)
}

fn compact_persisted_cache_locked(home: &str) -> bool {
    let Some(mut cache) = persisted_cache_for_rewrite_locked(home) else { return false };
    cache.enforce_capacity();
    write_snapshot_atomic(home, &cache)
}

fn compact_with_replacement_locked(
    home: &str,
    replacement: &UsageCacheReplacement,
) -> bool {
    let Some(mut cache) = persisted_cache_for_rewrite_locked(home) else { return false };
    let mut replacement = replacement.clone();
    replacement.retain_current_file_generations();
    cache.apply_replacement(replacement);
    cache.enforce_capacity();
    write_snapshot_atomic(home, &cache)
}

fn persisted_cache_for_rewrite_locked(home: &str) -> Option<UsageScanCache> {
    if !recover_snapshot_transaction(home) {
        return None;
    }
    let mut cache = read_current_snapshot(&cache_path(home)).unwrap_or_else(UsageScanCache::empty);
    if !replay_journal(home, &mut cache) {
        // The cache is derived data. An incomplete or foreign-generation
        // journal must never make a partially replayed graph authoritative.
        cache = UsageScanCache::empty();
    }
    Some(cache)
}

fn ensure_current_snapshot_locked(home: &str) -> bool {
    if !recover_snapshot_transaction(home) {
        return false;
    }
    has_current_snapshot_header(&cache_path(home))
        || write_snapshot_atomic(home, &UsageScanCache::empty())
}

impl UsageScanCache {
    pub fn load(home: &str) -> Self {
        let Some(_file_lock) = CacheFileLock::acquire(home) else {
            let mut cache = Self::empty();
            cache.compact_persisted = true;
            return cache;
        };
        if !recover_snapshot_transaction(home) {
            let mut cache = Self::empty();
            cache.compact_persisted = true;
            return cache;
        }
        let Some(mut cache) = read_current_snapshot(&cache_path(home)) else {
            // 캐시는 성능 장치다. 낡거나 oversized인 파일은 deserialize하지 않고
            // 빈 current schema로 교체해 한 번의 느린 scan만 허용한다.
            let mut cache = Self::empty();
            cache.compact_persisted = true;
            return cache;
        };
        cache.compact_claude_records();
        if cache.enforce_capacity() {
            cache.compact_persisted = true;
        }
        if !replay_journal(home, &mut cache) {
            cache.compact_persisted = true;
        }
        if journal_needs_compaction(home) {
            cache.compact_persisted = true;
        }
        cache
    }

    fn empty() -> Self {
        UsageScanCache {
            version: CACHE_VERSION,
            claude: BTreeMap::new(),
            codex: BTreeMap::new(),
            dirty_claude: BTreeSet::new(),
            dirty_codex: BTreeSet::new(),
            codex_prune_before: None,
            compact_persisted: false,
        }
    }

    pub(crate) fn take_write(&mut self) -> Option<UsageCacheWrite> {
        let compact_first = std::mem::take(&mut self.compact_persisted);
        if self.dirty_claude.is_empty()
            && self.dirty_codex.is_empty()
            && self.codex_prune_before.is_none()
            && !compact_first
        {
            return None;
        }
        let mut entries = UsageCacheReplacement { version: JOURNAL_VERSION, ..Default::default() };
        for key in std::mem::take(&mut self.dirty_claude) {
            entries.claude.insert(key.clone(), self.claude.get(&key).cloned());
        }
        for key in std::mem::take(&mut self.dirty_codex) {
            entries.codex.insert(key.clone(), self.codex.get(&key).cloned());
        }
        entries.codex_prune_before = self.codex_prune_before.take();
        Some(UsageCacheWrite { compact_first, entries })
    }

    pub(crate) fn retry_with_compaction(&mut self) {
        self.compact_persisted = true;
    }

    fn mark_claude_dirty(&mut self, key: &str) {
        self.dirty_claude.insert(key.to_string());
    }

    fn mark_codex_dirty(&mut self, key: &str) {
        self.dirty_codex.insert(key.to_string());
    }

    /// 이 파일을 어떻게 읽을지. Reuse면 파일을 열지 않고, Tail이면 그 오프셋
    /// 이후만 읽는다.
    pub fn claude_plan(&self, path: &Path, now: FileStamp) -> ResumePlan {
        let Some(key) = path.to_str() else { return ResumePlan::Full };
        let Some(e) = self.claude.get(key) else { return ResumePlan::Full };
        // 지문이 같으면 앞부분을 읽을 이유조차 없다.
        if e.stamp == now {
            return ResumePlan::Reuse;
        }
        resume_plan(Some((e.resume, e.stamp)), now, head_fingerprint(path, e.resume))
    }

    /// Reuse 판정이 난 항목의 레코드.
    pub fn claude_cached(&self, path: &Path) -> Option<&[ClaudeRecord]> {
        Some(self.claude.get(path.to_str()?)?.records.as_slice())
    }

    pub fn put_claude(&mut self, path: &Path, stamp: FileStamp, resume: Resume, records: Vec<ClaudeRecord>) {
        if let Some(key) = path.to_str() {
            let records = compact_claude(records);
            self.claude.insert(
                key.to_string(),
                Arc::new(ClaudeEntry { stamp, resume, records }),
            );
            self.mark_claude_dirty(key);
        }
    }

    /// 꼬리에서 나온 레코드를 기존 항목에 이어 붙인다.
    pub fn append_claude(
        &mut self,
        path: &Path,
        stamp: FileStamp,
        resume: Resume,
        more: Vec<ClaudeRecord>,
    ) {
        let Some(key) = path.to_str() else { return };
        let Some(entry) = self.claude.get_mut(key) else {
            self.put_claude(path, stamp, resume, more);
            return;
        };
        Arc::make_mut(entry).append(stamp, resume, compact_claude(more));
        self.mark_claude_dirty(key);
    }


    pub fn codex_plan(&self, path: &Path, now: FileStamp) -> ResumePlan {
        let Some(key) = path.to_str() else { return ResumePlan::Full };
        let Some(e) = self.codex.get(key) else { return ResumePlan::Full };
        if e.stamp == now {
            return ResumePlan::Reuse;
        }
        resume_plan(Some((e.resume, e.stamp)), now, head_fingerprint(path, e.resume))
    }

    pub fn codex_recent_plan(
        &self,
        path: &Path,
        now: FileStamp,
        required_since: &str,
    ) -> ResumePlan {
        let Some(entry) = path.to_str().and_then(|key| self.codex.get(key)) else {
            return ResumePlan::Full;
        };
        if !entry
            .totals
            .recent_floor
            .as_deref()
            .is_some_and(|floor| floor <= required_since)
        {
            return ResumePlan::Full;
        }
        self.codex_plan(path, now)
    }

    pub fn codex_cached(&self, path: &Path) -> Option<&CodexFileTotals> {
        Some(&self.codex.get(path.to_str()?)?.totals)
    }

    pub fn put_codex(&mut self, path: &Path, stamp: FileStamp, resume: Resume, totals: CodexFileTotals) {
        if let Some(key) = path.to_str() {
            self.codex.insert(
                key.to_string(),
                Arc::new(CodexEntry { stamp, resume, totals }),
            );
            self.mark_codex_dirty(key);
        }
    }

    /// 꼬리 합계를 기존 항목에 더한다. Codex 집계는 덧셈이라 이어 붙이기가
    /// 성립한다 — rate limit만 '더 새 것'이 이긴다.
    pub fn merge_codex(&mut self, path: &Path, stamp: FileStamp, resume: Resume, more: CodexFileTotals) {
        let Some(key) = path.to_str() else { return };
        let Some(entry) = self.codex.get_mut(key) else {
            self.put_codex(path, stamp, resume, more);
            return;
        };
        Arc::make_mut(entry).merge(stamp, resume, more);
        self.mark_codex_dirty(key);
    }

    /// 정확한 5h/24h 창에 필요 없는 오래된 Codex 이벤트는 이미 존재하는
    /// 날짜 버킷(`days`)에만 남긴다. 최근 이벤트만 원시 시각으로 유지하므로
    /// 장수 세션 하나가 디스크 캐시를 끝없이 키우지 않는다.
    pub fn compact_codex_recent_before(&mut self, cutoff_iso: &str) {
        if self.prune_codex_recent(cutoff_iso) {
            self.codex_prune_before = Some(
                self.codex_prune_before
                    .as_deref()
                    .map_or(cutoff_iso.to_string(), |current| current.max(cutoff_iso).to_string()),
            );
        }
    }

    fn prune_codex_recent(&mut self, cutoff_iso: &str) -> bool {
        let mut changed = false;
        for entry in self.codex.values_mut() {
            let prune_recent = entry
                .totals
                .recent
                .iter()
                .any(|bucket| bucket.second.as_str() < cutoff_iso);
            let advance_floor = entry
                .totals
                .recent_floor
                .as_deref()
                .is_some_and(|floor| floor < cutoff_iso);
            if !prune_recent && !advance_floor {
                continue;
            }
            let entry = Arc::make_mut(entry);
            let before = entry.totals.recent.len();
            entry.totals.recent.retain(|bucket| bucket.second.as_str() >= cutoff_iso);
            if entry.totals.recent.len() != before {
                entry.totals.recent.shrink_to_fit();
                changed = true;
            }
            if let Some(floor) = &mut entry.totals.recent_floor {
                if floor.as_str() < cutoff_iso {
                    *floor = cutoff_iso.to_string();
                    changed = true;
                }
            }
        }
        changed
    }

    pub(crate) fn enforce_capacity(&mut self) -> bool {
        self.enforce_capacity_protecting(None)
    }

    fn enforce_capacity_protecting(&mut self, protected_codex: Option<&str>) -> bool {
        let mut changed = false;
        while self.claude.len() > MAX_CACHE_ENTRIES_PER_PROVIDER
            || self
                .claude
                .values()
                .map(|entry| entry.records.len())
                .sum::<usize>()
                > MAX_CLAUDE_RECORDS
        {
            let Some(key) = self
                .claude
                .iter()
                .min_by_key(|(_, entry)| entry.stamp.mtime)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.claude.remove(&key);
            self.mark_claude_dirty(&key);
            changed = true;
        }
        while self.codex.len() > MAX_CACHE_ENTRIES_PER_PROVIDER {
            let Some(key) = self
                .codex
                .iter()
                .filter(|(key, _)| protected_codex != Some(key.as_str()))
                .min_by_key(|(_, entry)| entry.stamp.mtime)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.codex.remove(&key);
            self.mark_codex_dirty(&key);
            changed = true;
        }
        loop {
            let retained = self
                .codex
                .values()
                .map(|entry| entry.totals.recent.len())
                .sum::<usize>();
            if retained <= MAX_CODEX_RECENT_BUCKETS {
                break;
            }
            let candidate = self
                .codex
                .iter()
                .filter(|(key, entry)| {
                    protected_codex != Some(key.as_str()) && !entry.totals.recent.is_empty()
                })
                .min_by_key(|(_, entry)| entry.stamp.mtime)
                .map(|(key, _)| key.clone())
                .or_else(|| {
                    self.codex
                        .iter()
                        .filter(|(_, entry)| !entry.totals.recent.is_empty())
                        .min_by_key(|(_, entry)| entry.stamp.mtime)
                        .map(|(key, _)| key.clone())
                });
            let Some(key) = candidate else {
                break;
            };
            if let Some(entry) = self.codex.get_mut(&key) {
                let entry = Arc::make_mut(entry);
                entry.totals.recent = Vec::new();
                entry.totals.recent_floor = None;
            }
            self.mark_codex_dirty(&key);
            changed = true;
        }
        changed
    }

    fn compact_claude_records(&mut self) {
        let mut changed = Vec::new();
        for (key, entry) in &mut self.claude {
            let entry = Arc::make_mut(entry);
            let before = entry.records.len();
            entry.records = compact_claude(std::mem::take(&mut entry.records));
            if entry.records.len() != before {
                changed.push(key.clone());
            }
        }
        for key in changed {
            self.mark_claude_dirty(&key);
        }
    }

    /// 이번 스캔에서 본 파일만 남긴다. 지우지 않으면 캐시가 삭제된 세션까지
    /// 영원히 안고 커진다.
    pub fn retain_seen(&mut self, claude_seen: &[PathBuf], codex_seen: &[PathBuf]) {
        let keep = |seen: &[PathBuf]| -> std::collections::HashSet<String> {
            seen.iter().filter_map(|p| p.to_str().map(String::from)).collect()
        };
        let c = keep(claude_seen);
        let x = keep(codex_seen);
        let removed_claude = self
            .claude
            .keys()
            .filter(|key| !c.contains(*key))
            .cloned()
            .collect::<Vec<_>>();
        let removed_codex = self
            .codex
            .keys()
            .filter(|key| !x.contains(*key))
            .cloned()
            .collect::<Vec<_>>();
        self.claude.retain(|k, _| c.contains(k));
        self.codex.retain(|k, _| x.contains(k));
        for key in removed_claude {
            self.mark_claude_dirty(&key);
        }
        for key in removed_codex {
            self.mark_codex_dirty(&key);
        }
    }

    fn apply_replacement(&mut self, replacement: UsageCacheReplacement) {
        for (key, entry) in replacement.claude {
            match entry {
                Some(entry) => {
                    self.claude.insert(key, entry);
                }
                None => {
                    self.claude.remove(&key);
                }
            }
        }
        for (key, entry) in replacement.codex {
            match entry {
                Some(entry) => {
                    self.codex.insert(key, entry);
                }
                None => {
                    self.codex.remove(&key);
                }
            }
        }
        if let Some(cutoff) = replacement.codex_prune_before {
            self.prune_codex_recent(&cutoff);
        }
        self.enforce_capacity();
    }
}

impl UsageCacheWrite {
    pub(crate) fn merge(self, newer: UsageCacheWrite) -> UsageCacheWrite {
        let mut entries = self.entries;
        entries.merge(newer.entries);
        UsageCacheWrite {
            compact_first: self.compact_first || newer.compact_first,
            entries,
        }
    }

    pub(crate) fn write(&mut self, home: &str) -> bool {
        let Some(_file_lock) = CacheFileLock::acquire(home) else { return false };
        if self.compact_first && !compact_persisted_cache_locked(home) {
            return false;
        }
        if !ensure_current_snapshot_locked(home) {
            return false;
        }
        self.entries.retain_current_file_generations();
        if self.entries.is_empty() || append_journal(home, &self.entries) {
            return true;
        }
        // A full/oversized journal record falls back to one bounded snapshot
        // merge against the latest persisted generation. Arc-backed entries
        // keep this path from cloning retained record graphs.
        self.entries.retain_current_file_generations();
        self.entries.is_empty() || compact_with_replacement_locked(home, &self.entries)
    }
}

struct BoundedWriter<W> {
    inner: W,
    remaining: u64,
}

impl<W> BoundedWriter<W> {
    fn new(inner: W, limit: u64) -> Self {
        Self { inner, remaining: limit }
    }
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            return Err(std::io::Error::new(
                std::io::ErrorKind::FileTooLarge,
                "usage cache exceeds its bounded persistence budget",
            ));
        }
        let written = self.inner.write(bytes)?;
        self.remaining -= written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn has_current_snapshot_header(path: &Path) -> bool {
    let expected = format!("{{\"version\":{CACHE_VERSION},");
    let Ok(metadata) = fs::metadata(path) else { return false };
    if metadata.len() > MAX_CACHE_FILE_BYTES || metadata.len() < expected.len() as u64 {
        return false;
    }
    let Ok(mut file) = fs::File::open(path) else { return false };
    let mut prefix = vec![0; expected.len()];
    file.read_exact(&mut prefix).is_ok() && prefix == expected.as_bytes()
}

fn read_current_snapshot(path: &Path) -> Option<UsageScanCache> {
    if !has_current_snapshot_header(path) {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let cache = serde_json::from_reader::<_, UsageScanCache>(BufReader::new(file)).ok()?;
    (cache.version == CACHE_VERSION).then_some(cache)
}

fn write_snapshot_atomic(home: &str, cache: &UsageScanCache) -> bool {
    let path = cache_path(home);
    let Some(dir) = path.parent() else { return false };
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let tmp = path.with_extension("json.tmp");
    let written = fs::File::create(&tmp).ok().is_some_and(|file| {
        let mut writer = BoundedWriter::new(BufWriter::new(file), MAX_CACHE_FILE_BYTES);
        serde_json::to_writer(&mut writer, cache).is_ok() && writer.flush().is_ok()
    });
    if !written {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    let journal = cache_journal_path(home);
    let retired = journal.with_extension("jsonl.retired");
    if retired.exists() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    if journal.exists() && fs::rename(&journal, &retired).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    if fs::rename(&tmp, &path).is_err() {
        if retired.exists() {
            let _ = fs::rename(&retired, &journal);
        }
        return false;
    }
    let _ = fs::remove_file(retired);
    true
}

fn recover_snapshot_transaction(home: &str) -> bool {
    let path = cache_path(home);
    let tmp = path.with_extension("json.tmp");
    let journal = cache_journal_path(home);
    let retired = journal.with_extension("jsonl.retired");
    if !retired.exists() {
        return true;
    }
    if journal.exists() {
        return false;
    }
    if tmp.exists() {
        let valid = read_current_snapshot(&tmp).is_some();
        if valid && fs::rename(&tmp, &path).is_ok() {
            return fs::remove_file(&retired).is_ok();
        }
        let _ = fs::remove_file(&tmp);
        return fs::rename(&retired, &journal).is_ok();
    }
    let valid = read_current_snapshot(&path).is_some();
    if valid {
        fs::remove_file(&retired).is_ok()
    } else {
        fs::rename(&retired, &journal).is_ok()
    }
}

fn append_journal(home: &str, replacement: &UsageCacheReplacement) -> bool {
    let path = cache_journal_path(home);
    let Some(dir) = path.parent() else { return false };
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let Ok(mut file) = OpenOptions::new().create(true).read(true).append(true).open(&path) else {
        return false;
    };
    let Some((before, remaining)) = journal_write_budget(file.metadata().map(|metadata| metadata.len()))
    else {
        return false;
    };
    if before > 0 {
        if file.seek(SeekFrom::End(-1)).is_err() {
            return false;
        }
        let mut tail = [0u8; 1];
        if file.read_exact(&mut tail).is_err() || tail[0] != b'\n' {
            return false;
        }
    }
    let appended = write_journal_record(
        &mut file,
        replacement,
        MAX_JOURNAL_RECORD_BYTES.min(remaining),
    );
    if !appended {
        let _ = file.set_len(before);
        return false;
    }
    true
}

fn write_journal_record(
    sink: impl Write,
    replacement: &UsageCacheReplacement,
    limit: u64,
) -> bool {
    let mut writer = BoundedWriter::new(
        BufWriter::with_capacity(JOURNAL_WRITE_BUFFER_BYTES, sink),
        limit,
    );
    serde_json::to_writer(&mut writer, replacement).is_ok()
        && writer.write_all(b"\n").is_ok()
        && writer.flush().is_ok()
}

fn journal_write_budget(observed_len: std::io::Result<u64>) -> Option<(u64, u64)> {
    let before = observed_len.ok()?;
    let remaining = MAX_CACHE_JOURNAL_BYTES.saturating_sub(before);
    (remaining > 0).then_some((before, remaining))
}

fn replay_journal(home: &str, cache: &mut UsageScanCache) -> bool {
    let path = cache_journal_path(home);
    let Ok(metadata) = fs::metadata(&path) else {
        return true;
    };
    if metadata.len() > MAX_CACHE_JOURNAL_BYTES {
        return false;
    }
    let Ok(file) = fs::File::open(path) else { return false };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let Ok(read) = reader.read_line(&mut line) else { return false };
        if read == 0 {
            return true;
        }
        if !line.ends_with('\n') {
            return false;
        }
        if line.len() as u64 > MAX_JOURNAL_RECORD_BYTES {
            return false;
        }
        let Ok(replacement) = serde_json::from_str::<UsageCacheReplacement>(line.trim_end()) else {
            return false;
        };
        if replacement.version != JOURNAL_VERSION {
            return false;
        }
        cache.apply_replacement(replacement);
    }
}

/// Claude는 한 assistant message를 streaming 중 여러 번 기록한다. 같은
/// message.id의 마지막 레코드만 합산하는 기존 규칙을 파일 캐시에도 적용하면
/// 숫자는 그대로이면서 반복 레코드를 절반가량 줄일 수 있다. id가 없는 레코드는
/// 서로 다른 메시지일 수 있으므로 절대 합치지 않는다.
fn compact_claude(records: Vec<ClaudeRecord>) -> Vec<ClaudeRecord> {
    let mut anonymous = Vec::new();
    let mut by_id = BTreeMap::new();
    for record in records {
        match record.id.clone() {
            Some(id) => {
                by_id.insert(id, record);
            }
            None => anonymous.push(record),
        }
    }
    anonymous.extend(by_id.into_values());
    anonymous
}

/// 앞부분 지문에 쓸 길이. 이어 붙이기 전 "같은 파일이 맞는지"만 보므로
/// 암호학적 강도가 필요 없고, 수백 MB 파일에서도 4KB만 읽으면 된다.
const HEAD_LEN: u64 = 4096;

/// 이 재개 지점에 대응하는 지문 길이.
///
/// **고정 길이여야 한다.** 처음엔 "읽을 수 있는 만큼"을 해싱했는데, 그러면
/// 4KB보다 작은 파일은 한 줄만 덧붙어도 지문이 달라져 꼬리 읽기가 영영
/// 안 걸린다(테스트가 잡았다). 이미 파싱한 구간 안에서 고정 길이를 잡으면
/// append로는 절대 변하지 않는다.
fn head_len_for(parsed_bytes: u64) -> u64 {
    parsed_bytes.min(HEAD_LEN)
}

/// 파일 앞 `len` 바이트의 지문. 파일이 그보다 짧으면 0 — 호출자는 전체
/// 재파싱으로 폴백한다(짧아졌다는 것 자체가 절단 신호다).
pub fn head_fingerprint_of(path: &Path, len: u64) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::io::Read;

    if len == 0 {
        return 0;
    }
    let Ok(mut file) = fs::File::open(path) else { return 0 };
    let mut buf = vec![0u8; len as usize];
    let mut filled = 0usize;
    // read는 짧게 돌려줄 수 있다 — 요청한 길이를 채우거나 EOF일 때까지 읽는다.
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => return 0, // 요청 길이에 못 미친다 = 짧아졌다
            Ok(n) => filled += n,
            Err(_) => return 0,
        }
    }
    let mut hasher = DefaultHasher::new();
    buf.hash(&mut hasher);
    hasher.finish()
}

/// 이 재개 지점을 검증할 때 쓸 지문.
pub fn head_fingerprint(path: &Path, resume: Resume) -> u64 {
    head_fingerprint_of(path, head_len_for(resume.parsed_bytes))
}

/// 새로 기록할 재개 지점 — 오프셋과 그에 맞는 지문을 함께 만든다.
pub fn resume_at(path: &Path, parsed_bytes: u64) -> Resume {
    Resume {
        parsed_bytes,
        head: head_fingerprint_of(path, head_len_for(parsed_bytes)),
    }
}

/// 줄 단위로 읽어 `marker`가 든 줄만 넘긴다.
///
/// read_to_string은 파일 하나를 통째로 메모리에 올린다 — Codex 세션 로그는
/// 수백 MB짜리도 있어서 그 자체로 문제였다. BufReader는 줄 하나씩만 든다.
/// UTF-8이 깨진 줄은 건너뛴다(read_to_string이면 파일 전체를 잃었다).
pub fn for_each_marked_line<F>(path: &Path, marker: &str, f: F)
where
    F: FnMut(&str),
{
    let _ = for_each_marked_line_from(path, 0, marker, f);
}

/// `from` 바이트부터 읽어 `marker`가 든 줄만 넘기고, **마지막 완결 줄 다음**
/// 오프셋을 돌려준다.
///
/// 반환값이 파일 크기가 아니라 개행 기준인 것이 핵심이다. 로그는 쓰이는
/// 도중에도 읽히므로 마지막 줄이 잘려 있을 수 있고, 거기까지 읽었다고
/// 기록하면 다음 스캔이 남은 반쪽을 새 줄로 오해해 레코드를 잃는다.
///
/// 개행으로 끝나지 않은 마지막 줄은 **레코드로 세지 않는다.** 세면서 오프셋을
/// 전진시키지 않으면 다음 스캔이 같은 줄을 또 센다 — Codex는 합산이라 그대로
/// 이중 계상이 된다. 반대로 전진시키면 쓰는 중이던 줄의 나머지를 잃는다.
/// 둘 다 틀리므로 완결될 때까지 기다린다. 기록기가 `{...}\n`을 한 번에 쓰므로
/// 다음 스캔이면 잡힌다.
pub fn for_each_marked_line_from<F>(path: &Path, from: u64, marker: &str, mut f: F) -> u64
where
    F: FnMut(&str),
{
    use std::io::{Seek, SeekFrom};

    let Ok(mut file) = fs::File::open(path) else { return from };
    if from > 0 && file.seek(SeekFrom::Start(from)).is_err() {
        return from;
    }

    let mut reader = BufReader::new(&mut file);
    let mut consumed = from;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        // 개행으로 끝나지 않았으면 아직 쓰이는 중인 꼬리다 — 인정하지 않는다.
        if !buf.ends_with(b"\n") {
            break;
        }
        consumed += n as u64;
        // UTF-8이 깨진 줄은 그 줄만 버린다. 오프셋은 이미 전진했으므로
        // 다음 스캔이 같은 줄을 다시 시도하지 않는다.
        if let Ok(line) = std::str::from_utf8(&buf[..n - 1]) {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.contains(marker) {
                f(line);
            }
        }
    }
    consumed
}

/// mtime이 window 안에 드는 .jsonl 파일 목록 (재귀). usage.rs에서 옮겨왔다 —
/// 캐시가 같은 목록을 필요로 한다.
pub fn recent_jsonl(dir: &Path, since: SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            recent_jsonl(&p, since, out);
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            if let Ok(meta) = p.metadata() {
                if meta.modified().map(|m| m >= since).unwrap_or(false) {
                    out.push(p);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct CountingWriter {
        writes: usize,
        bytes: usize,
    }

    impl Write for CountingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.writes += 1;
            self.bytes += bytes.len();
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn recent_events_in_the_same_minute_share_one_bucket() {
        // Per-second buckets made bucket count proportional to event count:
        // one live 43k-turns/day rollout alone approached
        // MAX_CODEX_RECENT_BUCKETS, and capacity eviction then erased that
        // file's recent_floor, forcing a full re-parse of the multi-hundred-MB
        // file on every scan (2026-08-24 live daily driver: a self-sustaining
        // ~876MB disk-read loop). Minute buckets bound the count by time
        // (2,880 per file per 48h), not by activity.
        let mut totals = CodexFileTotals::default();
        totals.absorb_recent("2026-08-24T10:15:03Z", 1, 2, 0);
        totals.absorb_recent("2026-08-24T10:15:59Z", 10, 20, 1);
        totals.absorb_recent("2026-08-24T10:16:00Z", 100, 0, 0);
        assert_eq!(
            totals
                .recent
                .iter()
                .map(|bucket| (bucket.second.as_str(), bucket.input, bucket.output, bucket.turns))
                .collect::<Vec<_>>(),
            vec![
                ("2026-08-24T10:15:00", 11, 22, 2),
                ("2026-08-24T10:16:00", 100, 0, 1),
            ],
        );
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hebbian-usage-cache-{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn append_fixture(path: &Path, bytes: &[u8]) -> (FileStamp, Resume) {
        let mut file = OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(bytes).unwrap();
        file.flush().unwrap();
        let stamp = FileStamp::of(path).unwrap();
        (stamp, resume_at(path, stamp.size))
    }

    #[test]
    fn stamp_changes_when_the_file_grows() {
        let dir = tmpdir("stamp");
        let f = dir.join("a.jsonl");
        fs::write(&f, "one\n").unwrap();
        let before = FileStamp::of(&f).unwrap();
        fs::write(&f, "one\ntwo\n").unwrap();
        let after = FileStamp::of(&f).unwrap();
        assert_ne!(before, after, "append-only 로그가 자라면 지문이 달라져야 한다");
    }

    #[test]
    fn cache_returns_nothing_for_a_changed_file() {
        let dir = tmpdir("changed");
        let f = dir.join("a.jsonl");
        fs::write(&f, "one\n").unwrap();
        let stamp = FileStamp::of(&f).unwrap();
        let mut cache = UsageScanCache::empty();
        cache.put_claude(
            &f,
            stamp,
            resume_at(&f, 4),
            vec![ClaudeRecord { input: 5, ..Default::default() }],
        );

        assert_eq!(cache.claude_plan(&f, stamp), ResumePlan::Reuse);

        fs::write(&f, "one\ntwo\n").unwrap();
        let grown = FileStamp::of(&f).unwrap();
        assert_eq!(
            cache.claude_plan(&f, grown),
            ResumePlan::Tail(4),
            "자란 파일은 이미 읽은 곳부터 이어 읽어야 한다"
        );
    }

    #[test]
    fn a_corrupt_cache_file_is_discarded_not_fatal() {
        let home = tmpdir("corrupt");
        fs::create_dir_all(home.join(".dure")).unwrap();
        fs::write(cache_path(home.to_str().unwrap()), "{ not json").unwrap();
        let cache = UsageScanCache::load(home.to_str().unwrap());
        assert!(cache.claude.is_empty() && cache.codex.is_empty());
    }

    #[test]
    fn cache_file_lock_excludes_a_second_process_generation() {
        let home = tmpdir("file-lock");
        let _owner = CacheFileLock::acquire(home.to_str().unwrap()).unwrap();
        let contender = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(cache_lock_path(home.to_str().unwrap()))
            .unwrap();

        assert!(FileExt::try_lock_exclusive(&contender).is_err());
    }

    #[test]
    fn a_stale_version_is_discarded() {
        let home = tmpdir("version");
        fs::create_dir_all(home.join(".dure")).unwrap();
        // 옛 형식: version이 다르면 통째로 버려야 한다.
        fs::write(
            cache_path(home.to_str().unwrap()),
            r#"{"version":0,"claude":{"/x":{"stamp":{"mtime":1,"size":1},"records":[]}},"codex":{}}"#,
        )
        .unwrap();
        assert!(UsageScanCache::load(home.to_str().unwrap()).claude.is_empty());
    }

    #[test]
    fn retired_schema_is_skipped_and_replaced_without_deserializing_it() {
        let home = tmpdir("version-two");
        fs::create_dir_all(home.join(".dure")).unwrap();
        let old = r#"{"version":2,"claude":{"/x":{"stamp":{"mtime":1,"size":2},"resume":{"parsed_bytes":2,"head":3},"records":[{"id":"msg","input":4,"output":5,"cache_read":6,"cache_write":7,"ts":"2026-08-06T00:00:00Z"}]}},"codex":{}}"#;
        fs::write(cache_path(home.to_str().unwrap()), old).unwrap();

        let mut cache = UsageScanCache::load(home.to_str().unwrap());

        assert!(cache.claude.is_empty() && cache.codex.is_empty());
        let mut write =
            cache.take_write().expect("schema migration must schedule one compact rewrite");
        assert!(write.compact_first);
        assert!(write.write(home.to_str().unwrap()));
        let compact = fs::read_to_string(cache_path(home.to_str().unwrap())).unwrap();
        assert!(compact.starts_with("{\"version\":5,"));
        assert!(!compact.contains("msg"));
    }

    #[test]
    fn legacy_unversioned_cache_is_never_opened_or_mutated() {
        let home = tmpdir("legacy-path-isolation");
        let app_root = crate::app_home::app_root_under(&home);
        fs::create_dir_all(&app_root).unwrap();
        let legacy = app_root.join("usage-scan-cache.json");
        let file = fs::File::create(&legacy).unwrap();
        file.set_len(MAX_CACHE_FILE_BYTES + 1).unwrap();
        let legacy_size = fs::metadata(&legacy).unwrap().len();

        let mut cache = UsageScanCache::load(home.to_str().unwrap());

        assert!(cache.claude.is_empty() && cache.codex.is_empty());
        assert_eq!(fs::metadata(&legacy).unwrap().len(), legacy_size);
        assert!(!cache_path(home.to_str().unwrap()).exists());
        let mut write = cache.take_write().unwrap();
        assert!(write.write(home.to_str().unwrap()));
        assert!(cache_path(home.to_str().unwrap()).exists());
        assert_eq!(fs::metadata(legacy).unwrap().len(), legacy_size);
    }

    #[test]
    fn oversized_snapshot_is_rejected_by_metadata_and_atomically_replaced() {
        let home = tmpdir("oversized");
        fs::create_dir_all(home.join(".dure")).unwrap();
        let path = cache_path(home.to_str().unwrap());
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_CACHE_FILE_BYTES + 1).unwrap();

        let mut cache = UsageScanCache::load(home.to_str().unwrap());

        assert!(cache.claude.is_empty() && cache.codex.is_empty());
        let mut write = cache.take_write().expect("oversized snapshot must be retired");
        assert!(write.write(home.to_str().unwrap()));
        assert!(fs::metadata(&path).unwrap().len() < MAX_CACHE_FILE_BYTES);
        assert!(fs::read_to_string(path).unwrap().starts_with("{\"version\":5,"));
    }

    #[test]
    fn round_trips_through_disk() {
        let home = tmpdir("roundtrip");
        let f = home.join("s.jsonl");
        fs::write(&f, "x\n").unwrap();
        let stamp = FileStamp::of(&f).unwrap();
        let mut cache = UsageScanCache::empty();
        cache.put_claude(
            &f,
            stamp,
            resume_at(&f, 2),
            vec![ClaudeRecord {
                id: Some("msg_1".into()),
                input: 1,
                output: 2,
                cache_read: 3,
                cache_write: 4,
                ts: "2026-07-30T01:02:03".into(),
            }],
        );
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &cache));

        let again = UsageScanCache::load(home.to_str().unwrap());
        assert_eq!(again.claude_plan(&f, stamp), ResumePlan::Reuse);
        let records = again.claude_cached(&f).expect("저장한 항목이 살아 있어야 한다");
        assert_eq!(records[0].id.as_deref(), Some("msg_1"));
        assert_eq!(records[0].cache_write, 4);
    }

    #[test]
    fn retain_seen_drops_files_that_left_the_window() {
        let dir = tmpdir("retain");
        let keep = dir.join("keep.jsonl");
        let gone = dir.join("gone.jsonl");
        fs::write(&keep, "a\n").unwrap();
        fs::write(&gone, "a\n").unwrap();
        let mut cache = UsageScanCache::empty();
        cache.put_claude(&keep, FileStamp::of(&keep).unwrap(), Resume::default(), vec![]);
        cache.put_claude(&gone, FileStamp::of(&gone).unwrap(), Resume::default(), vec![]);

        cache.retain_seen(std::slice::from_ref(&keep), &[]);

        assert!(cache.claude.contains_key(keep.to_str().unwrap()));
        assert!(
            !cache.claude.contains_key(gone.to_str().unwrap()),
            "창을 벗어난 파일을 안고 있으면 캐시가 무한히 커진다"
        );
    }

    #[test]
    fn claude_cache_keeps_only_the_last_streaming_record_per_message() {
        let dir = tmpdir("claude-compact");
        let f = dir.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut cache = UsageScanCache::empty();
        cache.put_claude(
            &f,
            FileStamp::of(&f).unwrap(),
            Resume::default(),
            vec![
                ClaudeRecord { id: Some("msg-1".into()), input: 1, ..Default::default() },
                ClaudeRecord { id: Some("msg-1".into()), input: 9, ..Default::default() },
                ClaudeRecord { id: None, input: 2, ..Default::default() },
                ClaudeRecord { id: None, input: 3, ..Default::default() },
            ],
        );

        let records = cache.claude_cached(&f).unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(records.iter().find(|record| record.id.is_some()).unwrap().input, 9);
        assert_eq!(records.iter().filter(|record| record.id.is_none()).count(), 2);
    }

    #[test]
    fn old_codex_buckets_compact_into_existing_day_buckets() {
        let dir = tmpdir("codex-compact");
        let f = dir.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut totals = CodexFileTotals::default();
        totals.days.entry("2026-08-01".into()).or_default().absorb(1, 2, 0);
        totals.recent_floor = Some("2026-08-01T00:00:00".into());
        totals.absorb_recent("2026-08-01T00:00:00Z", 1, 0, 0);
        totals.absorb_recent("2026-08-05T00:00:00Z", 2, 0, 0);
        let mut cache = UsageScanCache::empty();
        cache.put_codex(
            &f,
            FileStamp::of(&f).unwrap(),
            Resume::default(),
            totals,
        );

        cache.compact_codex_recent_before("2026-08-04T00:00:00");

        let totals = cache.codex_cached(&f).unwrap();
        assert_eq!(totals.recent.len(), 1);
        assert_eq!(totals.recent[0].input, 2);
        assert_eq!(totals.recent_floor.as_deref(), Some("2026-08-04T00:00:00"));
        assert_eq!(totals.days["2026-08-01"].input, 1);
    }

    #[test]
    fn codex_cache_retention_and_snapshot_cost_are_bounded_by_time_not_event_count() {
        fn measured(event_count: usize) -> (usize, usize, usize) {
            let dir = tmpdir(&format!("codex-bounded-{event_count}"));
            let file = dir.join("a.jsonl");
            fs::write(&file, "x\n").unwrap();
            let mut totals = CodexFileTotals {
                recent_floor: Some("2026-08-04T00:00:00".into()),
                ..Default::default()
            };
            for input in 0..event_count {
                totals.absorb_recent(
                    "2026-08-06T00:00:00.000Z",
                    input as u64,
                    0,
                    0,
                );
            }
            let mut cache = UsageScanCache::empty();
            cache.put_codex(
                &file,
                FileStamp { mtime: 1, size: 1 },
                Resume { parsed_bytes: 1, head: 7 },
                totals,
            );
            cache.compact_persisted = true;
            let retained = cache.codex_cached(&file).unwrap().recent.len();
            let resident_bytes = serde_json::to_vec(&cache).unwrap().len();
            let write = cache.take_write().expect("new cache entry must be persisted");
            let cloned_records = write
                .entries
                .codex
                .values()
                .flatten()
                .map(|entry| entry.totals.recent.len())
                .sum();
            (retained, resident_bytes, cloned_records)
        }

        let n = measured(4_096);
        let twice_n = measured(8_192);
        eprintln!("N={n:?}, 2N={twice_n:?}");

        assert!(
            twice_n.0 <= n.0 + 1,
            "same-second events must collapse instead of doubling retained records"
        );
        assert!(
            twice_n.1 <= n.1 + 4_096,
            "serialized cache bytes must be bounded by time buckets, not event count"
        );
        assert!(
            twice_n.2 <= n.2 + 1,
            "replacement write cost must stay bounded by retained buckets"
        );
    }

    #[test]
    fn codex_pruning_journals_one_cutoff_instead_of_full_entries() {
        let home = tmpdir("codex-prune-journal");
        let f = home.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut totals = CodexFileTotals {
            recent_floor: Some("2026-08-01T00:00:00".into()),
            ..Default::default()
        };
        totals.absorb_recent("2026-08-01T00:00:00Z", 1, 0, 0);
        totals.absorb_recent("2026-08-06T00:00:00Z", 7, 0, 0);
        let mut cache = UsageScanCache::empty();
        cache.put_codex(
            &f,
            FileStamp { mtime: 1, size: 1 },
            Resume { parsed_bytes: 1, head: 7 },
            totals,
        );
        let _ = cache.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &cache));

        let mut tail = CodexFileTotals {
            recent_floor: Some("2026-08-04T00:00:00".into()),
            ..Default::default()
        };
        tail.absorb_recent("2026-08-06T01:00:00Z", 9, 0, 0);
        let (stamp, resume) = append_fixture(&f, b"tail\n");
        cache.merge_codex(&f, stamp, resume, tail);
        cache.compact_codex_recent_before("2026-08-04T00:00:00");
        let mut write = cache.take_write().unwrap();
        assert!(write.write(home.to_str().unwrap()));

        assert!(fs::metadata(cache_journal_path(home.to_str().unwrap())).unwrap().len() < 1024);
        let loaded = UsageScanCache::load(home.to_str().unwrap());
        let recent = &loaded.codex_cached(&f).unwrap().recent;
        assert_eq!(recent.iter().map(|bucket| bucket.input).collect::<Vec<_>>(), [7, 9]);
    }

    #[test]
    fn changed_entries_are_consumed_once() {
        let dir = tmpdir("dirty");
        let f = dir.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut cache = UsageScanCache::empty();
        assert!(cache.take_write().is_none());

        cache.put_claude(&f, FileStamp::of(&f).unwrap(), Resume::default(), Vec::new());

        assert!(cache.take_write().is_some());
        assert!(cache.take_write().is_none(), "unchanged warm reads must not schedule another flush");
    }

    #[test]
    fn changed_entry_appends_a_small_journal_without_rewriting_the_snapshot() {
        let home = tmpdir("journal-replacement");
        let f = home.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut cache = UsageScanCache::empty();
        cache.put_claude(
            &f,
            FileStamp::of(&f).unwrap(),
            Resume::default(),
            vec![ClaudeRecord { input: 1, ..Default::default() }],
        );
        let _ = cache.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &cache));
        let snapshot = fs::read(cache_path(home.to_str().unwrap())).unwrap();

        cache.put_claude(
            &f,
            FileStamp::of(&f).unwrap(),
            Resume::default(),
            vec![ClaudeRecord { input: 9, ..Default::default() }],
        );
        let mut write = cache.take_write().expect("changed entry must be persisted");
        assert!(write.write(home.to_str().unwrap()));

        assert_eq!(fs::read(cache_path(home.to_str().unwrap())).unwrap(), snapshot);
        assert!(fs::metadata(cache_journal_path(home.to_str().unwrap())).unwrap().len() < 1024);
        let loaded = UsageScanCache::load(home.to_str().unwrap());
        assert_eq!(loaded.claude_cached(&f).unwrap()[0].input, 9);
    }

    #[test]
    fn active_codex_file_persists_one_bounded_replacement_generation() {
        let home = tmpdir("journal-codex-tail");
        let f = home.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut totals = CodexFileTotals {
            recent_floor: Some("2026-08-04T00:00:00".into()),
            ..Default::default()
        };
        for index in 0..2_000 {
            totals.absorb_recent(
                &format!("2026-08-06T00:{:02}:00Z", index % 60),
                index,
                0,
                0,
            );
        }
        let mut cache = UsageScanCache::empty();
        cache.put_codex(
            &f,
            FileStamp { mtime: 1, size: 1 },
            Resume { parsed_bytes: 1, head: 7 },
            totals,
        );
        let _ = cache.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &cache));

        let mut tail = CodexFileTotals {
            recent_floor: Some("2026-08-04T00:00:00".into()),
            ..Default::default()
        };
        tail.absorb_recent("2026-08-06T01:00:00Z", 9, 0, 0);
        let (stamp, resume) = append_fixture(&f, b"tail\n");
        cache.merge_codex(&f, stamp, resume, tail);
        assert!(cache.take_write().unwrap().write(home.to_str().unwrap()));

        assert!(
            fs::metadata(cache_journal_path(home.to_str().unwrap())).unwrap().len()
                < MAX_JOURNAL_RECORD_BYTES
        );
        let loaded = UsageScanCache::load(home.to_str().unwrap());
        let loaded = loaded.codex_cached(&f).unwrap();
        assert_eq!(loaded.recent.len(), 61);
        assert_eq!(loaded.recent.last().unwrap().input, 9);
    }

    #[test]
    fn coalesced_replacements_keep_the_newest_entry() {
        let home = tmpdir("journal-coalesced-newest");
        let f = home.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut cache = UsageScanCache::empty();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &cache));
        cache.put_claude(
            &f,
            FileStamp::of(&f).unwrap(),
            Resume::default(),
            vec![ClaudeRecord { input: 1, ..Default::default() }],
        );
        let older = cache.take_write().unwrap();
        cache.put_claude(
            &f,
            FileStamp::of(&f).unwrap(),
            Resume::default(),
            vec![ClaudeRecord { input: 9, ..Default::default() }],
        );
        let newer = cache.take_write().unwrap();

        assert!(older.merge(newer).write(home.to_str().unwrap()));

        let loaded = UsageScanCache::load(home.to_str().unwrap());
        assert_eq!(loaded.claude_cached(&f).unwrap()[0].input, 9);
    }

    #[test]
    fn coalesced_codex_tails_replay_each_record_once() {
        let home = tmpdir("journal-coalesced-tails");
        let f = home.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut cache = UsageScanCache::empty();
        cache.put_codex(
            &f,
            FileStamp { mtime: 1, size: 1 },
            Resume { parsed_bytes: 1, head: 7 },
            CodexFileTotals {
                recent_floor: Some("2026-08-04T00:00:00".into()),
                ..Default::default()
            },
        );
        let _ = cache.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &cache));

        let writes = [3, 5].map(|input| {
            let mut tail = CodexFileTotals {
                recent_floor: Some("2026-08-04T00:00:00".into()),
                ..Default::default()
            };
            tail.absorb_recent(&format!("2026-08-06T00:0{input}:00Z"), input, 0, 0);
            let (stamp, resume) = append_fixture(&f, b"tail\n");
            cache.merge_codex(&f, stamp, resume, tail);
            cache.take_write().unwrap()
        });
        let mut write = writes.into_iter().reduce(UsageCacheWrite::merge).unwrap();
        assert!(write.write(home.to_str().unwrap()));

        let loaded = UsageScanCache::load(home.to_str().unwrap());
        let recent = &loaded.codex_cached(&f).unwrap().recent;
        assert_eq!(recent.iter().map(|bucket| bucket.input).collect::<Vec<_>>(), [3, 5]);
    }

    #[test]
    fn stale_processes_cannot_persist_the_same_codex_tail_twice() {
        let home = tmpdir("journal-stale-process-tail");
        let file = home.join("a.jsonl");
        fs::write(&file, "x\n").unwrap();
        let mut base = UsageScanCache::empty();
        let mut totals = CodexFileTotals {
            recent_floor: Some("2026-08-04T00:00:00".into()),
            ..Default::default()
        };
        totals.absorb_recent("2026-08-06T00:00:00Z", 1, 0, 0);
        base.put_codex(
            &file,
            FileStamp { mtime: 1, size: 1 },
            Resume { parsed_bytes: 1, head: 7 },
            totals,
        );
        let _ = base.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &base));

        let mut first = UsageScanCache::load(home.to_str().unwrap());
        let mut second = UsageScanCache::load(home.to_str().unwrap());
        let (stamp, resume) = append_fixture(&file, b"tail\n");
        for cache in [&mut first, &mut second] {
            let mut tail = CodexFileTotals {
                recent_floor: Some("2026-08-04T00:00:00".into()),
                ..Default::default()
            };
            tail.absorb_recent("2026-08-06T00:01:00Z", 7, 0, 0);
            cache.merge_codex(&file, stamp, resume, tail);
        }
        assert!(first.take_write().unwrap().write(home.to_str().unwrap()));
        assert!(second.take_write().unwrap().write(home.to_str().unwrap()));

        let loaded = UsageScanCache::load(home.to_str().unwrap());
        assert_eq!(
            loaded
                .codex_cached(&file)
                .unwrap()
                .recent
                .iter()
                .map(|bucket| bucket.input)
                .collect::<Vec<_>>(),
            [1, 7],
            "the persisted tail is a replacement generation, not an additive replay",
        );
    }

    #[test]
    fn stale_processes_cannot_persist_the_same_anonymous_claude_tail_twice() {
        let home = tmpdir("journal-stale-claude-tail");
        let file = home.join("a.jsonl");
        fs::write(&file, "x\n").unwrap();
        let mut base = UsageScanCache::empty();
        base.put_claude(
            &file,
            FileStamp { mtime: 1, size: 1 },
            Resume { parsed_bytes: 1, head: 7 },
            vec![ClaudeRecord { input: 1, ..Default::default() }],
        );
        let _ = base.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &base));

        let mut first = UsageScanCache::load(home.to_str().unwrap());
        let mut second = UsageScanCache::load(home.to_str().unwrap());
        let (stamp, resume) = append_fixture(&file, b"tail\n");
        for cache in [&mut first, &mut second] {
            cache.append_claude(
                &file,
                stamp,
                resume,
                vec![ClaudeRecord { input: 7, ..Default::default() }],
            );
        }
        assert!(first.take_write().unwrap().write(home.to_str().unwrap()));
        assert!(second.take_write().unwrap().write(home.to_str().unwrap()));

        assert_eq!(
            UsageScanCache::load(home.to_str().unwrap())
                .claude_cached(&file)
                .unwrap()
                .iter()
                .map(|record| record.input)
                .collect::<Vec<_>>(),
            [1, 7],
        );
    }

    #[test]
    fn near_cap_journal_compacts_before_replacement_without_exceeding_hard_limit() {
        let home = tmpdir("journal-hard-cap");
        let file = home.join("a.jsonl");
        fs::write(&file, "x\n").unwrap();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &UsageScanCache::empty()));
        let journal = cache_journal_path(home.to_str().unwrap());
        let mut padded = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&journal)
            .unwrap();
        padded.set_len(MAX_CACHE_JOURNAL_BYTES - 1).unwrap();
        padded.seek(SeekFrom::End(-1)).unwrap();
        padded.write_all(b"\n").unwrap();
        padded.flush().unwrap();

        let mut cache = UsageScanCache::empty();
        cache.put_claude(
            &file,
            FileStamp::of(&file).unwrap(),
            resume_at(&file, 2),
            vec![ClaudeRecord { input: 7, ..Default::default() }],
        );
        let mut write = cache.take_write().unwrap();

        assert!(write.write(home.to_str().unwrap()));
        assert!(
            fs::metadata(&journal)
                .map(|metadata| metadata.len() <= MAX_CACHE_JOURNAL_BYTES)
                .unwrap_or(true)
        );
        assert_eq!(
            UsageScanCache::load(home.to_str().unwrap())
                .claude_cached(&file)
                .unwrap()[0]
                .input,
            7,
        );
    }

    #[test]
    fn unknown_journal_length_never_authorizes_an_append() {
        assert_eq!(
            journal_write_budget(Err(std::io::Error::other("injected fstat failure"))),
            None,
        );
    }

    #[test]
    fn journal_serialization_coalesces_small_json_fragments() {
        let totals = CodexFileTotals {
            recent: (0..10_000)
                .map(|index| CodexTimeBucket {
                    second: format!(
                        "2026-08-30T{:02}:{:02}:00",
                        (index / 60) % 24,
                        index % 60,
                    ),
                    input: index,
                    turns: 1,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        let mut replacement = UsageCacheReplacement {
            version: JOURNAL_VERSION,
            ..Default::default()
        };
        replacement.codex.insert(
            "/tmp/codex-session.jsonl".into(),
            Some(Arc::new(CodexEntry {
                stamp: FileStamp::default(),
                resume: Resume::default(),
                totals,
            })),
        );
        let mut sink = CountingWriter::default();

        assert!(write_journal_record(
            &mut sink,
            &replacement,
            MAX_JOURNAL_RECORD_BYTES,
        ));
        assert!(
            sink.bytes > 256 * 1024,
            "fixture must model a large live replacement",
        );
        assert!(
            sink.writes <= sink.bytes.div_ceil(4 * 1024),
            "journal JSON used {} writes for {} bytes",
            sink.writes,
            sink.bytes,
        );
    }

    #[test]
    fn oversized_entry_replacement_compacts_without_cloning_its_record_graph() {
        let home = tmpdir("oversized-entry-replacement");
        let file = home.join("a.jsonl");
        fs::write(&file, "x\n").unwrap();
        let stamp = FileStamp::of(&file).unwrap();
        let mut totals = CodexFileTotals {
            recent_floor: Some("0000000000000000000".into()),
            recent: (0..50_000)
                .map(|index| CodexTimeBucket {
                    second: format!("{index:019}"),
                    input: 1,
                    turns: 1,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        let mut base = UsageScanCache::empty();
        base.put_codex(&file, stamp, resume_at(&file, stamp.size), totals.clone());
        let _ = base.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &base));

        let mut cache = UsageScanCache::load(home.to_str().unwrap());
        let (stamp, resume) = append_fixture(&file, b"tail\n");
        totals = CodexFileTotals {
            recent_floor: Some("0000000000000000000".into()),
            ..Default::default()
        };
        totals.absorb_recent("9999999999999999999", 9, 0, 0);
        cache.merge_codex(&file, stamp, resume, totals);
        let retained = Arc::clone(cache.codex.get(file.to_str().unwrap()).unwrap());
        let mut write = cache.take_write().unwrap();
        let replacement = write
            .entries
            .codex
            .get(file.to_str().unwrap())
            .unwrap()
            .as_ref()
            .unwrap();
        assert!(Arc::ptr_eq(&retained, replacement));
        drop(retained);
        cache.compact_codex_recent_before("0000000000000000000");
        assert!(
            Arc::ptr_eq(
                cache.codex.get(file.to_str().unwrap()).unwrap(),
                replacement,
            ),
            "an unchanged warm poll must not clone a shared entry graph",
        );
        assert!(serde_json::to_vec(&write.entries).unwrap().len() as u64 > MAX_JOURNAL_RECORD_BYTES);

        assert!(write.write(home.to_str().unwrap()));
        assert!(!cache_journal_path(home.to_str().unwrap()).exists());
        let loaded = UsageScanCache::load(home.to_str().unwrap());
        let recent = &loaded.codex_cached(&file).unwrap().recent;
        assert_eq!(recent.len(), 50_001);
        assert_eq!(recent.last().unwrap().input, 9);
    }

    #[test]
    fn stale_tombstone_cannot_delete_a_recreated_file_generation() {
        let home = tmpdir("stale-tombstone-recreate");
        let file = home.join("a.jsonl");
        fs::write(&file, "old\n").unwrap();
        let mut base = UsageScanCache::empty();
        let mut base_totals = CodexFileTotals::default();
        base_totals.absorb_recent("2026-08-06T00:00:00Z", 1, 0, 0);
        let stamp = FileStamp::of(&file).unwrap();
        base.put_codex(&file, stamp, resume_at(&file, stamp.size), base_totals);
        let _ = base.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &base));

        let mut stale = UsageScanCache::load(home.to_str().unwrap());
        fs::remove_file(&file).unwrap();
        stale.retain_seen(&[], &[]);
        let mut stale_tombstone = stale.take_write().unwrap();

        fs::write(&file, "new generation\n").unwrap();
        let stamp = FileStamp::of(&file).unwrap();
        let mut newer = UsageScanCache::load(home.to_str().unwrap());
        let mut newer_totals = CodexFileTotals::default();
        newer_totals.absorb_recent("2026-08-06T00:00:00Z", 9, 0, 0);
        newer.put_codex(&file, stamp, resume_at(&file, stamp.size), newer_totals);
        assert!(newer.take_write().unwrap().write(home.to_str().unwrap()));
        assert!(stale_tombstone.write(home.to_str().unwrap()));

        assert_eq!(
            UsageScanCache::load(home.to_str().unwrap())
                .codex_cached(&file)
                .unwrap()
                .recent[0]
                .input,
            9,
        );
    }

    #[test]
    fn older_replacement_cannot_overwrite_a_newer_persisted_generation() {
        let home = tmpdir("journal-stale-process-generation");
        let file = home.join("a.jsonl");
        fs::write(&file, "x\n").unwrap();
        let mut base = UsageScanCache::empty();
        let mut totals = CodexFileTotals {
            recent_floor: Some("2026-08-04T00:00:00".into()),
            ..Default::default()
        };
        totals.absorb_recent("2026-08-06T00:00:00Z", 1, 0, 0);
        base.put_codex(
            &file,
            FileStamp { mtime: 1, size: 1 },
            Resume { parsed_bytes: 1, head: 7 },
            totals,
        );
        let _ = base.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &base));

        let mut older = UsageScanCache::load(home.to_str().unwrap());
        let mut newer = UsageScanCache::load(home.to_str().unwrap());
        let mut older_tail = CodexFileTotals {
            recent_floor: Some("2026-08-04T00:00:00".into()),
            ..Default::default()
        };
        older_tail.absorb_recent("2026-08-06T00:01:00Z", 7, 0, 0);
        let (older_stamp, older_resume) = append_fixture(&file, b"older\n");
        older.merge_codex(&file, older_stamp, older_resume, older_tail);
        let mut newer_tail = CodexFileTotals {
            recent_floor: Some("2026-08-04T00:00:00".into()),
            ..Default::default()
        };
        newer_tail.absorb_recent("2026-08-06T00:01:00Z", 7, 0, 0);
        newer_tail.absorb_recent("2026-08-06T00:02:00Z", 9, 0, 0);
        let (newer_stamp, newer_resume) = append_fixture(&file, b"newer\n");
        newer.merge_codex(&file, newer_stamp, newer_resume, newer_tail);

        assert!(newer.take_write().unwrap().write(home.to_str().unwrap()));
        assert!(older.take_write().unwrap().write(home.to_str().unwrap()));
        assert!(compact_persisted_cache(home.to_str().unwrap()));
        assert!(!cache_journal_path(home.to_str().unwrap()).exists());

        let loaded = UsageScanCache::load(home.to_str().unwrap());
        assert_eq!(
            loaded
                .codex_cached(&file)
                .unwrap()
                .recent
                .iter()
                .map(|bucket| bucket.input)
                .collect::<Vec<_>>(),
            [1, 7, 9],
        );
    }

    #[test]
    fn replay_uses_the_last_raw_valid_rewrite_even_if_metadata_moves_backward() {
        let file = PathBuf::from("/derived/rewrite.jsonl");
        let mut cache = UsageScanCache::empty();
        let mut newer_totals = CodexFileTotals::default();
        newer_totals.absorb_recent("2026-08-06T00:00:00Z", 9, 0, 0);
        cache.put_codex(
            &file,
            FileStamp { mtime: 9, size: 9 },
            Resume { parsed_bytes: 9, head: 9 },
            newer_totals,
        );
        let _ = cache.take_write();
        let mut rewritten_totals = CodexFileTotals::default();
        rewritten_totals.absorb_recent("2026-08-06T00:00:00Z", 1, 0, 0);
        let mut replacement = UsageCacheReplacement {
            version: JOURNAL_VERSION,
            ..Default::default()
        };
        replacement.codex.insert(
            file.to_string_lossy().into_owned(),
            Some(Arc::new(CodexEntry {
                stamp: FileStamp { mtime: 1, size: 1 },
                resume: Resume { parsed_bytes: 1, head: 1 },
                totals: rewritten_totals,
            })),
        );

        // Every journal entry crossed the raw stamp/head CAS before append, so
        // serialized order—not wall-clock monotonicity—is the generation order.
        cache.apply_replacement(replacement);

        let entry = cache.codex.get(file.to_str().unwrap()).unwrap();
        assert_eq!(entry.stamp.mtime, 1);
        assert_eq!(entry.totals.recent[0].input, 1);
    }

    #[test]
    fn stale_snapshot_marker_cannot_overwrite_a_newer_persisted_generation() {
        let home = tmpdir("stale-snapshot-generation");
        let file = home.join("a.jsonl");
        fs::write(&file, "x\n").unwrap();
        let stamp = FileStamp::of(&file).unwrap();
        let resume = resume_at(&file, stamp.size);

        let mut base = UsageScanCache::empty();
        let mut base_totals = CodexFileTotals::default();
        base_totals.absorb_recent("2026-08-06T00:00:00Z", 1, 0, 0);
        base.put_codex(&file, stamp, resume, base_totals);
        let _ = base.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &base));

        let mut stale = UsageScanCache::load(home.to_str().unwrap());
        stale.retry_with_compaction();
        let mut stale_marker = stale.take_write().unwrap();
        assert!(stale_marker.compact_first);

        let mut newer = UsageScanCache::load(home.to_str().unwrap());
        let mut newer_totals = CodexFileTotals::default();
        newer_totals.absorb_recent("2026-08-06T00:00:00Z", 9, 0, 0);
        newer.put_codex(&file, stamp, resume, newer_totals);
        assert!(newer.take_write().unwrap().write(home.to_str().unwrap()));
        assert_eq!(
            UsageScanCache::load(home.to_str().unwrap())
                .codex_cached(&file)
                .unwrap()
                .recent[0]
                .input,
            9,
        );

        assert!(stale_marker.write(home.to_str().unwrap()));
        assert_eq!(
            UsageScanCache::load(home.to_str().unwrap())
                .codex_cached(&file)
                .unwrap()
                .recent[0]
                .input,
            9,
            "a stale process-local graph cannot become snapshot authority",
        );
    }

    #[test]
    fn same_stamp_rewrite_rejects_a_replacement_with_the_old_head() {
        let home = tmpdir("journal-same-stamp-rewrite");
        let file = home.join("a.jsonl");
        fs::write(&file, "old\n").unwrap();
        let old_resume = resume_at(&file, 4);
        fs::write(&file, "new\n").unwrap();
        let current_stamp = FileStamp::of(&file).unwrap();
        let current_resume = resume_at(&file, 4);
        assert_ne!(old_resume.head, current_resume.head);

        let mut current = UsageScanCache::empty();
        let mut current_totals = CodexFileTotals::default();
        current_totals.absorb_recent("2026-08-06T00:00:00Z", 9, 0, 0);
        current.put_codex(&file, current_stamp, current_resume, current_totals);
        let _ = current.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &current));

        let mut stale = UsageScanCache::load(home.to_str().unwrap());
        let mut stale_totals = CodexFileTotals::default();
        stale_totals.absorb_recent("2026-08-06T00:00:00Z", 1, 0, 0);
        stale.put_codex(&file, current_stamp, old_resume, stale_totals);
        assert!(stale.take_write().unwrap().write(home.to_str().unwrap()));

        assert!(!cache_journal_path(home.to_str().unwrap()).exists());
        assert_eq!(
            UsageScanCache::load(home.to_str().unwrap())
                .codex_cached(&file)
                .unwrap()
                .recent[0]
                .input,
            9,
        );
    }

    #[test]
    fn protected_current_entry_cannot_escape_the_recent_bucket_limit() {
        let home = tmpdir("protected-capacity");
        let file = home.join("a.jsonl");
        fs::write(&file, "x\n").unwrap();
        let mut cache = UsageScanCache::empty();
        let totals = CodexFileTotals {
            recent_floor: Some("2026-08-04T00:00:00".into()),
            recent: (0..MAX_CODEX_RECENT_BUCKETS)
                .map(|index| CodexTimeBucket {
                    second: format!("{index:019}"),
                    input: 1,
                    turns: 1,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        cache.put_codex(
            &file,
            FileStamp { mtime: 1, size: 1 },
            Resume { parsed_bytes: 1, head: 7 },
            totals,
        );
        let mut tail = CodexFileTotals {
            recent_floor: Some("2026-08-04T00:00:00".into()),
            ..Default::default()
        };
        tail.absorb_recent("9999999999999999999", 7, 0, 0);
        cache.merge_codex(
            &file,
            FileStamp { mtime: 2, size: 2 },
            Resume { parsed_bytes: 2, head: 7 },
            tail,
        );
        let observed_input = cache
            .codex_cached(&file)
            .unwrap()
            .recent
            .iter()
            .map(|bucket| bucket.input)
            .sum::<u64>();

        cache.enforce_capacity_protecting(file.to_str());

        let retained = cache.codex_cached(&file).unwrap();
        assert_eq!(observed_input, MAX_CODEX_RECENT_BUCKETS as u64 + 7);
        assert!(retained.recent.len() <= MAX_CODEX_RECENT_BUCKETS);
        assert!(retained.recent_floor.is_none());
    }

    #[test]
    fn journal_replays_removal_tombstones() {
        let home = tmpdir("journal-removal");
        let f = home.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut cache = UsageScanCache::empty();
        cache.put_claude(&f, FileStamp::of(&f).unwrap(), Resume::default(), Vec::new());
        let _ = cache.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &cache));

        fs::remove_file(&f).unwrap();
        cache.retain_seen(&[], &[]);
        assert!(cache.take_write().unwrap().write(home.to_str().unwrap()));

        assert!(UsageScanCache::load(home.to_str().unwrap()).claude_cached(&f).is_none());
    }

    #[test]
    fn incomplete_journal_tail_schedules_persisted_compaction() {
        let home = tmpdir("journal-incomplete");
        let f = home.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut cache = UsageScanCache::empty();
        cache.put_claude(&f, FileStamp::of(&f).unwrap(), Resume::default(), Vec::new());
        let _ = cache.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &cache));
        fs::write(cache_journal_path(home.to_str().unwrap()), "{\"v\":1").unwrap();

        let mut loaded = UsageScanCache::load(home.to_str().unwrap());

        assert!(loaded.claude_cached(&f).is_some());
        assert!(loaded.take_write().unwrap().compact_first);
    }

    #[test]
    fn interrupted_snapshot_compaction_promotes_the_complete_snapshot() {
        let home = tmpdir("journal-compaction-recovery");
        let f = home.join("a.jsonl");
        fs::write(&f, "x\n").unwrap();
        let mut cache = UsageScanCache::empty();
        cache.put_claude(
            &f,
            FileStamp::of(&f).unwrap(),
            Resume::default(),
            vec![ClaudeRecord { input: 1, ..Default::default() }],
        );
        let _ = cache.take_write();
        assert!(write_snapshot_atomic(home.to_str().unwrap(), &cache));
        cache.put_claude(
            &f,
            FileStamp::of(&f).unwrap(),
            Resume::default(),
            vec![ClaudeRecord { input: 9, ..Default::default() }],
        );
        assert!(cache.take_write().unwrap().write(home.to_str().unwrap()));

        cache.put_claude(
            &f,
            FileStamp::of(&f).unwrap(),
            Resume::default(),
            vec![ClaudeRecord { input: 11, ..Default::default() }],
        );
        let tmp = cache_path(home.to_str().unwrap()).with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string(&cache).unwrap()).unwrap();
        let journal = cache_journal_path(home.to_str().unwrap());
        let retired = journal.with_extension("jsonl.retired");
        fs::rename(&journal, &retired).unwrap();

        let loaded = UsageScanCache::load(home.to_str().unwrap());

        assert_eq!(loaded.claude_cached(&f).unwrap()[0].input, 11);
        assert!(!tmp.exists());
        assert!(!retired.exists());
    }

    #[test]
    fn offset_stops_at_the_last_complete_line() {
        let dir = tmpdir("offset");
        let f = dir.join("a.jsonl");
        // 마지막 줄은 쓰이는 중이라 개행이 없다.
        fs::write(&f, "{\"usage\":1}\n{\"usage\":2}\n{\"usage\":3").unwrap();

        let mut seen = Vec::new();
        let consumed = for_each_marked_line_from(&f, 0, "\"usage\"", |l| seen.push(l.to_string()));

        assert_eq!(seen, vec!["{\"usage\":1}", "{\"usage\":2}"]);
        assert_eq!(consumed, 24, "완결된 두 줄까지만 인정해야 한다");
        assert!(consumed < fs::metadata(&f).unwrap().len());
    }

    /// 잘려 있던 줄이 완성되면 그때 정확히 한 번 잡혀야 한다. 미완결 줄을
    /// 세면서 오프셋을 안 올리면 두 번 세고, 올리면 나머지를 잃는다.
    #[test]
    fn a_half_written_line_is_counted_exactly_once_when_it_completes() {
        let dir = tmpdir("halfline");
        let f = dir.join("a.jsonl");
        fs::write(&f, "{\"usage\":1}\n{\"usa").unwrap();

        let mut first = Vec::new();
        let after_first = for_each_marked_line_from(&f, 0, "\"usage\"", |l| first.push(l.to_string()));
        assert_eq!(first, vec!["{\"usage\":1}"]);

        // 기록기가 줄을 완성하고 하나 더 붙였다.
        fs::write(&f, "{\"usage\":1}\n{\"usage\":2}\n{\"usage\":3}\n").unwrap();
        let mut second = Vec::new();
        for_each_marked_line_from(&f, after_first, "\"usage\"", |l| second.push(l.to_string()));

        assert_eq!(second, vec!["{\"usage\":2}", "{\"usage\":3}"]);
        assert!(!second.contains(&"{\"usage\":1}".to_string()), "이미 센 줄을 또 세면 안 된다");
    }

    #[test]
    fn resume_plan_reuses_only_an_identical_stamp() {
        let was = FileStamp { mtime: 10, size: 100 };
        let resume = Resume { parsed_bytes: 100, head: 7 };
        assert_eq!(resume_plan(Some((resume, was)), was, 7), ResumePlan::Reuse);
    }

    #[test]
    fn resume_plan_tails_an_append() {
        let was = FileStamp { mtime: 10, size: 100 };
        let now = FileStamp { mtime: 11, size: 180 };
        let resume = Resume { parsed_bytes: 100, head: 7 };
        assert_eq!(resume_plan(Some((resume, was)), now, 7), ResumePlan::Tail(100));
    }

    /// 크기가 줄면 절단·회전이다. 꼬리만 읽으면 남은 앞부분을 또 세거나
    /// 엉뚱한 위치에서 이어 붙인다.
    #[test]
    fn resume_plan_restarts_after_truncation() {
        let was = FileStamp { mtime: 10, size: 100 };
        let now = FileStamp { mtime: 11, size: 40 };
        let resume = Resume { parsed_bytes: 100, head: 7 };
        assert_eq!(resume_plan(Some((resume, was)), now, 7), ResumePlan::Full);
    }

    /// 같은 이름에 다른 파일이 들어앉으면(크기는 더 커도) 앞부분이 달라진다.
    /// 이걸 못 잡으면 남의 파일 꼬리를 우리 레코드에 이어 붙인다.
    #[test]
    fn resume_plan_restarts_when_the_head_changed() {
        let was = FileStamp { mtime: 10, size: 100 };
        let now = FileStamp { mtime: 11, size: 400 };
        let resume = Resume { parsed_bytes: 100, head: 7 };
        assert_eq!(resume_plan(Some((resume, was)), now, 999), ResumePlan::Full);
    }

    #[test]
    fn head_fingerprint_is_stable_under_append_and_catches_a_rewrite() {
        let dir = tmpdir("head");
        let a = dir.join("a.jsonl");
        fs::write(&a, "first line\nrest\n").unwrap();
        let len = 16; // 이미 파싱한 구간 안의 고정 길이
        let before = head_fingerprint_of(&a, len);
        assert_ne!(before, 0);

        // append는 앞부분을 건드리지 않는다 — 4KB보다 작은 파일에서도.
        fs::write(&a, "first line\nrest\nmore\n").unwrap();
        assert_eq!(head_fingerprint_of(&a, len), before);

        // 앞을 갈아엎으면 달라져야 한다.
        fs::write(&a, "OTHER line\nrest\n").unwrap();
        assert_ne!(head_fingerprint_of(&a, len), before);

        // 요청 길이보다 짧아지면 0 — 호출자가 전체 재파싱으로 간다.
        fs::write(&a, "tiny").unwrap();
        assert_eq!(head_fingerprint_of(&a, len), 0);
    }

    #[test]
    fn marked_lines_are_streamed_and_bad_utf8_only_costs_its_line() {
        let dir = tmpdir("stream");
        let f = dir.join("a.jsonl");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"{\"usage\":1}\n");
        bytes.extend_from_slice(&[0xff, 0xfe, b'\n']); // 깨진 줄
        bytes.extend_from_slice(b"{\"usage\":2}\n");
        bytes.extend_from_slice(b"{\"other\":3}\n");
        fs::write(&f, bytes).unwrap();

        let mut seen = Vec::new();
        for_each_marked_line(&f, "\"usage\"", |l| seen.push(l.to_string()));

        assert_eq!(seen, vec!["{\"usage\":1}", "{\"usage\":2}"]);
    }
}
