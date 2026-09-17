use std::{
    collections::BTreeMap,
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime},
};

use serde::{Deserialize, Serialize};

use crate::session_credentials::{AttributionConfidence, ConversationCredential};
use crate::usage_cache::{self, ClaudeRecord, FileStamp, ResumePlan, UsageScanCache};

/// 일반 Codex 예산의 limit_id. 모델별 예산은 다른 id를 가지며 합치지 않는다.
const PRIMARY_CODEX_LIMIT_ID: &str = "codex";

type TokenCounts = (u64, u64, u64, u64);
type DatedTokenCounts = (TokenCounts, String);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

/// Codex가 별도 예산으로 보고하는 rate-limit bucket 한 개. 일반 Codex는
/// limit_id="codex", 모델별 예산은 서로 다른 id/name을 가진다.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitUsage {
    pub limit_id: String,
    pub limit_name: Option<String>,
    pub used_percent: Option<f64>,
    pub used_percent_weekly: Option<f64>,
    pub resets_at: Option<u64>,
    pub weekly_resets_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<CodexCredits>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageSnapshot {
    pub credential_id: Option<String>,
    /// 마지막 성공 시각. 실패한 probe는 이 값과 rate_limits를 보존한다.
    pub captured_at: Option<u64>,
    pub attempted_at: Option<u64>,
    pub error: Option<String>,
    pub rate_limits: Vec<CodexRateLimitUsage>,
    /// Earned usage-limit resets, separate from per-bucket workspace credits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit_resets_available: Option<u64>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
    /// Codex만: 최신 이벤트의 단기(5h, window≈300분) 한도 사용률(%)
    pub used_percent: Option<f64>,
    /// Codex만: 주간(window≈10080분) 한도 사용률(%)
    pub used_percent_weekly: Option<f64>,
    /// Codex만: 단기 한도 리셋 시각(epoch seconds)
    pub resets_at: Option<u64>,
    /// Codex만: 주간 한도 리셋 시각(epoch seconds)
    pub weekly_resets_at: Option<u64>,
    /// 한도 실측 수집 시각(epoch seconds). Claude는 statusLine 하한,
    /// Codex는 App Server의 마지막 성공 snapshot이다.
    pub used_percent_captured_at: Option<u64>,
    /// Codex만: limit_id별 최신 한도. 일반/모델별 예산을 합치지 않는다.
    pub rate_limits: Vec<CodexRateLimitUsage>,
}

/// Codex 계정별 사용량 한 묶음. Codex는 conversation→credential 저널(wa6s)로
/// 세션 단위 귀속이 가능하므로 토큰·한도 % 모두 계정별로 가른다.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    /// 귀속된 credential id. attributed=true이면서 None이면 기본 credential.
    pub credential_id: Option<String>,
    /// 저널 바인딩 근거가 있는지. false면 '미분류' 묶음이다 — 저널 도입 전이나
    /// 앱 밖에서 시작된 세션이며, 활성 계정 것으로 추정하지 않는다.
    pub attributed: bool,
    /// 이 묶음의 세션이 전부 '관측' 근거뿐인지 — 이미 돌던 runtime generation에
    /// 재부착한 launch라 그 credential이 대화를 만들었다는 증명은 아니다.
    /// 장수 세션은 generation을 다시 만들지 않으므로 이걸 아예 안 읽으면 그
    /// 계정은 영영 비어 보인다. 읽되 근거의 등급을 UI가 밝힌다.
    pub observed_only: bool,
    pub usage: ProviderUsage,
}

/// Claude 계정별로 알 수 있는 것은 실측 한도뿐이다. transcript 저장소
/// (~/.claude/projects)를 계정 오버레이가 심링크로 공유하므로 토큰은 계정
/// 귀속이 원천 불가 — 여기에 토큰을 넣으면 그건 지어낸 숫자가 된다.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountRateLimit {
    /// 수집기가 기록한 프로필 키 — 계정 디렉터리 이름 또는 "default".
    pub profile_key: String,
    pub used_percent: Option<f64>,
    pub used_percent_weekly: Option<f64>,
    pub resets_at: Option<u64>,
    pub weekly_resets_at: Option<u64>,
    pub used_percent_captured_at: Option<u64>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub claude: ProviderUsage,
    pub codex: ProviderUsage,
    /// 계정별 Claude 실측 한도 (토큰은 공유 저장소라 분해 불가).
    pub claude_accounts: Vec<AccountRateLimit>,
    /// 계정별 Codex 사용량 + 미분류 묶음.
    pub codex_accounts: Vec<AccountUsage>,
    /// 등록 credential별 Codex App Server 실측 snapshot. 세션 로그 창과
    /// 독립적으로 마지막 성공값을 보존한다.
    pub codex_account_snapshots: Vec<CodexUsageSnapshot>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageScanTelemetry {
    pub snapshot_cache_hits: u64,
    pub cache_hits: u64,
    pub incremental_hits: u64,
    pub full_scans: u64,
    pub bytes_read: u64,
    pub scan_duration_ms: u64,
    pub coalesced_requests: u64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecentSnapshot {
    pub five_hours: UsageReport,
    pub twenty_four_hours: UsageReport,
    pub telemetry: UsageScanTelemetry,
}

/// 하루치 토큰 합계 (히트맵/일일 강도용)
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DayTokens {
    pub date: String, // "YYYY-MM-DD" (UTC)
    pub total: u64,
}

/// 사용량 통계 — usage_recent보다 풍부(세션·턴·일별). 설정 '통계 및 사용량' 페이지용.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStats {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
    /// 스캔한 로그 파일(세션) 수
    pub sessions: u64,
    /// usage 레코드(assistant 응답/요청) 수
    pub turns: u64,
    pub used_percent: Option<f64>,
    pub used_percent_weekly: Option<f64>,
    pub resets_at: Option<u64>,
    pub weekly_resets_at: Option<u64>,
    pub used_percent_captured_at: Option<u64>,
    pub rate_limits: Vec<CodexRateLimitUsage>,
    /// 날짜별 토큰 합계 (오래된→최신)
    pub daily: Vec<DayTokens>,
}

#[derive(Serialize, Clone, Default)]
pub struct UsageStats {
    pub claude: ProviderStats,
    pub codex: ProviderStats,
}

impl From<ProviderStats> for ProviderUsage {
    fn from(s: ProviderStats) -> Self {
        ProviderUsage {
            input: s.input,
            output: s.output,
            cache_read: s.cache_read,
            cache_write: s.cache_write,
            total: s.total,
            used_percent: s.used_percent,
            used_percent_weekly: s.used_percent_weekly,
            resets_at: s.resets_at,
            weekly_resets_at: s.weekly_resets_at,
            used_percent_captured_at: s.used_percent_captured_at,
            rate_limits: s.rate_limits,
        }
    }
}

fn u64_at(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

/// ISO 타임스탬프의 날짜 부분 "YYYY-MM-DD" (앞 10글자).
fn date_of(ts: &str) -> String {
    ts.chars().take(10).collect()
}

/// daily 맵을 날짜순 Vec로.
fn daily_vec(map: BTreeMap<String, u64>) -> Vec<DayTokens> {
    map.into_iter().map(|(date, total)| DayTokens { date, total }).collect()
}

/// 파일의 `from` 바이트 이후 usage 레코드와, 마지막 완결 줄 다음 오프셋.
/// 창 필터를 여기서 걸면 캐시가 창에 종속돼 기간을 바꿀 때마다 무효가 된다.
fn parse_claude_records_from(path: &Path, from: u64) -> (Vec<ClaudeRecord>, u64) {
    let mut out = Vec::new();
    let consumed = usage_cache::for_each_marked_line_from(path, from, "\"usage\"", |line| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
        let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
        if ts.is_empty() {
            return;
        }
        let Some(msg) = v.get("message") else { return };
        let Some(u) = msg.get("usage") else { return };
        out.push(ClaudeRecord {
            id: msg.get("id").and_then(|i| i.as_str()).map(String::from),
            input: u64_at(u, "input_tokens"),
            output: u64_at(u, "output_tokens"),
            cache_read: u64_at(u, "cache_read_input_tokens"),
            cache_write: u64_at(u, "cache_creation_input_tokens"),
            ts: ts.to_string(),
        });
    });
    (out, consumed)
}

fn observe_scan_plan(
    telemetry: &mut Option<&mut UsageScanTelemetry>,
    plan: ResumePlan,
    stamp: FileStamp,
) {
    let Some(telemetry) = telemetry.as_deref_mut() else { return };
    match plan {
        ResumePlan::Reuse => telemetry.cache_hits += 1,
        ResumePlan::Tail(from) => {
            telemetry.incremental_hits += 1;
            telemetry.bytes_read += stamp.size.saturating_sub(from);
        }
        ResumePlan::Full => {
            telemetry.full_scans += 1;
            telemetry.bytes_read += stamp.size;
        }
    }
}

fn visit_claude_files(
    home: &str,
    since: SystemTime,
    mut cache: Option<&mut UsageScanCache>,
    mut telemetry: Option<&mut UsageScanTelemetry>,
    mut visit: impl FnMut(u64, &[ClaudeRecord]),
) -> Vec<PathBuf> {
    let mut files = Vec::new();
    usage_cache::recent_jsonl(&Path::new(home).join(".claude/projects"), since, &mut files);
    for f in &files {
        // 지문을 못 읽으면 캐시를 쓰지 않는다 — 바뀌었는지 확인할 수 없는
        // 파일을 캐시하면 조용히 낡은 값을 쓴다.
        let stamp = FileStamp::of(f);
        match (stamp, cache.as_deref_mut()) {
            (Some(s), Some(c)) => {
                // 지문을 한 번만 계산해 재사용한다. Reuse 판정이면 앞부분조차
                // 읽지 않으므로 OnceCell 대신 필요할 때 채우는 방식으로 둔다.
                let plan = c.claude_plan(f, s);
                observe_scan_plan(&mut telemetry, plan, s);
                match plan {
                    // 파일을 아예 열지 않는다.
                    ResumePlan::Reuse => {
                        visit(s.modified_seconds(), c.claude_cached(f).unwrap_or_default())
                    }
                    // 자란 만큼만 읽어 이어 붙인다 — 활성 세션 로그가 수백 MB라
                    // 전체 재파싱과 꼬리 파싱의 차이가 그대로 체감 지연이 된다.
                    ResumePlan::Tail(from) => {
                        let (more, consumed) = parse_claude_records_from(f, from);
                        c.append_claude(f, s, usage_cache::resume_at(f, consumed), more);
                        visit(s.modified_seconds(), c.claude_cached(f).unwrap_or_default());
                        c.enforce_capacity();
                    }
                    ResumePlan::Full => {
                        let (parsed, consumed) = parse_claude_records_from(f, 0);
                        visit(s.modified_seconds(), &parsed);
                        c.put_claude(f, s, usage_cache::resume_at(f, consumed), parsed);
                        c.enforce_capacity();
                    }
                }
            }
            (Some(s), None) => {
                observe_scan_plan(&mut telemetry, ResumePlan::Full, s);
                let parsed = parse_claude_records_from(f, 0).0;
                visit(s.modified_seconds(), &parsed);
            }
            (None, _) => {
                let parsed = parse_claude_records_from(f, 0).0;
                visit(0, &parsed);
            }
        }
    }
    files
}

/// Claude Code: ~/.claude/projects/**/*.jsonl — assistant 메시지의
/// message.usage를 message.id로 중복 제거(스트리밍 중복 기록) 후 합산.
/// ISO8601 UTC 문자열은 사전순 비교가 시간순 비교와 같다.
#[derive(Default)]
struct ClaudeAccumulator {
    by_id: HashMap<String, DatedTokenCounts>,
    anonymous: Vec<DatedTokenCounts>,
    sessions: u64,
}

impl ClaudeAccumulator {
    fn absorb_file(
        &mut self,
        mtime: u64,
        records: &[ClaudeRecord],
        since_iso: &str,
        since_epoch: u64,
    ) {
        if mtime < since_epoch {
            return;
        }
        self.sessions += 1;
        for record in records {
            if record.ts.as_str() < since_iso {
                continue;
            }
            let counts =
                (record.input, record.output, record.cache_read, record.cache_write);
            let dated = (counts, date_of(&record.ts));
            match &record.id {
                Some(id) => {
                    self.by_id.insert(id.clone(), dated);
                }
                None => self.anonymous.push(dated),
            }
        }
    }

    fn finish(self, home: &str, now: u64) -> ProviderStats {
        let mut report = ProviderStats { sessions: self.sessions, ..Default::default() };
        let mut daily: BTreeMap<String, u64> = BTreeMap::new();
        let mut fold = |record: TokenCounts, date: String, report: &mut ProviderStats| {
            report.input += record.0;
            report.output += record.1;
            report.cache_read += record.2;
            report.cache_write += record.3;
            report.turns += 1;
            *daily.entry(date).or_default() += record.0 + record.1 + record.2 + record.3;
        };
        for (_, (record, date)) in self.by_id {
            fold(record, date, &mut report);
        }
        for (record, date) in self.anonymous {
            fold(record, date, &mut report);
        }
        report.total = report.input + report.output + report.cache_read + report.cache_write;
        report.daily = daily_vec(daily);

        let path =
            crate::app_home::app_root_under(Path::new(home)).join("claude-rate-limits.json");
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
                apply_claude_cached_rate_limits(&value, now, &mut report);
            }
        }
        report
    }
}

fn claude_stats(
    home: &str,
    since_iso: &str,
    since: SystemTime,
    cache: Option<&mut UsageScanCache>,
) -> ProviderStats {
    let since_epoch = epoch_seconds(since);
    let mut accumulator = ClaudeAccumulator::default();
    visit_claude_files(home, since, cache, None, |mtime, records| {
        accumulator.absorb_file(mtime, records, since_iso, since_epoch);
    });
    accumulator.finish(home, now_secs())
}

/// statusLine 수집기 캐시(`{captured_at, rate_limits:{five_hour,seven_day}}`) →
/// Claude의 실측 5h/주간 %. 창이 이미 리셋됐으면(now >= resets_at) 그 창 값은
/// 버린다 — 스냅샷이 더 이상 현재 창을 설명하지 않는다. 살아 있는 창의 %는
/// 수집 시각 이후 사용이 빠졌을 수 있는 "하한"이며, captured_at을 같이 넘겨
/// 프론트가 수집 시점을 표시하게 한다.
fn apply_claude_cached_rate_limits(v: &serde_json::Value, now: u64, r: &mut ProviderStats) {
    let Some(rl) = v.get("rate_limits") else { return };
    let captured = v.get("captured_at").and_then(|x| x.as_u64());
    let window = |key: &str| -> Option<(f64, u64)> {
        let b = rl.get(key)?;
        let pct = b.get("used_percentage").and_then(|x| x.as_f64())?;
        let resets = b.get("resets_at").and_then(|x| x.as_u64())?;
        (resets > now).then_some((pct, resets))
    };
    let mut applied = false;
    if let Some((pct, resets)) = window("five_hour") {
        r.used_percent = Some(pct);
        r.resets_at = Some(resets);
        applied = true;
    }
    if let Some((pct, resets)) = window("seven_day") {
        r.used_percent_weekly = Some(pct);
        r.weekly_resets_at = Some(resets);
        applied = true;
    }
    if applied {
        r.used_percent_captured_at = captured;
    }
}

/// Codex rate_limits 객체 → ProviderStats의 5h/weekly 사용률·리셋 시각.
///
/// 실제 포맷은 nested: `{primary:{used_percent,window_minutes,resets_at}, secondary:{…}}`.
/// primary가 항상 5h인 건 아니다(weekly만 오는 세션도 있음) — window_minutes로
/// 분류한다(≤1440 = 5h/단기, 그 이상 = weekly). 구 flat 포맷도 폴백 지원.
fn apply_rate_limits(rl: &serde_json::Value, r: &mut ProviderStats) {
    let mut short: Option<(f64, Option<u64>)> = None;
    let mut weekly: Option<(f64, Option<u64>)> = None;
    for key in ["primary", "secondary"] {
        let Some(b) = rl.get(key).filter(|b| b.is_object()) else { continue };
        let Some(pct) = b.get("used_percent").and_then(|x| x.as_f64()) else { continue };
        let win = b.get("window_minutes").and_then(|x| x.as_u64()).unwrap_or(0);
        let reset = b.get("resets_at").and_then(|x| x.as_u64());
        if win > 0 && win <= 1440 {
            short = Some((pct, reset));
        } else {
            weekly = Some((pct, reset));
        }
    }
    // 구 포맷 폴백: flat primary_used_percent / secondary_used_percent
    if short.is_none() && weekly.is_none() {
        short = rl.get("primary_used_percent").and_then(|x| x.as_f64()).map(|p| (p, None));
        weekly = rl.get("secondary_used_percent").and_then(|x| x.as_f64()).map(|p| (p, None));
    }
    r.used_percent = short.map(|(p, _)| p);
    r.resets_at = short.and_then(|(_, reset)| reset);
    r.used_percent_weekly = weekly.map(|(p, _)| p);
    r.weekly_resets_at = weekly.and_then(|(_, reset)| reset);
}

fn codex_rate_limit(rl: &serde_json::Value) -> Option<CodexRateLimitUsage> {
    let mut stats = ProviderStats::default();
    apply_rate_limits(rl, &mut stats);
    if stats.used_percent.is_none() && stats.used_percent_weekly.is_none() {
        return None;
    }
    let limit_id = rl
        .get("limit_id")
        .and_then(|x| x.as_str())
        .filter(|id| !id.is_empty())
        .unwrap_or("codex")
        .to_string();
    let limit_name = rl
        .get("limit_name")
        .and_then(|x| x.as_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    Some(CodexRateLimitUsage {
        limit_id,
        limit_name,
        used_percent: stats.used_percent,
        used_percent_weekly: stats.used_percent_weekly,
        resets_at: stats.resets_at,
        weekly_resets_at: stats.weekly_resets_at,
        credits: None,
    })
}

struct TimedCodexRateLimit {
    timestamp: String,
    usage: CodexRateLimitUsage,
}

/// Codex 세션 파일 한 개분의 누적기 — 전체 합계와 계정별 합계가 같은 코드로
/// 굴러가도록 분리했다.
#[derive(Default)]
struct CodexAccumulator {
    stats: ProviderStats,
    daily: BTreeMap<String, u64>,
    rate_limits: BTreeMap<String, TimedCodexRateLimit>,
    sessions: u64,
    /// 이 묶음에 증명된(generation을 만든) 세션이 하나라도 있었는지.
    has_committed: bool,
}

impl CodexAccumulator {
    /// payload/info를 가진 token_count 라인 하나를 흡수한다.
    fn absorb(&mut self, v: &serde_json::Value, ts: &str) {
        if let Some(last) = v.pointer("/payload/info/last_token_usage") {
            let i = u64_at(last, "input_tokens");
            let o = u64_at(last, "output_tokens");
            let cr = u64_at(last, "cached_input_tokens").min(i);
            self.stats.input += i;
            self.stats.output += o;
            self.stats.cache_read += cr;
            self.stats.turns += 1;
            // Codex input_tokens already includes cached_input_tokens. The local
            // activity total excludes that reused context instead of counting it
            // once as input and again as cache.
            *self.daily.entry(date_of(ts)).or_default() += i.saturating_sub(cr) + o;
        }
        if let Some(limit) = v
            .pointer("/payload/rate_limits")
            .or_else(|| v.pointer("/payload/info/rate_limits"))
            .and_then(codex_rate_limit)
        {
            let is_newer = self
                .rate_limits
                .get(&limit.limit_id)
                .is_none_or(|current| ts > current.timestamp.as_str());
            if is_newer {
                self.rate_limits.insert(
                    limit.limit_id.clone(),
                    TimedCodexRateLimit { timestamp: ts.to_string(), usage: limit },
                );
            }
        }
    }

    fn absorb_bucket(&mut self, bucket: &crate::usage_cache::CodexTimeBucket) {
        self.stats.input += bucket.input;
        self.stats.output += bucket.output;
        self.stats.cache_read += bucket.cache_read;
        self.stats.turns += bucket.turns;
        *self.daily.entry(date_of(&bucket.second)).or_default() +=
            bucket.input.saturating_sub(bucket.cache_read) + bucket.output;
    }

    fn absorb_timed_limit(&mut self, limit: &crate::usage_cache::TimedLimit) {
        let usage = CodexRateLimitUsage {
            limit_id: limit.limit_id.clone(),
            limit_name: limit.limit_name.clone(),
            used_percent: limit.used_percent,
            used_percent_weekly: limit.used_percent_weekly,
            resets_at: limit.resets_at,
            weekly_resets_at: limit.weekly_resets_at,
            credits: None,
        };
        let is_newer = self
            .rate_limits
            .get(&limit.limit_id)
            .is_none_or(|current| limit.timestamp > current.timestamp);
        if is_newer {
            self.rate_limits.insert(
                limit.limit_id.clone(),
                TimedCodexRateLimit { timestamp: limit.timestamp.clone(), usage },
            );
        }
    }

    fn finish(mut self) -> ProviderStats {
        self.stats.rate_limits =
            self.rate_limits.into_values().map(|snapshot| snapshot.usage).collect();
        if let Some(general) =
            self.stats.rate_limits.iter().find(|limit| limit.limit_id == PRIMARY_CODEX_LIMIT_ID)
        {
            self.stats.used_percent = general.used_percent;
            self.stats.used_percent_weekly = general.used_percent_weekly;
            self.stats.resets_at = general.resets_at;
            self.stats.weekly_resets_at = general.weekly_resets_at;
        }
        self.stats.sessions = self.sessions;
        self.stats.total = self.stats.input.saturating_sub(self.stats.cache_read) + self.stats.output;
        self.stats.daily = daily_vec(self.daily);
        self.stats
    }
}

/// 사용량 귀속 단위. 미분류를 기본 credential과 절대 합치지 않는다 —
/// 저널 이전·앱 밖 세션을 활성 계정 것으로 세면 그건 지어낸 귀속이다.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum CodexScope {
    Credential(Option<String>),
    Unattributed,
}

/// Codex 세션 파일의 conversation id. session_meta의 payload.session_id가
/// 1순위 — 파일명 규칙(rollout-<ISO>-<uuid>.jsonl)은 codex 내부 구현이라
/// 폴백으로만 쓴다.
fn codex_conversation_id(content: &str, path: &Path) -> Option<String> {
    for line in content.lines().take(4) {
        if !line.contains("session_meta") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if let Some(id) = v.pointer("/payload/session_id").and_then(|x| x.as_str()) {
            return Some(id.to_string());
        }
    }
    let stem = path.file_stem()?.to_str()?;
    let rest = stem.strip_prefix("rollout-")?;
    let parts: Vec<&str> = rest.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    let uuid = parts[parts.len() - 5..].join("-");
    (uuid.len() == 36).then_some(uuid)
}

/// 파일 앞부분만 읽어 conversation id를 뽑는다. session_meta는 첫 몇 줄에
/// 있으므로 파일 전체를 문자열로 올릴 이유가 없다 — 수백 MB짜리 세션 로그가
/// 있어서 그 차이가 크다.
fn codex_conversation_id_of(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let head = fs::File::open(path)
        .map(|f| {
            BufReader::new(f)
                .lines()
                .take(4)
                .map_while(Result::ok)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    codex_conversation_id(&head, path)
}

/// Codex: ~/.codex/sessions/**/*.jsonl — token_count 이벤트의
/// last_token_usage(요청 1건분)를 합산, 최신 이벤트의 rate limit % 추출.
/// 계정 오버레이의 sessions/는 canonical로의 심링크(계정 간 공유)라 디렉터리
/// 분리로는 귀속할 수 없다 — conversation→credential 저널로 가른다.
fn codex_stats_split(
    home: &str,
    since_iso: &str,
    since: SystemTime,
    bindings: &HashMap<String, ConversationCredential>,
) -> (ProviderStats, Vec<AccountUsage>) {
    let mut files = Vec::new();
    usage_cache::recent_jsonl(&Path::new(home).join(".codex/sessions"), since, &mut files);

    let mut total = CodexAccumulator { sessions: files.len() as u64, ..Default::default() };
    let mut per: BTreeMap<CodexScope, CodexAccumulator> = BTreeMap::new();

    for f in files {
        let attribution = codex_conversation_id_of(&f).and_then(|id| bindings.get(&id));
        let scope = attribution.map_or(CodexScope::Unattributed, |credential| {
            CodexScope::Credential(credential.credential_id.clone())
        });
        let bucket = per.entry(scope).or_default();
        bucket.sessions += 1;
        if attribution
            .is_some_and(|credential| credential.confidence == AttributionConfidence::Committed)
        {
            bucket.has_committed = true;
        }
        // 줄 단위 스트리밍 — 이 디렉터리에는 수백 MB짜리 세션 로그가 있어서
        // 파일을 통째로 문자열에 올리는 것 자체가 비용이었다.
        usage_cache::for_each_marked_line(&f, "token_count", |line| {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
            let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
            if ts < since_iso {
                return;
            }
            if v.pointer("/payload/info").is_none() {
                return;
            }
            total.absorb(&v, ts);
            bucket.absorb(&v, ts);
        });
    }

    let accounts = per
        .into_iter()
        .map(|(scope, bucket)| {
            let (credential_id, attributed) = match scope {
                CodexScope::Credential(id) => (id, true),
                CodexScope::Unattributed => (None, false),
            };
            let observed_only = attributed && !bucket.has_committed;
            AccountUsage {
                credential_id,
                attributed,
                observed_only,
                usage: bucket.finish().into(),
            }
        })
        .collect();
    (total.finish(), accounts)
}

/// 캐시를 거치지 않는 Codex 통계. 지금은 캐시 경로가 같은 숫자를 내는지
/// 검증하는 대조군으로만 쓴다.
#[cfg(test)]
fn codex_stats(home: &str, since_iso: &str, since: SystemTime) -> ProviderStats {
    codex_stats_split(home, since_iso, since, &HashMap::new()).0
}

/// 파일의 `from` 이후를 날짜 버킷으로 접고, 마지막 완결 줄 다음 오프셋을 함께
/// 돌려준다. 날짜 합계는 창에 종속시키지 않고, exact recent projection만 명시된
/// 고정 horizon으로 제한한다.
///
/// `from > 0`이면 꼬리만 읽는 중이므로 conversation id를 다시 뽑지 않는다.
/// 그건 파일 앞부분(session_meta)에 있고 이미 캐시에 있다.
fn parse_codex_file_from(
    path: &Path,
    from: u64,
    recent_floor: &str,
) -> (crate::usage_cache::CodexFileTotals, u64) {
    let mut totals = crate::usage_cache::CodexFileTotals {
        conversation_id: (from == 0).then(|| codex_conversation_id_of(path)).flatten(),
        recent_floor: Some(recent_floor.to_string()),
        ..Default::default()
    };
    let consumed = usage_cache::for_each_marked_line_from(path, from, "token_count", |line| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
        let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
        if ts.is_empty() || v.pointer("/payload/info").is_none() {
            return;
        }
        let date = date_of(ts);
        if let Some(last) = v.pointer("/payload/info/last_token_usage") {
            let i = u64_at(last, "input_tokens");
            let o = u64_at(last, "output_tokens");
            let cr = u64_at(last, "cached_input_tokens").min(i);
            totals.days.entry(date.clone()).or_default().absorb(i, o, cr);
            if ts >= recent_floor {
                totals.absorb_recent(ts, i, o, cr);
            }
        }
        if let Some(limit) = v
            .pointer("/payload/rate_limits")
            .or_else(|| v.pointer("/payload/info/rate_limits"))
            .and_then(codex_rate_limit)
        {
            let timed = crate::usage_cache::TimedLimit {
                timestamp: ts.to_string(),
                date,
                limit_id: limit.limit_id,
                limit_name: limit.limit_name,
                used_percent: limit.used_percent,
                used_percent_weekly: limit.used_percent_weekly,
                resets_at: limit.resets_at,
                weekly_resets_at: limit.weekly_resets_at,
            };
            let newer = totals
                .rate_limits
                .get(&timed.limit_id)
                .is_none_or(|current| ts > current.timestamp.as_str());
            if newer {
                totals.rate_limits.insert(timed.limit_id.clone(), timed);
            }
        }
    });
    (totals, consumed)
}

fn visit_codex_files(
    home: &str,
    since: SystemTime,
    cache: &mut UsageScanCache,
    recent_floor: &str,
    required_recent_since: Option<&str>,
    mut telemetry: Option<&mut UsageScanTelemetry>,
    mut visit: impl FnMut(u64, &crate::usage_cache::CodexFileTotals),
) -> Vec<PathBuf> {
    let mut files = Vec::new();
    usage_cache::recent_jsonl(&Path::new(home).join(".codex/sessions"), since, &mut files);
    for f in &files {
        let stamp = FileStamp::of(f);
        match stamp {
            Some(s) => {
                let plan = required_recent_since.map_or_else(
                    || cache.codex_plan(f, s),
                    |required| cache.codex_recent_plan(f, s, required),
                );
                observe_scan_plan(&mut telemetry, plan, s);
                match plan {
                    ResumePlan::Reuse => {
                        if let Some(totals) = cache.codex_cached(f) {
                            visit(s.modified_seconds(), totals);
                        }
                    }
                    ResumePlan::Tail(from) => {
                        let (more, consumed) = parse_codex_file_from(f, from, recent_floor);
                        cache.merge_codex(f, s, usage_cache::resume_at(f, consumed), more);
                        if let Some(totals) = cache.codex_cached(f) {
                            visit(s.modified_seconds(), totals);
                        }
                        cache.enforce_capacity();
                    }
                    ResumePlan::Full => {
                        let (parsed, consumed) = parse_codex_file_from(f, 0, recent_floor);
                        visit(s.modified_seconds(), &parsed);
                        cache.put_codex(f, s, usage_cache::resume_at(f, consumed), parsed);
                        cache.enforce_capacity();
                    }
                }
            }
            None => {
                let parsed = parse_codex_file_from(f, 0, recent_floor).0;
                visit(0, &parsed);
            }
        }
    }
    files
}

fn absorb_codex_recent_file(
    total: &mut CodexAccumulator,
    per: &mut BTreeMap<CodexScope, CodexAccumulator>,
    mtime: u64,
    totals: &crate::usage_cache::CodexFileTotals,
    since_iso: &str,
    since_epoch: u64,
    bindings: &HashMap<String, ConversationCredential>,
) {
    if mtime < since_epoch {
        return;
    }
    total.sessions += 1;
    let attribution = totals.conversation_id.as_ref().and_then(|id| bindings.get(id));
    let scope = attribution.map_or(CodexScope::Unattributed, |credential| {
        CodexScope::Credential(credential.credential_id.clone())
    });
    let account = per.entry(scope).or_default();
    account.sessions += 1;
    if attribution
        .is_some_and(|credential| credential.confidence == AttributionConfidence::Committed)
    {
        account.has_committed = true;
    }
    for bucket in &totals.recent {
        if bucket.second.as_str() >= since_iso {
            total.absorb_bucket(bucket);
            account.absorb_bucket(bucket);
        }
    }
    for limit in totals.rate_limits.values() {
        if limit.timestamp.as_str() >= since_iso {
            total.absorb_timed_limit(limit);
            account.absorb_timed_limit(limit);
        }
    }
}

fn finish_codex_recent(
    total: CodexAccumulator,
    per: BTreeMap<CodexScope, CodexAccumulator>,
) -> (ProviderStats, Vec<AccountUsage>) {
    let accounts = per
        .into_iter()
        .map(|(scope, bucket)| {
            let (credential_id, attributed) = match scope {
                CodexScope::Credential(id) => (id, true),
                CodexScope::Unattributed => (None, false),
            };
            let observed_only = attributed && !bucket.has_committed;
            AccountUsage {
                credential_id,
                attributed,
                observed_only,
                usage: bucket.finish().into(),
            }
        })
        .collect();
    (total.finish(), accounts)
}

/// 설정 화면용 Codex 통계 — 캐시를 거친다.
///
/// 창 필터가 날짜 단위인 이유: 파일별 합계를 날짜로 접어 캐시하므로 그보다
/// 잘게 자를 수 없다. N일 통계에서는 경계 날짜가 통째로 포함될 뿐이고, 정확한
/// 타임스탬프 컷오프가 필요한 배지(5시간 창)는 같은 캐시의 recent projection을
/// 사용하고, 이 함수는 날짜 버킷만 사용한다.
fn codex_stats_cached(
    home: &str,
    since_date: &str,
    since: SystemTime,
    cache: &mut UsageScanCache,
) -> (ProviderStats, Vec<std::path::PathBuf>) {
    let mut stats = ProviderStats::default();
    let mut daily: BTreeMap<String, u64> = BTreeMap::new();
    let mut newest: BTreeMap<String, crate::usage_cache::TimedLimit> = BTreeMap::new();
    let (recent_floor, _, _) = recent_window(SystemTime::now(), 48);
    let files = visit_codex_files(
        home,
        since,
        cache,
        &recent_floor,
        None,
        None,
        |_, totals| {
            stats.sessions += 1;
            for (date, day) in &totals.days {
                if date.as_str() < since_date {
                    continue;
                }
                stats.input += day.input;
                stats.output += day.output;
                stats.cache_read += day.cache_read;
                stats.turns += day.turns;
                *daily.entry(date.clone()).or_default() += day.activity();
            }
            for (id, limit) in &totals.rate_limits {
                if limit.date.as_str() < since_date {
                    continue;
                }
                let is_newer = newest
                    .get(id)
                    .is_none_or(|current| limit.timestamp > current.timestamp);
                if is_newer {
                    newest.insert(id.clone(), limit.clone());
                }
            }
        },
    );

    // Codex의 input_tokens는 cached_input_tokens를 이미 포함한다 —
    // CodexAccumulator::finish와 같은 규칙으로 접는다.
    stats.total = stats.input.saturating_sub(stats.cache_read) + stats.output;
    stats.daily = daily_vec(daily);
    apply_codex_newest_limits(&newest, &mut stats);
    (stats, files)
}

/// limit_id별 최신 한도를 ProviderStats에 얹는다. 일반 Codex(limit_id="codex")는
/// 대표 %로, 모델별 예산은 rate_limits 목록으로 — 합치지 않는다.
fn apply_codex_newest_limits(
    newest: &BTreeMap<String, crate::usage_cache::TimedLimit>,
    stats: &mut ProviderStats,
) {
    for limit in newest.values() {
        let usage = CodexRateLimitUsage {
            limit_id: limit.limit_id.clone(),
            limit_name: limit.limit_name.clone(),
            used_percent: limit.used_percent,
            used_percent_weekly: limit.used_percent_weekly,
            resets_at: limit.resets_at,
            weekly_resets_at: limit.weekly_resets_at,
            credits: None,
        };
        if usage.limit_id == PRIMARY_CODEX_LIMIT_ID {
            stats.used_percent = usage.used_percent;
            stats.used_percent_weekly = usage.used_percent_weekly;
            stats.resets_at = usage.resets_at;
            stats.weekly_resets_at = usage.weekly_resets_at;
        }
        stats.rate_limits.push(usage);
    }
}

fn since_iso_for(secs_ago: u64) -> (String, SystemTime) {
    let since = SystemTime::now() - std::time::Duration::from_secs(secs_ago);
    let secs = since
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (epoch_to_iso(secs), since)
}

/// 계정별 Claude 실측 한도 — statusLine 수집기가 프로필별로 남긴 캐시.
/// 파일 이름(stem)이 프로필 키다. 이미 리셋된 창은 apply_claude_cached_rate_limits가
/// 버리므로 만료 스냅샷이 현재 창인 척하지 않는다.
fn claude_account_rate_limits(home: &str, now: u64) -> Vec<AccountRateLimit> {
    let dir = crate::app_home::app_root_under(Path::new(home)).join("usage/claude-rate-limits");
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<AccountRateLimit> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|path| {
            let key = path.file_stem()?.to_str()?.to_string();
            let content = fs::read_to_string(&path).ok()?;
            let value = serde_json::from_str::<serde_json::Value>(&content).ok()?;
            let mut stats = ProviderStats::default();
            apply_claude_cached_rate_limits(&value, now, &mut stats);
            Some(AccountRateLimit {
                profile_key: key,
                used_percent: stats.used_percent,
                used_percent_weekly: stats.used_percent_weekly,
                resets_at: stats.resets_at,
                weekly_resets_at: stats.weekly_resets_at,
                used_percent_captured_at: stats.used_percent_captured_at,
            })
        })
        .collect();
    out.sort_by(|a, b| a.profile_key.cmp(&b.profile_key));
    out
}

fn epoch_seconds(time: SystemTime) -> u64 {
    time
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    epoch_seconds(SystemTime::now())
}

fn recent_window(now: SystemTime, hours: u64) -> (String, SystemTime, u64) {
    let since = now - std::time::Duration::from_secs(hours * 3600);
    let epoch = epoch_seconds(since);
    (epoch_to_iso(epoch), since, epoch)
}

fn usage_report(
    home: &str,
    now_epoch: u64,
    claude: ProviderStats,
    codex: ProviderStats,
    codex_accounts: Vec<AccountUsage>,
) -> UsageReport {
    UsageReport {
        claude: claude.into(),
        codex: codex.into(),
        claude_accounts: claude_account_rate_limits(home, now_epoch),
        codex_accounts,
        codex_account_snapshots: Vec::new(),
    }
}

pub fn usage_recent_snapshot() -> UsageRecentSnapshot {
    let home = std::env::var("HOME").unwrap_or_default();
    let now = SystemTime::now();
    let bindings = crate::session_credentials::conversation_credentials("codex");
    usage_recent_snapshot_at(&home, now, &bindings)
}

fn usage_recent_snapshot_at(
    home: &str,
    now: SystemTime,
    bindings: &HashMap<String, ConversationCredential>,
) -> UsageRecentSnapshot {
    let started = Instant::now();
    let now_epoch = epoch_seconds(now);
    let (since_5_iso, _, since_5_epoch) = recent_window(now, 5);
    let (since_24_iso, since_24, since_24_epoch) = recent_window(now, 24);
    // Exact 24h windows need raw timestamps only near the moving boundary. Keep
    // 48h so a backwards wall-clock correction cannot expose a pruned boundary;
    // older events remain represented by the existing exact daily buckets.
    let (compact_before, _, _) = recent_window(now, 48);
    let mut snapshot = crate::usage_cache_runtime::with_cache(home, |cache| {
        let mut telemetry = UsageScanTelemetry::default();
        let mut five_claude = ClaudeAccumulator::default();
        let mut day_claude = ClaudeAccumulator::default();
        visit_claude_files(
            home,
            since_24,
            Some(&mut *cache),
            Some(&mut telemetry),
            |mtime, records| {
                five_claude.absorb_file(mtime, records, &since_5_iso, since_5_epoch);
                day_claude.absorb_file(mtime, records, &since_24_iso, since_24_epoch);
            },
        );
        cache.compact_codex_recent_before(&compact_before);

        let mut five_total = CodexAccumulator::default();
        let mut five_per = BTreeMap::new();
        let mut day_total = CodexAccumulator::default();
        let mut day_per = BTreeMap::new();
        visit_codex_files(
            home,
            since_24,
            &mut *cache,
            &compact_before,
            Some(&since_24_iso),
            Some(&mut telemetry),
            |mtime, totals| {
                absorb_codex_recent_file(
                    &mut five_total,
                    &mut five_per,
                    mtime,
                    totals,
                    &since_5_iso,
                    since_5_epoch,
                    bindings,
                );
                absorb_codex_recent_file(
                    &mut day_total,
                    &mut day_per,
                    mtime,
                    totals,
                    &since_24_iso,
                    since_24_epoch,
                    bindings,
                );
            },
        );
        let five_claude = five_claude.finish(home, now_epoch);
        let day_claude = day_claude.finish(home, now_epoch);
        let (five_codex, five_accounts) = finish_codex_recent(five_total, five_per);
        let (day_codex, day_accounts) = finish_codex_recent(day_total, day_per);

        let five_hours = usage_report(
            home,
            now_epoch,
            five_claude,
            five_codex,
            five_accounts,
        );
        let twenty_four_hours = usage_report(
            home,
            now_epoch,
            day_claude,
            day_codex,
            day_accounts,
        );
        UsageRecentSnapshot { five_hours, twenty_four_hours, telemetry }
    });
    snapshot.telemetry.scan_duration_ms =
        started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    snapshot
}

/// 최근 N시간 사용량 (DesktopBar 배지용 — 시그니처 유지).
pub fn usage_recent(hours: u64) -> UsageReport {
    if hours == 5 || hours == 24 {
        let snapshot = usage_recent_snapshot();
        return if hours == 5 { snapshot.five_hours } else { snapshot.twenty_four_hours };
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let (since_iso, since) = since_iso_for(hours * 3600);
    let bindings = crate::session_credentials::conversation_credentials("codex");
    let (codex, codex_accounts) = codex_stats_split(&home, &since_iso, since, &bindings);
    UsageReport {
        claude: claude_stats(&home, &since_iso, since, None).into(),
        codex: codex.into(),
        claude_accounts: claude_account_rate_limits(&home, now_secs()),
        codex_accounts,
        codex_account_snapshots: Vec::new(),
    }
}

/// 최근 N일 통계 (설정 '통계 및 사용량' 페이지용 — 세션·턴·일별 포함).
///
/// 파일 단위 캐시를 거친다. 첫 스캔은 예전과 같은 비용이고, 이후에는 바뀐
/// 파일만 다시 읽는다 — 이 머신 실측으로 42일 창이 6,438개 파일 3.86GB였다.
pub fn usage_stats(days: u64) -> UsageStats {
    let home = std::env::var("HOME").unwrap_or_default();
    let (since_iso, since) = since_iso_for(days * 86400);
    let since_date = date_of(&since_iso);
    crate::usage_cache_runtime::with_cache(&home, |cache| {
        let claude = claude_stats(&home, &since_iso, since, Some(&mut *cache));
        let (codex, codex_files) =
            codex_stats_cached(&home, &since_date, since, &mut *cache);

        let mut claude_files = Vec::new();
        usage_cache::recent_jsonl(
            &Path::new(&home).join(".claude/projects"),
            since,
            &mut claude_files,
        );
        cache.retain_seen(&claude_files, &codex_files);

        UsageStats { claude, codex }
    })
}

/// epoch → "YYYY-MM-DDTHH:MM:SS" (UTC). 문자열 비교용.
fn epoch_to_iso(secs: u64) -> String {
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil_from_days (Howard Hinnant 알고리즘)
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nested_primary_5h_secondary_weekly() {
        let rl = json!({
            "primary": {"used_percent": 2.0, "window_minutes": 300, "resets_at": 111},
            "secondary": {"used_percent": 6.0, "window_minutes": 10080, "resets_at": 222},
        });
        let mut r = ProviderStats::default();
        apply_rate_limits(&rl, &mut r);
        assert_eq!(r.used_percent, Some(2.0));
        assert_eq!(r.resets_at, Some(111));
        assert_eq!(r.used_percent_weekly, Some(6.0));
        assert_eq!(r.weekly_resets_at, Some(222));
    }

    #[test]
    fn weekly_only_session_leaves_5h_empty() {
        // 최신 세션 형태: primary가 weekly, secondary=null.
        let rl = json!({
            "primary": {"used_percent": 38.0, "window_minutes": 10080, "resets_at": 999},
            "secondary": serde_json::Value::Null,
        });
        let mut r = ProviderStats::default();
        apply_rate_limits(&rl, &mut r);
        assert_eq!(r.used_percent, None);
        assert_eq!(r.resets_at, None);
        assert_eq!(r.used_percent_weekly, Some(38.0));
        assert_eq!(r.weekly_resets_at, Some(999));
    }

    #[test]
    fn claude_cache_applies_live_windows() {
        let v = json!({
            "captured_at": 1000,
            "rate_limits": {
                "five_hour": {"used_percentage": 23.5, "resets_at": 5000},
                "seven_day": {"used_percentage": 41.2, "resets_at": 9000},
            },
        });
        let mut r = ProviderStats::default();
        apply_claude_cached_rate_limits(&v, 2000, &mut r);
        assert_eq!(r.used_percent, Some(23.5));
        assert_eq!(r.resets_at, Some(5000));
        assert_eq!(r.used_percent_weekly, Some(41.2));
        assert_eq!(r.weekly_resets_at, Some(9000));
        assert_eq!(r.used_percent_captured_at, Some(1000));
    }

    #[test]
    fn claude_cache_drops_reset_window_keeps_live_one() {
        // 5h 창은 이미 리셋됨(now >= resets_at) — 주간만 살아 있다.
        let v = json!({
            "captured_at": 1000,
            "rate_limits": {
                "five_hour": {"used_percentage": 90.0, "resets_at": 1500},
                "seven_day": {"used_percentage": 41.2, "resets_at": 9000},
            },
        });
        let mut r = ProviderStats::default();
        apply_claude_cached_rate_limits(&v, 2000, &mut r);
        assert_eq!(r.used_percent, None);
        assert_eq!(r.resets_at, None);
        assert_eq!(r.used_percent_weekly, Some(41.2));
        assert_eq!(r.used_percent_captured_at, Some(1000));
    }

    #[test]
    fn claude_cache_fully_expired_leaves_stats_untouched() {
        let v = json!({
            "captured_at": 1000,
            "rate_limits": {
                "five_hour": {"used_percentage": 90.0, "resets_at": 1500},
            },
        });
        let mut r = ProviderStats::default();
        apply_claude_cached_rate_limits(&v, 9999, &mut r);
        assert_eq!(r.used_percent, None);
        assert_eq!(r.used_percent_captured_at, None);
    }

    #[test]
    fn claude_cache_ignores_malformed_windows() {
        let v = json!({
            "rate_limits": {
                "five_hour": {"used_percentage": "many"},
                "seven_day": {"resets_at": 9000},
            },
        });
        let mut r = ProviderStats::default();
        apply_claude_cached_rate_limits(&v, 2000, &mut r);
        assert_eq!(r.used_percent, None);
        assert_eq!(r.used_percent_weekly, None);
        assert_eq!(r.used_percent_captured_at, None);
    }

    #[test]
    fn legacy_flat_shape_falls_back() {
        let rl = json!({"primary_used_percent": 12.5, "secondary_used_percent": 40.0});
        let mut r = ProviderStats::default();
        apply_rate_limits(&rl, &mut r);
        assert_eq!(r.used_percent, Some(12.5));
        assert_eq!(r.used_percent_weekly, Some(40.0));
        assert_eq!(r.resets_at, None);
    }

    fn rollout(dir: &Path, conversation: &str, lines: &[String]) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(format!("rollout-2026-07-29T02-02-09-{conversation}.jsonl"));
        let meta = json!({
            "timestamp": "2026-07-29T02:02:09.000Z",
            "type": "session_meta",
            "payload": {"session_id": conversation, "cwd": "/tmp"},
        })
        .to_string();
        let body = std::iter::once(meta).chain(lines.iter().cloned()).collect::<Vec<_>>();
        // 실제 기록기와 같게 개행으로 끝낸다.
        std::fs::write(&path, format!("{}\n", body.join("\n"))).unwrap();
        path
    }

    /// 42일 창을 넘는 과거를 포함해 넉넉히 잡은 컷오프 — 픽스처 레코드가
    /// 모두 창 안에 들도록.
    /// 실제 HOME의 로그로 캐시 효과를 재는 측정용 테스트. 머신의 로그 양에
    /// 의존하므로 CI에서 돌리지 않는다(#[ignore]) — 증거가 필요할 때 수동으로:
    ///   cargo test --lib usage::tests::measure_usage_stats -- --ignored --nocapture
    #[test]
    #[ignore = "실제 HOME 로그에 의존하는 측정용"]
    fn measure_usage_stats_cache_payoff() {
        let home = std::env::var("HOME").unwrap_or_default();
        let cache = crate::usage_cache::cache_path(&home);
        let _ = std::fs::remove_file(&cache);

        let days: u64 = std::env::var("HEBBIAN_BENCH_DAYS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(42);

        let t0 = std::time::Instant::now();
        let cold = usage_stats(days);
        let cold_ms = t0.elapsed().as_millis();

        let t1 = std::time::Instant::now();
        let warm = usage_stats(days);
        let warm_ms = t1.elapsed().as_millis();

        // 3회차 — 2회차가 느리다면 그건 캐시가 아니라 "1회차 도중에 바뀐
        // 파일을 다시 읽는" 비용이다. 정상 상태를 따로 재야 구별된다.
        let t2 = std::time::Instant::now();
        let steady = usage_stats(days);
        let steady_ms = t2.elapsed().as_millis();
        println!("steady={steady_ms}ms steady_total={}", steady.claude.total + steady.codex.total);


        let cache_bytes = std::fs::metadata(&cache).map(|m| m.len()).unwrap_or(0);
        println!(
            "days={days} cold={cold_ms}ms warm={warm_ms}ms cache={cache_bytes}B claude_sessions={} codex_sessions={}",
            cold.claude.sessions, cold.codex.sessions,
        );
        println!(
            "claude total cold={} warm={} / codex total cold={} warm={}",
            cold.claude.total, warm.claude.total, cold.codex.total, warm.codex.total,
        );

        // 등가성은 여기서 검증하지 않는다. 실제 HOME은 살아 있어서 두 측정
        // 사이에 에이전트가 로그를 더 쓴다 — 실측에서 cold 90초 동안 Claude
        // 합계가 2.1M 토큰 늘었다. 캐시가 숫자를 바꾸지 않는다는 것은 픽스처
        // 기반 claude_cache_does_not_change_the_numbers 등이 결정적으로 증명한다.
        // 여기서 지킬 수 있는 불변식은 "로그는 줄지 않는다"뿐이다.
        assert!(
            warm.claude.total >= cold.claude.total,
            "따뜻한 스캔이 더 적게 셌다 — 캐시가 기존 레코드를 잃었다는 뜻",
        );
        assert!(warm.codex.total >= cold.codex.total);
        assert!(warm.claude.turns >= cold.claude.turns);
        assert!(warm_ms < cold_ms, "캐시가 스캔을 더 느리게 만들었다");
    }

    fn token_count_line(ts: &str, input: u64, output: u64, cached: u64) -> String {
        json!({
            "timestamp": ts,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {"last_token_usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cached_input_tokens": cached,
                }},
            },
        })
        .to_string()
    }

    #[test]
    fn recent_snapshot_scans_once_for_exact_5h_and_24h_windows_then_tails() {
        use std::io::Write as _;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let now = SystemTime::now();
        let now_epoch = epoch_seconds(now);
        let old = format!("{}Z", epoch_to_iso(now_epoch - 6 * 3600));
        let recent = format!("{}Z", epoch_to_iso(now_epoch - 2 * 3600));
        let appended = format!("{}Z", epoch_to_iso(now_epoch - 3600));
        let sessions = home.join(".codex/sessions/2026/08/06");
        let codex = rollout(
            &sessions,
            "019fbd88-d82c-78e0-8e29-e436f63ca126",
            &[
                token_count_line(&old, 100, 0, 0),
                token_count_line(&recent, 20, 0, 0),
            ],
        );
        write_claude_session(
            home,
            "recent.jsonl",
            &[
                claude_line(Some("old"), &old, 10, 0),
                claude_line(Some("recent"), &recent, 5, 0),
            ],
        );
        let home = home.to_str().unwrap();

        let cold = usage_recent_snapshot_at(home, now, &HashMap::new());
        assert_eq!(cold.five_hours.codex.input, 20);
        assert_eq!(cold.twenty_four_hours.codex.input, 120);
        assert_eq!(cold.five_hours.claude.input, 5);
        assert_eq!(cold.twenty_four_hours.claude.input, 15);
        assert_eq!(cold.telemetry.full_scans, 2);
        assert!(cold.telemetry.bytes_read > 0);

        let warm = usage_recent_snapshot_at(home, now, &HashMap::new());
        assert_eq!(warm.five_hours.codex.input, 20);
        assert_eq!(warm.twenty_four_hours.codex.input, 120);
        assert_eq!(warm.telemetry.cache_hits, 2);
        assert_eq!(warm.telemetry.bytes_read, 0);

        let mut file = std::fs::OpenOptions::new().append(true).open(codex).unwrap();
        writeln!(file, "{}", token_count_line(&appended, 7, 0, 0)).unwrap();
        let tailed = usage_recent_snapshot_at(home, now, &HashMap::new());
        assert_eq!(tailed.five_hours.codex.input, 27);
        assert_eq!(tailed.twenty_four_hours.codex.input, 127);
        assert_eq!(tailed.telemetry.incremental_hits, 1);
        assert_eq!(tailed.telemetry.cache_hits, 1);
        assert!(tailed.telemetry.bytes_read < cold.telemetry.bytes_read);
    }

    #[test]
    fn recent_cache_coalesces_n_to_twice_n_events_without_changing_totals() {
        use std::io::Write as _;

        const N: u64 = 512;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let now = SystemTime::now();
        let timestamp = format!("{}Z", epoch_to_iso(epoch_seconds(now) - 3600));
        let sessions = home.join(".codex/sessions/2026/08/06");
        let initial = (0..N)
            .map(|_| token_count_line(&timestamp, 1, 0, 0))
            .collect::<Vec<_>>();
        let codex = rollout(
            &sessions,
            "019fbd88-d82c-78e0-8e29-e436f63ca127",
            &initial,
        );
        let home = home.to_str().unwrap();

        let first = usage_recent_snapshot_at(home, now, &HashMap::new());
        let first_retained = crate::usage_cache_runtime::with_cache(home, |cache| {
            let recent = &cache.codex_cached(&codex).unwrap().recent;
            (
                recent.len(),
                recent.capacity(),
                serde_json::to_vec(cache).unwrap().len(),
                recent[0].turns,
            )
        });
        assert_eq!(first.five_hours.codex.input, N);
        assert_eq!(first.five_hours.codex_accounts[0].usage.input, N);

        let mut file = std::fs::OpenOptions::new().append(true).open(&codex).unwrap();
        for _ in 0..N {
            writeln!(file, "{}", token_count_line(&timestamp, 2, 0, 0)).unwrap();
        }
        let twice_n = usage_recent_snapshot_at(home, now, &HashMap::new());
        let twice_n_retained = crate::usage_cache_runtime::with_cache(home, |cache| {
            let recent = &cache.codex_cached(&codex).unwrap().recent;
            (
                recent.len(),
                recent.capacity(),
                serde_json::to_vec(cache).unwrap().len(),
                recent[0].turns,
            )
        });

        assert_eq!(twice_n.five_hours.codex.input, N * 3);
        assert_eq!(twice_n.twenty_four_hours.codex.input, N * 3);
        assert_eq!(twice_n.five_hours.codex_accounts[0].usage.input, N * 3);
        assert_eq!(first_retained.0, 1);
        assert_eq!(twice_n_retained.0, 1);
        assert!(twice_n_retained.1 <= first_retained.1 + 1);
        assert!(twice_n_retained.2 <= first_retained.2 + 4_096);
        assert_eq!(first_retained.3, N);
        assert_eq!(twice_n_retained.3, N * 2);
    }

    const WIDE_SINCE: &str = "2000-01-01T00:00:00";

    fn wide_since_time() -> SystemTime {
        SystemTime::UNIX_EPOCH
    }

    fn claude_line(id: Option<&str>, ts: &str, input: u64, output: u64) -> String {
        let mut message = json!({ "usage": { "input_tokens": input, "output_tokens": output } });
        if let Some(id) = id {
            message["id"] = json!(id);
        }
        json!({ "timestamp": ts, "message": message }).to_string()
    }

    /// 실제 기록기처럼 줄마다 개행으로 끝낸다 — 표본 50개 전부 그렇다.
    /// 개행 없는 꼬리는 '아직 쓰이는 중'이라 레코드로 세지 않는다.
    fn write_claude_session(home: &Path, name: &str, lines: &[String]) {
        let dir = home.join(".claude/projects/proj");
        std::fs::create_dir_all(&dir).unwrap();
        let mut body = lines.join("\n");
        if !body.is_empty() {
            body.push('\n');
        }
        std::fs::write(dir.join(name), body).unwrap();
    }

    /// 캐시는 성능 장치일 뿐 두 번째 구현이 아니다. 같은 입력에 대해 캐시
    /// 없음 / 차가운 캐시 / 따뜻한 캐시가 모두 같은 숫자를 내야 한다.
    #[test]
    fn claude_cache_does_not_change_the_numbers() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_claude_session(
            home,
            "a.jsonl",
            &[
                claude_line(Some("msg_1"), "2026-07-29T01:00:00.000Z", 10, 5),
                claude_line(Some("msg_2"), "2026-07-29T02:00:00.000Z", 20, 7),
                claude_line(None, "2026-07-29T03:00:00.000Z", 1, 1),
            ],
        );
        let home_str = home.to_str().unwrap();

        let uncached = claude_stats(home_str, WIDE_SINCE, wide_since_time(), None);

        let mut cache = UsageScanCache::load(home_str);
        let cold = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        let warm = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));

        for (label, got) in [("cold", &cold), ("warm", &warm)] {
            assert_eq!(got.input, uncached.input, "{label} input");
            assert_eq!(got.output, uncached.output, "{label} output");
            assert_eq!(got.total, uncached.total, "{label} total");
            assert_eq!(got.turns, uncached.turns, "{label} turns");
            assert_eq!(got.sessions, uncached.sessions, "{label} sessions");
        }
        assert_eq!(uncached.input, 31);
        assert_eq!(uncached.turns, 3);
    }

    /// 재개한 대화는 이전 메시지를 새 파일에 복사한다. message.id 중복 제거는
    /// **파일을 가로질러** 동작해야 하고, 캐시가 그 성질을 깨면 안 된다.
    #[test]
    fn claude_cache_preserves_cross_file_dedup() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let shared = claude_line(Some("msg_shared"), "2026-07-29T01:00:00.000Z", 100, 10);
        write_claude_session(home, "a.jsonl", std::slice::from_ref(&shared));
        write_claude_session(home, "b.jsonl", std::slice::from_ref(&shared));
        let home_str = home.to_str().unwrap();

        let mut cache = UsageScanCache::load(home_str);
        let cold = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        let warm = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));

        assert_eq!(cold.turns, 1, "같은 message.id는 파일이 달라도 한 번만 센다");
        assert_eq!(cold.input, 100);
        assert_eq!(warm.turns, cold.turns, "따뜻한 캐시에서도 중복 제거가 유지돼야 한다");
        assert_eq!(warm.input, cold.input);
    }

    /// 파일이 자라면 지문이 달라지므로 새 줄이 반영돼야 한다 — 캐시가 낡은
    /// 값을 계속 내놓으면 사용량이 영원히 멈춘다.
    #[test]
    fn claude_cache_picks_up_appended_lines() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_claude_session(
            home,
            "a.jsonl",
            &[claude_line(Some("msg_1"), "2026-07-29T01:00:00.000Z", 10, 0)],
        );
        let home_str = home.to_str().unwrap();
        let mut cache = UsageScanCache::load(home_str);
        let before = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        assert_eq!(before.input, 10);

        write_claude_session(
            home,
            "a.jsonl",
            &[
                claude_line(Some("msg_1"), "2026-07-29T01:00:00.000Z", 10, 0),
                claude_line(Some("msg_2"), "2026-07-29T04:00:00.000Z", 40, 0),
            ],
        );
        let after = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        assert_eq!(after.input, 50, "덧붙은 줄이 반영돼야 한다");
    }

    /// 창 필터는 캐시가 아니라 읽는 쪽이 건다 — 같은 캐시로 좁은 창을 물으면
    /// 좁은 답이 나와야 한다(배지 5시간 창이 이 성질에 의존한다).
    #[test]
    fn claude_cache_is_window_independent() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_claude_session(
            home,
            "a.jsonl",
            &[
                claude_line(Some("old"), "2026-07-01T00:00:00.000Z", 10, 0),
                claude_line(Some("new"), "2026-07-29T00:00:00.000Z", 5, 0),
            ],
        );
        let home_str = home.to_str().unwrap();
        let mut cache = UsageScanCache::load(home_str);

        let wide = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        let narrow = claude_stats(home_str, "2026-07-15T00:00:00", wide_since_time(), Some(&mut cache));

        assert_eq!(wide.input, 15);
        assert_eq!(narrow.input, 5, "좁은 창은 캐시가 있어도 좁아야 한다");
    }

    /// 꼬리만 읽어도 전체 재파싱과 같은 숫자가 나와야 한다. 여기가 틀리면
    /// 사용량이 조용히 새거나 부풀어도 아무도 모른다.
    #[test]
    fn claude_tail_resume_matches_a_full_reparse() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let home_str = home.to_str().unwrap();
        write_claude_session(
            home,
            "a.jsonl",
            &[claude_line(Some("m1"), "2026-07-29T01:00:00.000Z", 10, 1)],
        );

        let mut cache = UsageScanCache::load(home_str);
        let first = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        assert_eq!(first.input, 10);

        // 세션이 이어지며 두 줄이 덧붙는다.
        write_claude_session(
            home,
            "a.jsonl",
            &[
                claude_line(Some("m1"), "2026-07-29T01:00:00.000Z", 10, 1),
                claude_line(Some("m2"), "2026-07-29T02:00:00.000Z", 20, 2),
                claude_line(None, "2026-07-29T03:00:00.000Z", 5, 3),
            ],
        );

        let tailed = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        let full = claude_stats(home_str, WIDE_SINCE, wide_since_time(), None);

        assert_eq!(tailed.input, full.input, "input");
        assert_eq!(tailed.output, full.output, "output");
        assert_eq!(tailed.turns, full.turns, "turns");
        assert_eq!(tailed.total, full.total, "total");
        assert_eq!(full.input, 35);
    }

    /// 같은 파일을 두 번 스캔해도 덧붙은 게 없으면 숫자가 그대로여야 한다 —
    /// 꼬리 오프셋이 잘못 전진/후퇴하면 여기서 드러난다.
    #[test]
    fn claude_repeated_scans_do_not_drift() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let home_str = home.to_str().unwrap();
        write_claude_session(
            home,
            "a.jsonl",
            &[
                claude_line(None, "2026-07-29T01:00:00.000Z", 7, 1),
                claude_line(None, "2026-07-29T02:00:00.000Z", 9, 2),
            ],
        );
        let mut cache = UsageScanCache::load(home_str);
        let a = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        let b = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        let c = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        assert_eq!((a.input, a.turns), (16, 2));
        assert_eq!((b.input, b.turns), (a.input, a.turns));
        assert_eq!((c.input, c.turns), (a.input, a.turns));
    }

    /// 파일이 잘리거나 다른 내용으로 갈아엎이면 꼬리를 이어 붙이면 안 된다.
    /// 이어 붙이면 사라진 사용량이 계속 남는다.
    #[test]
    fn claude_rewritten_file_falls_back_to_a_full_reparse() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let home_str = home.to_str().unwrap();
        write_claude_session(
            home,
            "a.jsonl",
            &[
                claude_line(None, "2026-07-29T01:00:00.000Z", 100, 1),
                claude_line(None, "2026-07-29T02:00:00.000Z", 100, 1),
            ],
        );
        let mut cache = UsageScanCache::load(home_str);
        let before = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        assert_eq!(before.input, 200);

        // 회전: 같은 이름에 완전히 다른(더 짧은) 내용이 들어앉았다.
        write_claude_session(
            home,
            "a.jsonl",
            &[claude_line(None, "2026-07-30T01:00:00.000Z", 3, 1)],
        );

        let after = claude_stats(home_str, WIDE_SINCE, wide_since_time(), Some(&mut cache));
        assert_eq!(after.input, 3, "사라진 200 토큰이 남아 있으면 안 된다");
    }

    /// Codex는 합계를 더하는 구조라 꼬리를 잘못 다루면 곧바로 이중 계상이 된다.
    #[test]
    fn codex_tail_resume_matches_a_full_reparse() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let home_str = home.to_str().unwrap();
        let sessions = home.join(".codex/sessions/2026/07/29");
        let conv = "019fa9ad-38dd-7263-9554-7faf5ca228c1";
        let first_line = token_count_line("2026-07-29T03:00:00.000Z", 100, 30, 40);
        let path = rollout(&sessions, conv, std::slice::from_ref(&first_line));

        let mut cache = UsageScanCache::load(home_str);
        let (first, _) = codex_stats_cached(home_str, "2000-01-01", wide_since_time(), &mut cache);
        assert_eq!(first.turns, 1);

        // 같은 파일에 이벤트가 덧붙는다.
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push('\n');
        body.push_str(&token_count_line("2026-07-29T04:00:00.000Z", 50, 10, 0));
        body.push('\n');
        std::fs::write(&path, body).unwrap();

        let (tailed, _) = codex_stats_cached(home_str, "2000-01-01", wide_since_time(), &mut cache);
        let full = codex_stats(home_str, WIDE_SINCE, wide_since_time());

        assert_eq!(tailed.input, full.input, "input");
        assert_eq!(tailed.output, full.output, "output");
        assert_eq!(tailed.cache_read, full.cache_read, "cache_read");
        assert_eq!(tailed.turns, full.turns, "turns");
        assert_eq!(tailed.total, full.total, "total");
        assert_eq!(full.turns, 2);
    }

    /// 쓰이는 도중의 반 토막 줄은 완성될 때까지 세지 않고, 완성되면 정확히
    /// 한 번만 센다.
    #[test]
    fn codex_half_written_line_is_counted_once_when_completed() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let home_str = home.to_str().unwrap();
        let sessions = home.join(".codex/sessions/2026/07/29");
        let conv = "019fa9ad-38dd-7263-9554-7faf5ca228c2";
        let full_line = token_count_line("2026-07-29T03:00:00.000Z", 100, 30, 0);
        let path = rollout(&sessions, conv, std::slice::from_ref(&full_line));

        // 두 번째 이벤트가 반만 쓰였다.
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push('\n');
        let half = token_count_line("2026-07-29T04:00:00.000Z", 70, 7, 0);
        body.push_str(&half[..half.len() / 2]);
        std::fs::write(&path, &body).unwrap();

        let mut cache = UsageScanCache::load(home_str);
        let (partial, _) = codex_stats_cached(home_str, "2000-01-01", wide_since_time(), &mut cache);
        assert_eq!(partial.turns, 1, "미완결 줄을 세면 안 된다");

        // 기록기가 줄을 마저 쓴다.
        let mut done = std::fs::read_to_string(&path).unwrap();
        done.truncate(done.len() - half.len() / 2);
        done.push_str(&half);
        done.push('\n');
        std::fs::write(&path, done).unwrap();

        let (complete, _) = codex_stats_cached(home_str, "2000-01-01", wide_since_time(), &mut cache);
        assert_eq!(complete.turns, 2, "완성된 줄은 정확히 한 번 세야 한다");
        assert_eq!(complete.input, 170);
    }

    /// Codex 캐시 경로가 대조군(codex_stats)과 같은 합계를 내야 한다.
    #[test]
    fn codex_cache_matches_the_uncached_path() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let sessions = home.join(".codex/sessions/2026/07/29");
        rollout(
            &sessions,
            "019fa9ad-38dd-7263-9554-7faf5ca228c1",
            &[
                token_count_line("2026-07-29T03:00:00.000Z", 100, 30, 40),
                token_count_line("2026-07-29T04:00:00.000Z", 50, 10, 0),
            ],
        );
        let home_str = home.to_str().unwrap();

        let uncached = codex_stats(home_str, WIDE_SINCE, wide_since_time());
        let mut cache = UsageScanCache::load(home_str);
        let (cold, _) = codex_stats_cached(home_str, "2000-01-01", wide_since_time(), &mut cache);
        let (warm, _) = codex_stats_cached(home_str, "2000-01-01", wide_since_time(), &mut cache);

        for (label, got) in [("cold", &cold), ("warm", &warm)] {
            assert_eq!(got.input, uncached.input, "{label} input");
            assert_eq!(got.output, uncached.output, "{label} output");
            assert_eq!(got.cache_read, uncached.cache_read, "{label} cache_read");
            assert_eq!(got.total, uncached.total, "{label} total");
            assert_eq!(got.turns, uncached.turns, "{label} turns");
        }
    }

    fn committed(id: &str) -> ConversationCredential {
        ConversationCredential {
            credential_id: Some(id.to_string()),
            confidence: AttributionConfidence::Committed,
        }
    }

    fn observed(id: &str) -> ConversationCredential {
        ConversationCredential {
            credential_id: Some(id.to_string()),
            confidence: AttributionConfidence::Observed,
        }
    }

    fn token_count(ts: &str, input: u64, output: u64, pct: f64) -> String {
        json!({
            "timestamp": ts,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {"last_token_usage": {"input_tokens": input, "output_tokens": output}},
                "rate_limits": {"primary": {"used_percent": pct, "window_minutes": 300, "resets_at": 9_999_999_999u64}},
            },
        })
        .to_string()
    }

    #[test]
    fn codex_cached_input_is_a_subset_of_activity_and_daily_totals() {
        let mut accumulator = CodexAccumulator::default();
        accumulator.absorb(
            &json!({
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 1_000,
                            "output_tokens": 50,
                            "cached_input_tokens": 900,
                        },
                    },
                },
            }),
            "2026-07-29T03:00:00.000Z",
        );

        let stats = accumulator.finish();
        assert_eq!(stats.input, 1_000);
        assert_eq!(stats.cache_read, 900);
        assert_eq!(stats.output, 50);
        assert_eq!(stats.total, 150);
        assert_eq!(stats.daily.len(), 1);
        assert_eq!(stats.daily[0].total, 150);
    }

    #[test]
    fn codex_cached_input_cannot_exceed_its_containing_input() {
        let mut accumulator = CodexAccumulator::default();
        accumulator.absorb(
            &json!({
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 100,
                            "output_tokens": 20,
                            "cached_input_tokens": 500,
                        },
                    },
                },
            }),
            "2026-07-29T03:00:00.000Z",
        );

        let stats = accumulator.finish();
        assert_eq!(stats.input, 100);
        assert_eq!(stats.cache_read, 100);
        assert_eq!(stats.total, 20);
        assert_eq!(stats.daily[0].total, 20);
    }

    #[test]
    fn codex_model_specific_limit_does_not_overwrite_general_limit() {
        let mut accumulator = CodexAccumulator::default();
        accumulator.absorb(
            &json!({
                "payload": {
                    "info": {},
                    "rate_limits": {
                        "limit_id": "codex",
                        "primary": {"used_percent": 12.0, "window_minutes": 300, "resets_at": 111},
                        "secondary": {"used_percent": 34.0, "window_minutes": 10080, "resets_at": 222},
                    },
                },
            }),
            "2026-07-29T03:00:00.000Z",
        );
        accumulator.absorb(
            &json!({
                "payload": {
                    "info": {},
                    "rate_limits": {
                        "limit_id": "codex_bengalfox",
                        "limit_name": "GPT-5.3-Codex-Spark",
                        "primary": {"used_percent": 77.0, "window_minutes": 300, "resets_at": 333},
                        "secondary": {"used_percent": 81.0, "window_minutes": 10080, "resets_at": 444},
                    },
                },
            }),
            "2026-07-29T03:05:00.000Z",
        );

        let stats = accumulator.finish();
        assert_eq!(stats.used_percent, Some(12.0));
        assert_eq!(stats.used_percent_weekly, Some(34.0));
        assert_eq!(stats.rate_limits.len(), 2);
        let spark = stats
            .rate_limits
            .iter()
            .find(|limit| limit.limit_id == "codex_bengalfox")
            .expect("separate Spark limit");
        assert_eq!(spark.limit_name.as_deref(), Some("GPT-5.3-Codex-Spark"));
        assert_eq!(spark.used_percent, Some(77.0));
        assert_eq!(spark.used_percent_weekly, Some(81.0));
    }

    #[test]
    fn codex_conversation_id_prefers_session_meta_over_file_name() {
        let temp = tempfile::tempdir().unwrap();
        let path = rollout(temp.path(), "019fa9ad-38dd-7263-9554-7faf5ca228c1", &[]);
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            codex_conversation_id(&content, &path).as_deref(),
            Some("019fa9ad-38dd-7263-9554-7faf5ca228c1"),
        );
    }

    #[test]
    fn codex_conversation_id_falls_back_to_rollout_file_name() {
        let path = Path::new("/x/rollout-2026-07-29T02-02-09-019fa9ad-38dd-7263-9554-7faf5ca228c1.jsonl");
        assert_eq!(
            codex_conversation_id("{}\n", path).as_deref(),
            Some("019fa9ad-38dd-7263-9554-7faf5ca228c1"),
        );
    }

    /// 저널 바인딩이 있는 세션만 그 credential로 간다. 바인딩 없는 세션은
    /// 기본 credential이 아니라 별도 '미분류' 묶음이어야 한다 — 활성 계정
    /// 것으로 세면 지어낸 귀속이 된다.
    #[test]
    fn codex_split_attributes_only_journal_bound_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join(".codex/sessions/2026/07/29");
        rollout(
            &sessions,
            "019fa9ad-38dd-7263-9554-7faf5ca228c1",
            &[token_count("2026-07-29T03:00:00.000Z", 100, 20, 12.0)],
        );
        rollout(
            &sessions,
            "019fa9ad-38dd-7263-9554-7faf5ca228c2",
            &[token_count("2026-07-29T03:05:00.000Z", 7, 3, 44.0)],
        );
        let bindings = HashMap::from([(
            "019fa9ad-38dd-7263-9554-7faf5ca228c1".to_string(),
            committed("acct-a"),
        )]);

        let (total, accounts) = codex_stats_split(
            temp.path().to_str().unwrap(),
            "2026-07-01T00:00:00",
            SystemTime::UNIX_EPOCH,
            &bindings,
        );

        assert_eq!(total.input, 107);
        assert_eq!(total.output, 23);
        let bound = accounts.iter().find(|a| a.attributed).expect("bound bucket");
        assert_eq!(bound.credential_id.as_deref(), Some("acct-a"));
        assert_eq!(bound.usage.input, 100);
        assert_eq!(bound.usage.used_percent, Some(12.0));
        assert!(!bound.observed_only, "generation을 만든 launch는 증명된 귀속이다");
        let loose = accounts.iter().find(|a| !a.attributed).expect("unattributed bucket");
        assert_eq!(loose.credential_id, None);
        assert_eq!(loose.usage.input, 7);
        assert_eq!(loose.usage.used_percent, Some(44.0));
    }

    /// 재부착만 있는 장수 세션(codex-crispy 사례): generation을 다시 만들지
    /// 않으니 증명은 영영 없다. 그래도 계정은 잡히되 근거 등급을 표시한다.
    #[test]
    fn codex_split_keeps_observed_only_sessions_labelled() {
        let temp = tempfile::tempdir().unwrap();
        rollout(
            &temp.path().join(".codex/sessions/2026/07/29"),
            "019fa9b6-9907-70f2-877b-5f07907bd2ba",
            &[token_count("2026-07-29T03:00:00.000Z", 40, 8, 21.0)],
        );
        let bindings = HashMap::from([(
            "019fa9b6-9907-70f2-877b-5f07907bd2ba".to_string(),
            observed("acct-crispy"),
        )]);
        let (_, accounts) = codex_stats_split(
            temp.path().to_str().unwrap(),
            "2026-07-01T00:00:00",
            SystemTime::UNIX_EPOCH,
            &bindings,
        );
        assert_eq!(accounts.len(), 1);
        assert!(accounts[0].attributed);
        assert!(accounts[0].observed_only);
        assert_eq!(accounts[0].credential_id.as_deref(), Some("acct-crispy"));
        assert_eq!(accounts[0].usage.input, 40);
    }

    /// 같은 계정에 증명된 세션이 하나라도 섞이면 그 묶음은 더 이상 관측 전용이
    /// 아니다 — 한 세션 때문에 전체를 약한 근거로 낙인찍지 않는다.
    #[test]
    fn codex_split_bucket_stops_being_observed_once_one_session_is_proven() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join(".codex/sessions/2026/07/29");
        rollout(
            &sessions,
            "019fa9b6-9907-70f2-877b-5f07907bd2b1",
            &[token_count("2026-07-29T03:00:00.000Z", 10, 2, 5.0)],
        );
        rollout(
            &sessions,
            "019fa9b6-9907-70f2-877b-5f07907bd2b2",
            &[token_count("2026-07-29T03:05:00.000Z", 30, 6, 9.0)],
        );
        let bindings = HashMap::from([
            ("019fa9b6-9907-70f2-877b-5f07907bd2b1".to_string(), observed("acct-crispy")),
            ("019fa9b6-9907-70f2-877b-5f07907bd2b2".to_string(), committed("acct-crispy")),
        ]);
        let (_, accounts) = codex_stats_split(
            temp.path().to_str().unwrap(),
            "2026-07-01T00:00:00",
            SystemTime::UNIX_EPOCH,
            &bindings,
        );
        assert_eq!(accounts.len(), 1, "같은 credential은 한 묶음이다");
        assert!(!accounts[0].observed_only);
        assert_eq!(accounts[0].usage.input, 40);
    }

    /// 저널이 비면 전부 미분류다. 기본 credential 묶음으로 접히면 안 된다.
    #[test]
    fn codex_split_without_journal_reports_everything_unattributed() {
        let temp = tempfile::tempdir().unwrap();
        rollout(
            &temp.path().join(".codex/sessions/2026/07/29"),
            "019fa9ad-38dd-7263-9554-7faf5ca228c1",
            &[token_count("2026-07-29T03:00:00.000Z", 5, 1, 3.0)],
        );
        let (_, accounts) = codex_stats_split(
            temp.path().to_str().unwrap(),
            "2026-07-01T00:00:00",
            SystemTime::UNIX_EPOCH,
            &HashMap::new(),
        );
        assert_eq!(accounts.len(), 1);
        assert!(!accounts[0].attributed);
    }

    #[test]
    fn claude_account_rate_limits_read_per_profile_caches() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(".dure/usage/claude-rate-limits");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("default.json"),
            json!({"captured_at": 1000, "rate_limits": {"five_hour": {"used_percentage": 7.0, "resets_at": 5000}}}).to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("claude-second.json"),
            json!({"captured_at": 1200, "rate_limits": {"five_hour": {"used_percentage": 61.0, "resets_at": 5000}}}).to_string(),
        )
        .unwrap();
        // json이 아닌 잔여물은 무시한다.
        std::fs::write(dir.join("notes.txt"), "x").unwrap();

        let out = claude_account_rate_limits(temp.path().to_str().unwrap(), 2000);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].profile_key, "claude-second");
        assert_eq!(out[0].used_percent, Some(61.0));
        assert_eq!(out[1].profile_key, "default");
        assert_eq!(out[1].used_percent, Some(7.0));
        assert_eq!(out[1].used_percent_captured_at, Some(1000));
    }

    /// 이미 리셋된 창의 스냅샷은 계정별 경로에서도 버려야 한다.
    #[test]
    fn claude_account_rate_limits_drop_expired_windows() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(".dure/usage/claude-rate-limits");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("default.json"),
            json!({"captured_at": 1000, "rate_limits": {"five_hour": {"used_percentage": 7.0, "resets_at": 1500}}}).to_string(),
        )
        .unwrap();
        let out = claude_account_rate_limits(temp.path().to_str().unwrap(), 9000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].used_percent, None);
        assert_eq!(out[0].used_percent_captured_at, None);
    }
}
