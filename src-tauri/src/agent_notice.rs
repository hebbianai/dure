//! Admission for `dure notify`: the one owner of a notice's text rules and of
//! each sender's rate limit. The CLI checks the same rules so a mistake is
//! reported at once; this check is the authoritative one. The limiter lives
//! for the app process, so reloading the WebView does not reset it.
//!
//! A sender is self-declared within the same OS user, as with `dure send`:
//! the WebView names it by the agent's seat key, or `person` for a command run
//! outside an agent.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

/// The longest notice, in Unicode code points.
pub const MAX_NOTICE_CODE_POINTS: usize = 280;
/// Notices a sender may send at once before the refill paces it.
const BURST: u32 = 3;
/// One more notice is allowed this long after the last one was spent.
const REFILL_INTERVAL: Duration = Duration::from_secs(20);
/// No sender exceeds this many notices in any rolling hour.
const HOURLY_LIMIT: usize = 30;
const HOUR: Duration = Duration::from_secs(60 * 60);
const MAX_SENDER_CHARACTERS: usize = 512;

/// Why a notice's text was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeTextRefusal {
    Empty,
    TooLong,
    ControlCharacter,
    FormatCharacter,
}

/// The outcome of asking to send one notice.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum NoticeAdmission {
    /// The notice may be shown; `notice` is its opaque identity.
    Admitted { notice: String },
    /// The sender spent its budget; nothing is shown.
    RateLimited { retry_after_ms: u64 },
    /// The text breaks a rule; nothing is shown and no budget is spent.
    Invalid { reason: NoticeTextRefusal },
}

/// A character that reorders or hides the text around it. The phone's alert
/// filter drops the same set, so what is admitted here reads the same there.
fn invisible_format_character(character: char) -> bool {
    matches!(
        character,
        '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// The text rules: 1 to [`MAX_NOTICE_CODE_POINTS`] code points with something
/// besides whitespace, no control character other than a line feed, and no
/// character that reorders or hides text.
pub fn check_notice_text(text: &str) -> Result<(), NoticeTextRefusal> {
    if text.trim().is_empty() {
        return Err(NoticeTextRefusal::Empty);
    }
    if text.chars().count() > MAX_NOTICE_CODE_POINTS {
        return Err(NoticeTextRefusal::TooLong);
    }
    if text
        .chars()
        .any(|character| character.is_control() && character != '\n')
    {
        return Err(NoticeTextRefusal::ControlCharacter);
    }
    if text.chars().any(invisible_format_character) {
        return Err(NoticeTextRefusal::FormatCharacter);
    }
    Ok(())
}

fn valid_sender(sender: &str) -> bool {
    !sender.trim().is_empty()
        && sender.chars().count() <= MAX_SENDER_CHARACTERS
        && !sender.chars().any(char::is_control)
}

/// One sender's budget: a token bucket for bursts and a rolling hour cap.
struct SenderBudget {
    tokens: u32,
    /// The instant the next token is earned from.
    refill_from: Instant,
    /// When each notice in the last hour was admitted, oldest first.
    admitted: VecDeque<Instant>,
}

impl SenderBudget {
    fn new(now: Instant) -> Self {
        Self {
            tokens: BURST,
            refill_from: now,
            admitted: VecDeque::new(),
        }
    }

    fn settle(&mut self, now: Instant) {
        while self
            .admitted
            .front()
            .is_some_and(|&at| now.saturating_duration_since(at) >= HOUR)
        {
            self.admitted.pop_front();
        }
        if self.tokens >= BURST {
            self.refill_from = now;
            return;
        }
        let elapsed = now.saturating_duration_since(self.refill_from);
        let earned = elapsed.as_millis() / REFILL_INTERVAL.as_millis();
        if earned == 0 {
            return;
        }
        let earned = u32::try_from(earned).unwrap_or(u32::MAX);
        let tokens = self.tokens.saturating_add(earned);
        if tokens >= BURST {
            self.tokens = BURST;
            self.refill_from = now;
        } else {
            self.tokens = tokens;
            self.refill_from += REFILL_INTERVAL * earned;
        }
    }

    /// A budget as full as a new one, so forgetting it changes nothing.
    fn is_fresh(&self) -> bool {
        self.tokens >= BURST && self.admitted.is_empty()
    }

    /// Spends one notice at `now`, or says how long until one is allowed.
    fn spend(&mut self, now: Instant) -> Result<(), Duration> {
        self.settle(now);
        let token_wait = if self.tokens > 0 {
            Duration::ZERO
        } else {
            (self.refill_from + REFILL_INTERVAL).saturating_duration_since(now)
        };
        let hour_wait = match self.admitted.front() {
            Some(&oldest) if self.admitted.len() >= HOURLY_LIMIT => {
                (oldest + HOUR).saturating_duration_since(now)
            }
            _ => Duration::ZERO,
        };
        let wait = token_wait.max(hour_wait);
        if !wait.is_zero() {
            return Err(wait);
        }
        self.tokens -= 1;
        self.admitted.push_back(now);
        Ok(())
    }
}

/// Every sender's budget for the app process.
#[derive(Default)]
pub struct AgentNoticeLimiter {
    senders: Mutex<HashMap<String, SenderBudget>>,
}

impl AgentNoticeLimiter {
    /// Admits one notice from `sender` at `now`. Invalid text spends nothing.
    pub fn admit(&self, sender: &str, text: &str, now: Instant) -> Result<NoticeAdmission, String> {
        if !valid_sender(sender) {
            return Err("The notice sender is invalid".into());
        }
        if let Err(reason) = check_notice_text(text) {
            return Ok(NoticeAdmission::Invalid { reason });
        }
        let mut senders = self
            .senders
            .lock()
            .map_err(|_| "The notice limiter is unavailable".to_string())?;
        // Budgets that have fully recovered are the same as new ones; dropping
        // them keeps the table to the senders active in the last hour.
        senders.retain(|_, budget| {
            budget.settle(now);
            !budget.is_fresh()
        });
        let budget = senders
            .entry(sender.to_string())
            .or_insert_with(|| SenderBudget::new(now));
        if let Err(wait) = budget.spend(now) {
            let retry_after_ms = u64::try_from(wait.as_millis().max(1)).unwrap_or(u64::MAX);
            return Ok(NoticeAdmission::RateLimited { retry_after_ms });
        }
        let notice = crate::random_token::gen_token().map_err(|error| error.to_string())?;
        Ok(NoticeAdmission::Admitted {
            notice: format!("n.{notice}"),
        })
    }
}

#[tauri::command]
pub fn agent_notice_admit(
    limiter: tauri::State<'_, AgentNoticeLimiter>,
    sender: String,
    text: String,
) -> Result<NoticeAdmission, String> {
    limiter.admit(&sender, &text, Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admitted(outcome: &NoticeAdmission) -> bool {
        matches!(outcome, NoticeAdmission::Admitted { .. })
    }

    fn retry_after(outcome: &NoticeAdmission) -> Option<u64> {
        match outcome {
            NoticeAdmission::RateLimited { retry_after_ms } => Some(*retry_after_ms),
            _ => None,
        }
    }

    #[test]
    fn text_rules_match_the_cli() {
        assert_eq!(check_notice_text("Build is green"), Ok(()));
        assert_eq!(check_notice_text("line one\nline two"), Ok(()));
        assert_eq!(check_notice_text(&"한".repeat(280)), Ok(()));
        assert_eq!(check_notice_text(""), Err(NoticeTextRefusal::Empty));
        assert_eq!(check_notice_text(" \n "), Err(NoticeTextRefusal::Empty));
        assert_eq!(
            check_notice_text(&"한".repeat(281)),
            Err(NoticeTextRefusal::TooLong)
        );
        for control in ["\t", "\r", "\u{1b}[31m", "\u{7f}", "\u{85}"] {
            assert_eq!(
                check_notice_text(&format!("a{control}b")),
                Err(NoticeTextRefusal::ControlCharacter),
                "{control:?}"
            );
        }
        for format in [
            '\u{200B}', '\u{200F}', '\u{202A}', '\u{202E}', '\u{2060}', '\u{2066}', '\u{2069}',
            '\u{FEFF}',
        ] {
            assert_eq!(
                check_notice_text(&format!("rm -rf{format}gpj.exe")),
                Err(NoticeTextRefusal::FormatCharacter),
                "{format:?}"
            );
        }
    }

    #[test]
    fn a_burst_of_three_then_one_every_twenty_seconds() {
        let limiter = AgentNoticeLimiter::default();
        let start = Instant::now();
        for _ in 0..3 {
            assert!(admitted(&limiter.admit("seat-a", "hi", start).unwrap()));
        }
        let fourth = limiter.admit("seat-a", "hi", start).unwrap();
        assert_eq!(retry_after(&fourth), Some(20_000));
        // Another sender has its own budget.
        assert!(admitted(&limiter.admit("person", "hi", start).unwrap()));
        let later = start + Duration::from_secs(19);
        assert_eq!(
            retry_after(&limiter.admit("seat-a", "hi", later).unwrap()),
            Some(1_000)
        );
        let refilled = start + Duration::from_secs(20);
        assert!(admitted(&limiter.admit("seat-a", "hi", refilled).unwrap()));
        assert_eq!(
            retry_after(&limiter.admit("seat-a", "hi", refilled).unwrap()),
            Some(20_000)
        );
    }

    #[test]
    fn invalid_text_spends_no_budget() {
        let limiter = AgentNoticeLimiter::default();
        let now = Instant::now();
        for _ in 0..5 {
            assert_eq!(
                limiter.admit("seat-a", "", now).unwrap(),
                NoticeAdmission::Invalid {
                    reason: NoticeTextRefusal::Empty
                }
            );
        }
        for _ in 0..3 {
            assert!(admitted(&limiter.admit("seat-a", "hi", now).unwrap()));
        }
        assert!(limiter.admit("", "hi", now).is_err());
        assert!(limiter.admit("seat\u{1b}", "hi", now).is_err());
    }

    #[test]
    fn no_sender_exceeds_thirty_an_hour() {
        let limiter = AgentNoticeLimiter::default();
        let start = Instant::now();
        // One attempt each time a token is earned: only the hour cap refuses.
        let sent = (0..40u32)
            .filter(|step| {
                let at = start + REFILL_INTERVAL * *step;
                admitted(&limiter.admit("seat-a", "hi", at).unwrap())
            })
            .count();
        assert_eq!(sent, HOURLY_LIMIT);
        let capped = limiter.admit("seat-a", "hi", start + Duration::from_secs(800));
        assert_eq!(retry_after(&capped.unwrap()), Some((3_600 - 800) * 1_000));
        // The first notice leaves the window an hour after it was sent.
        assert!(admitted(
            &limiter.admit("seat-a", "hi", start + HOUR).unwrap()
        ));
    }

    #[test]
    fn a_notice_identity_is_opaque_and_unique() {
        let limiter = AgentNoticeLimiter::default();
        let now = Instant::now();
        let ids: Vec<String> = (0..3)
            .map(|_| match limiter.admit("seat-a", "hi", now).unwrap() {
                NoticeAdmission::Admitted { notice } => notice,
                other => panic!("{other:?}"),
            })
            .collect();
        for id in &ids {
            assert!(id.starts_with("n."));
            assert_eq!(id.len(), 34);
            assert!(id[2..].chars().all(|c| c.is_ascii_hexdigit()));
        }
        assert_ne!(ids[0], ids[1]);
    }

    #[test]
    fn admission_serializes_as_the_webview_reads_it() {
        assert_eq!(
            serde_json::to_value(NoticeAdmission::RateLimited {
                retry_after_ms: 20_000
            })
            .unwrap(),
            serde_json::json!({ "outcome": "rate_limited", "retryAfterMs": 20_000 })
        );
        assert_eq!(
            serde_json::to_value(NoticeAdmission::Invalid {
                reason: NoticeTextRefusal::FormatCharacter
            })
            .unwrap(),
            serde_json::json!({ "outcome": "invalid", "reason": "format_character" })
        );
        assert_eq!(
            serde_json::to_value(NoticeAdmission::Admitted {
                notice: "n.0".into()
            })
            .unwrap(),
            serde_json::json!({ "outcome": "admitted", "notice": "n.0" })
        );
    }
}
